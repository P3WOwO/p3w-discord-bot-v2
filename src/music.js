'use strict';

/**
 * Музыкальный модуль P3W.
 *
 * Всё, что относится к музыке, живёт здесь: источники (YouTube / Audius /
 * Spotify / Яндекс Музыка), очередь, слэш-команды, панель управления с кнопками
 * и обработка голосового канала. bot.js только подключает модуль.
 *
 * Как устроен YouTube:
 *   DisTube по умолчанию отдаёт ffmpeg «голую» ссылку googlevideo. Новый YouTube
 *   такие ссылки часто режет (403, SABR, PO-токены), поэтому звук берётся через
 *   ytdl.download() — основной загрузчик: он ходит с нужными заголовками, кусками,
 *   перезапрашивает ссылку при 403 и умеет SABR. Если YouTube обновил player и
 *   ytdl-core не может его разобрать, поток повторно извлекается через yt-dlp.
 *   Оба потока отдаются ffmpeg через локальный мост (127.0.0.1), а если оба
 *   загрузчика не справились — включается поиск на SoundCloud/Audius.
 */

const http = require('http');
const https = require('node:https');
const { pipeline } = require('node:stream/promises');
const { randomBytes } = require('crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const {
  createAudioResource,
  entersState,
  StreamType,
  VoiceConnectionStatus,
  AudioPlayerStatus,
} = require('@discordjs/voice');
const { OpusEncoder } = require('@discordjs/opus');
const { DisTube, RepeatMode, ExtractorPlugin, Song, Playlist } = require('distube');
const SoundCloudReadable = require('@zibot/scdl');
const { YouTubePlugin, YouTubeSong } = require('@distube/youtube');
const { Quality, parseVideoId, parsePlaylistId } = require('@distube/ytdl-core');
const { SpotifyPlugin } = require('@distube/spotify');
const { YandexMusicPlugin } = require('distube-yandex-music-plugin');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  Events,
  ChannelType,
} = require('discord.js');
const { clampText } = require('./utils');

// ───────────────────────────── константы ─────────────────────────────

const EPHEMERAL = MessageFlags.Ephemeral;
const PREFIX = 'music';
const COLORS = { playing: 0x5865f2, paused: 0xfaa61a, idle: 0x4f545c, ok: 0x57f287, error: 0xed4245 };

const STREAM_PRIME_TIMEOUT_MS = 25_000; // сколько ждём первые байты от YouTube
const BRIDGE_TTL_MS = 90_000;           // сколько живёт подготовленный поток без ffmpeg
const EMPTY_CHANNEL_LEAVE_MS = 2 * 60_000;
const IDLE_LEAVE_MS = 3 * 60_000;
const QUEUE_PAGE_SIZE = 10;
const VOLUME_STEP = 10;
const VOLUME_MAX = 200;
const PLAYBACK_CHECK_MS = 4000;
const SELF_TEST_VIDEO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const AUDIUS_API_BASE = (process.env.AUDIUS_API_BASE || 'https://discoveryprovider.audius.co/v1').replace(/\/+$/, '');
const MUSIC_DIAG_AUDIUS_QUERY = 'lofi instrumental';
const MUSIC_DIAG_SOUNDCLOUD_URL = 'https://soundcloud.com/overtonightofficial/mirrors-demo';
const MUSIC_DIAG_SPOTIFY_URL = 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT';

function safeStreamUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

function executableNameForPlatform() {
  return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
}

function getYtDlpVersion(binaryPath) {
  const result = spawnSync(binaryPath, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return '';
  return String(result.stdout || '').trim();
}

async function downloadHttpsFile(url, destination, redirects = 0) {
  if (redirects > 8) throw new Error('Too many redirects downloading yt-dlp');
  await new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { 'User-Agent': 'P3W-yt-dlp-runtime/1.0' },
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        downloadHttpsFile(new URL(response.headers.location, url).toString(), destination, redirects + 1)
          .then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`yt-dlp download returned HTTP ${response.statusCode}`));
        return;
      }
      pipeline(response, fs.createWriteStream(destination)).then(resolve, reject);
    });
    request.setTimeout(180_000, () => request.destroy(new Error('yt-dlp download timed out')));
    request.on('error', reject);
  });
}

// yt-dlp expects a Netscape cookie jar, while YT_COOKIE is normally a Cookie header.
// A user can also supply a complete cookies.txt export in YT_COOKIE.
function toNetscapeCookieFile(rawCookie) {
  const value = String(rawCookie || '').trim();
  if (!value) return '';
  if (/^#.*cookie file/im.test(value)) return value.endsWith('\n') ? value : value + '\n';

  const header = value.replace(/^cookie:\s*/i, '').trim();
  const rows = header.split(/;\s*/).map(pair => {
    const separator = pair.indexOf('=');
    if (separator <= 0) return null;
    const name = pair.slice(0, separator).trim();
    const cookieValue = pair.slice(separator + 1).trim();
    if (!name || /[\t\r\n]/.test(name + cookieValue)) return null;
    return `.youtube.com\tTRUE\t/\tTRUE\t0\t${name}\t${cookieValue}`;
  }).filter(Boolean);

  if (!rows.length) {
    throw new Error('YT_COOKIE is not a Cookie header or Netscape cookies.txt export');
  }
  return '# Netscape HTTP Cookie File\n' + rows.join('\n') + '\n';
}

async function probeAudioUrl(url, timeoutMs = 12000) {
  const response = await fetch(url, {
    headers: { Range: 'bytes=0-4095' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok || !response.body) {
    throw new Error('Audio input HTTP ' + response.status + ' · ' + (response.headers.get('content-type') || 'no body'));
  }
  const reader = response.body.getReader();
  let first;
  try {
    first = await reader.read();
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!first?.value?.byteLength) throw new Error('Audio input returned an empty body');
  return {
    status: response.status,
    bytes: first.value.byteLength,
    contentType: response.headers.get('content-type') || 'unknown',
    finalUrl: safeStreamUrl(response.url),
  };
}

const MUSIC_COMMANDS = new Set([
  'play', 'skip', 'pause', 'resume', 'stop', 'queue', 'nowplaying',
  'volume', 'leave', 'player', 'loop', 'shuffle', 'musictest',
]);

// Предпочитаем webm/opus (ffmpeg читает его из потока без перемотки), затем любой аудио-формат,
// затем всё, где есть звук (прямые трансляции).
const AUDIO_FILTERS = [
  { hasAudio: true, hasVideo: false, container: 'webm' },
  { hasAudio: true, hasVideo: false },
  { hasAudio: true },
];

const SOURCE_LABELS = {
  youtube: 'YouTube',
  soundcloud: 'SoundCloud',
  audius: 'Audius',
  spotify: 'Spotify',
  yandex: 'Яндекс Музыка',
  'yandex-music': 'Яндекс Музыка',
};

const REPEAT_LABELS = {
  [RepeatMode.DISABLED]: 'выкл',
  [RepeatMode.SONG]: 'трек',
  [RepeatMode.QUEUE]: 'очередь',
};

// ───────────────────────────── утилиты ─────────────────────────────

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function formatDur(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function progressBar(current, total, size = 14) {
  if (!total || total <= 0) return '';
  const ratio = clamp(current / total, 0, 1);
  const pos = Math.min(size - 1, Math.round(ratio * (size - 1)));
  return `${'▬'.repeat(pos)}🔘${'▬'.repeat(size - 1 - pos)}`;
}

function mdText(text, max = 90) {
  return clampText(String(text || 'Без названия'), max)
    .replace(/[[\]]/g, '')
    .replace(/[*_`~|>\\]/g, match => `\\${match}`);
}

function songLine(song, max = 90) {
  const title = mdText(song?.name || song?.url, max);
  return song?.url && /^https?:\/\//i.test(song.url) ? `[${title}](${song.url})` : title;
}

function sourceLabel(source) {
  const key = String(source || '').toLowerCase();
  return SOURCE_LABELS[key] || (key ? key[0].toUpperCase() + key.slice(1) : 'Неизвестно');
}

// Заметки про трек (например, «звук взят с Audius»), не засоряя объект Song.
const songNotes = new WeakMap();
const setNote = (song, note) => { if (song && typeof song === 'object') songNotes.set(song, note); };
const getNote = song => (song && typeof song === 'object' ? songNotes.get(song) : undefined);

function describeMusicError(err, depth = 0) {
  if (!err || depth > 5) return undefined;
  const result = {
    name: err.name,
    code: err.code,
    message: String(err.message || err),
  };
  if (err.cause && depth < 5) result.cause = describeMusicError(err.cause, depth + 1);
  if (err.originalError && depth < 5) result.originalError = describeMusicError(err.originalError, depth + 1);
  if (Array.isArray(err.errors) && depth < 5) {
    result.errors = err.errors.slice(0, 8).map(item => describeMusicError(item, depth + 1));
  }
  if (Array.isArray(err.attempts)) {
    result.attempts = err.attempts.slice(0, 12).map(item => ({
      client: item.client,
      step: item.step,
      code: item.code,
      reason: item.reason,
      signedIn: item.signedIn,
      cause: item.cause ? String(item.cause).slice(0, 800) : undefined,
    }));
  }
  if (depth === 0 && err.stack) result.stack = String(err.stack).slice(0, 5000);
  return result;
}

// Короткое описание ошибки для диагностики: код, сообщение и что ответил каждый клиент YouTube.
function briefError(err) {
  const parts = [];
  if (err?.code) parts.push(String(err.code));
  parts.push(String(err?.message || err));
  if (Array.isArray(err?.attempts) && err.attempts.length) {
    parts.push(`[${err.attempts.slice(0, 6).map(a => `${a.client}/${a.step}/${a.code}`).join(', ')}]`);
  }
  return parts.join(' · ');
}

function formatMusicError(err) {
  const raw = String(err?.message || err || 'unknown_error');
  const code = String(err?.code || raw);
  const cause = String(err?.cause?.message || err?.originalError?.message || '');
  const all = `${code} ${raw} ${cause}`;

  if (code === 'VOICE_SERVER_MUTED') {
    return '🔇 P3W заглушён модератором на уровне сервера. Нажмите правой кнопкой по P3W в списке участников войса и снимите «Отключить микрофон» (Server Mute), затем повторите /play.';
  }
  if (code === 'VOICE_SELF_UNDEAF_FAILED') {
    return '🎧 Не удалось отключить режим deafened у P3W. Попробуй /leave, затем /play ещё раз; подробности есть в логах.';
  }
  if (code === 'VOICE_SELF_UNMUTE_FAILED') {
    return '🔇 Не удалось снять самозаглушение P3W. Попробуй /leave, затем /play ещё раз; подробности есть в логах.';
  }
  if (/VOICE_ALREADY_CREATED|VOICE_CHANNEL_DIFFERENT|QUEUE_EXIST/i.test(code)) {
    return '❌ P3W уже подключён к другому голосовому каналу. Сначала используй /leave.';
  }
  if (/YOUTUBE_EXTRACTORS_FAILED/.test(code)) {
    return '❌ YouTube не удалось извлечь ни основным загрузчиком, ни резервным yt-dlp. Подробная причина записана в Render Logs.';
  }
  if (/BOT_CHECK|AUTH_FAILED|SIGN_IN|LOGIN_REQUIRED|not a bot/i.test(all)) {
    return '❌ YouTube ограничил запросы, а SoundCloud/Audius не нашли подходящую версию. Можно подключить YT_COOKIE в секретах Render.';
  }
  if (/SOUNDCLOUD_NO_PLAYABLE_STREAM|cbc-encrypted-hls|ctr-encrypted-hls/i.test(all)) {
    return '❌ SoundCloud отдаёт только защищённый поток, а альтернативная версия не найдена. Для этой записи источник не предоставляет обычное аудио.';
  }
  if (/AGE_RESTRICTED|PRIVATE|MEMBERS_ONLY|PREMIUM_ONLY|REGION_BLOCKED|UNAVAILABLE_VIDEO|NOT_STARTED/i.test(all)) {
    return '❌ Этот трек недоступен: он приватный, с возрастным ограничением, ограничен по региону или ещё не вышел.';
  }
  if (/RATE_LIMITED|429/i.test(all)) {
    return '❌ Источник временно ограничил запросы. Попробуй немного позже.';
  }
  if (/YT_STREAM_TIMEOUT|YT_STREAM_EMPTY|NO_FORMAT|UNPLAYABLE_FORMATS|PLAYER_SOLVE_FAILED|REQUEST_FAILED/i.test(all)) {
    return '❌ YouTube не отдал аудиопоток, а на Audius такого же трека не нашлось. Попробуй другую ссылку или название, либо подключи YT_COOKIE.';
  }
  if (/NO_RESULT|NOT_FOUND|NO_STREAM_URL|CANNOT_RESOLVE/i.test(code)) {
    return '❌ Не удалось найти трек. Проверь ссылку или попробуй другое название.';
  }
  if (/NOT_SUPPORTED_URL/i.test(code)) {
    return '❌ Эта ссылка не поддерживается. Работают YouTube, SoundCloud, Audius, Spotify и Яндекс Музыка.';
  }
  const detail = cause && cause !== raw ? ` · ${cause}` : '';
  return `❌ Не удалось запустить музыку: ${clampText(raw + detail, 350)}`;
}

// Название ролика через oEmbed: обычный HTTP-запрос, который YouTube почти не блокирует.
async function fetchOEmbedTitle(url) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.title === 'string' && data.title.trim() ? data.title.trim() : null;
  } catch {
    return null;
  }
}

async function fetchSoundCloudOEmbed(url) {
  try {
    const endpoint = new URL('https://soundcloud.com/oembed');
    endpoint.searchParams.set('format', 'json');
    endpoint.searchParams.set('url', url);
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data?.title) return null;
    return {
      title: String(data.title),
      artist: String(data.author_name || ''),
    };
  } catch {
    return null;
  }
}

// Чистим «(Official Video)», «[HD]» и т.п., чтобы поиск на Audius находил больше.
function cleanTitle(name) {
  return String(name || '')
    .replace(/[([{](?:official|lyrics?|lyric video|audio|video|music video|hd|hq|4k|remaster(?:ed)?|clip|клип|премьера|live)[^)\]}]*[)\]}]/gi, ' ')
    .replace(/\b(?:official (?:music )?video|official audio|lyric video|lyrics)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildFallbackQuery(song) {
  const title = cleanTitle(song?.name);
  if (!title) return '';
  const uploader = String(song?.uploader?.name || '').replace(/\s*-\s*topic$/i, '').replace(/vevo$/i, '').trim();
  // Если исполнитель уже есть в названии («Artist - Track»), не дублируем.
  if (!uploader || title.toLowerCase().includes(uploader.toLowerCase())) return title;
  return `${title} ${uploader}`;
}

// Выбираем кандидата с длительностью, близкой к оригиналу, чтобы не подсунуть другую версию.
function pickBestMatch(candidates, targetDuration) {
  if (!Array.isArray(candidates) || !targetDuration || targetDuration <= 0) return null;
  const tolerance = Math.max(8, Math.round(targetDuration * 0.06));
  return candidates
    .filter(candidate => candidate?.url && candidate.duration > 0)
    .map(candidate => ({ candidate, diff: Math.abs(candidate.duration - targetDuration) }))
    .filter(item => item.diff <= tolerance)
    .sort((a, b) => a.diff - b.diff)[0]?.candidate || null;
}

// Ждём первый кусок данных от потока: если YouTube не отдаёт байты — узнаем об этом ДО запуска ffmpeg.
function primeStream(stream, timeoutMs = STREAM_PRIME_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      finish(Object.assign(new Error('YouTube did not start sending audio in time'), { code: 'YT_STREAM_TIMEOUT' }));
    }, timeoutMs);

    const onData = chunk => {
      stream.pause();
      stream.unshift(chunk);
      finish(null, chunk.length);
    };
    const onError = err => finish(err);
    const onEnd = () => finish(Object.assign(new Error('YouTube stream ended without data'), { code: 'YT_STREAM_EMPTY' }));

    function finish(err, bytes) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('error', onError);
      stream.off('end', onEnd);
      stream.off('close', onEnd);
      if (err) {
        if (!stream.destroyed) stream.destroy();
        reject(err);
      } else {
        resolve(bytes);
      }
    }

    stream.on('data', onData);
    stream.once('error', onError);
    stream.once('end', onEnd);
    stream.once('close', onEnd);
  });
}

// Проверяем, что Audius действительно отдаёт байты медиа, а не только результат поиска.
// ───────────────────────────── локальный мост для YouTube ─────────────────────────────

class StreamBridge {
  constructor() {
    this.server = null;
    this.port = 0;
    this.starting = null;
    this.pending = new Map();
  }

  start() {
    if (this.port) return Promise.resolve();
    if (!this.starting) {
      this.starting = new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => this.#handle(req, res));
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject);
          server.on('error', err => console.error('Music bridge error:', err));
          this.server = server;
          this.port = server.address().port;
          resolve();
        });
      }).catch(err => {
        this.starting = null;
        throw err;
      });
    }
    return this.starting;
  }

  register(stream, label) {
    if (!this.server?.listening || !Number.isInteger(this.port) || this.port < 1) {
      throw new Error('Music stream bridge is not listening; await bridge.start() before register()');
    }
    const token = randomBytes(16).toString('hex');
    // Ошибка до подключения ffmpeg не должна ронять процесс.
    stream.on('error', err => {
      console.warn(`Music bridge stream error (${label || 'track'}):`, err?.code || '', err?.message || err);
    });
    const timer = setTimeout(() => {
      this.pending.delete(token);
      if (!stream.destroyed) stream.destroy();
    }, BRIDGE_TTL_MS);
    timer.unref?.();
    this.pending.set(token, { stream, timer });
    return `http://127.0.0.1:${this.port}/yt/${token}`;
  }

  #handle(req, res) {
    const match = /^\/yt\/([a-f0-9]{32})(?:\?.*)?$/.exec(req.url || '');
    const token = match?.[1];
    const entry = token ? this.pending.get(token) : null;
    if (!entry) {
      res.writeHead(404);
      res.end();
      return;
    }

    const headers = { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' };
    if (req.method === 'HEAD') {
      res.writeHead(200, headers);
      res.end();
      return;
    }

    // Поток одноразовый: ffmpeg забирает его целиком.
    this.pending.delete(token);
    clearTimeout(entry.timer);
    const { stream } = entry;
    res.writeHead(200, headers);
    res.once('close', () => { if (!stream.destroyed) stream.destroy(); });
    stream.once('error', () => res.destroy());
    stream.pipe(res);
  }

  close() {
    for (const { stream, timer } of this.pending.values()) {
      clearTimeout(timer);
      if (!stream.destroyed) stream.destroy();
    }
    this.pending.clear();
    if (this.server) this.server.close();
    this.server = null;
    this.port = 0;
    this.starting = null;
  }
}

// ───────────────────────────── Audius AAC-HLS → Readable bridge ─────────────────────────────

// @distube/audius resolves and searches tracks, while this maintained stream client
// assembles Audius's AAC HLS init segment + media fragments into one readable stream.
class P3WAudiusPlugin extends ExtractorPlugin {
  constructor(options = {}) {
    super();
    this.base = (options.base || AUDIUS_API_BASE).replace(/\/+$/, '');
    this.apiKey = options.apiKey || process.env.AUDIUS_API_KEY || '';
  }

  async #request(path, params = {}, signal) {
    const url = new URL(this.base + path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    if (this.apiKey) url.searchParams.set('api_key', this.apiKey);
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      redirect: 'follow',
      signal: signal || AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      throw Object.assign(new Error('Audius API HTTP ' + response.status + ' for ' + path), {
        code: response.status === 429 ? 'AUDIUS_RATE_LIMITED' : 'AUDIUS_API_ERROR',
        status: response.status,
      });
    }
    const payload = await response.json();
    if (payload?.error) throw new Error('Audius API: ' + payload.error);
    return payload?.data;
  }

  #isAllowedTrack(track) {
    if (!track || !track.id) return false;
    const streamable = track.is_streamable ?? track.isStreamable;
    if (!['true', '1'].includes(String(streamable).toLowerCase())) return false;
    const gated = track.is_stream_gated ?? track.isStreamGated;
    if (gated === true || String(gated).toLowerCase() === 'true') return false;

    // Audius OML is the default. Explicit alternatives must be a recognized OML or CC license.
    const license = String(track.license || '').trim().toLowerCase();
    if (license && !(
      /open music license|\boml\b/.test(license)
      || /creativecommons\.org\/licenses\/(by|by-sa|by-nc|by-nc-sa|by-nd|by-nc-nd)\//.test(license)
      || /^cc[- ]by(?:[- ](?:sa|nc|nd))?(?:\s|$)/.test(license)
    )) return false;
    return true;
  }

  #toSong(track, options = {}) {
    const user = track.user || {};
    const handle = String(user.handle || user.username || '').replace(/^@/, '');
    let permalink = String(track.permalink || '');
    if (permalink && !/^https?:\/\//i.test(permalink)) {
      permalink = 'https://audius.co/' + permalink.replace(/^\/+/, '');
    }
    if (!permalink) permalink = 'https://audius.co/track/' + encodeURIComponent(track.id);
    const artwork = track.artwork || {};
    return new Song({
      plugin: this,
      source: 'audius',
      playFromSource: true,
      id: String(track.id),
      name: track.title || track.name || 'Untitled Audius track',
      duration: Number(track.duration) || 0,
      url: permalink,
      thumbnail: artwork._480x480 || artwork['480x480'] || artwork._150x150 || artwork['150x150'],
      views: Number(track.play_count ?? track.playCount) || 0,
      uploader: {
        name: user.name || user.handle || user.username || 'Audius creator',
        url: handle ? 'https://audius.co/' + handle : undefined,
      },
    }, options);
  }

  async validate(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol.startsWith('http')
        && (parsed.hostname === 'audius.co' || parsed.hostname === 'www.audius.co');
    } catch {
      return false;
    }
  }

  async resolve(url, options = {}) {
    const result = await this.#request('/resolve', { url });
    let track = result?.type === 'track' && result?.data ? result.data : result;
    if (Array.isArray(track)) track = track[0];
    if (track?.track) track = track.track;
    if (!this.#isAllowedTrack(track)) {
      throw Object.assign(new Error('Audius link is not a public, ungated, streamable track under an accepted license'), {
        code: 'AUDIUS_TRACK_UNAVAILABLE',
      });
    }
    return this.#toSong(track, options);
  }

  async searchSong(query, options = {}, targetDuration = 0) {
    const results = await this.#request('/tracks/search', {
      query,
      limit: 20,
      sort_method: 'relevant',
    });
    const tracks = (Array.isArray(results) ? results : []).filter(item => this.#isAllowedTrack(item));
    if (!tracks.length) return null;
    let track = tracks[0];
    if (targetDuration > 0) {
      const ranked = tracks
        .map(item => ({ item, duration: Number(item.duration) || 0 }))
        .filter(item => item.duration > 0)
        .map(item => ({ ...item, diff: Math.abs(item.duration - targetDuration) }))
        .sort((a, b) => a.diff - b.diff);
      const best = ranked[0];
      const tolerance = Math.max(12, Math.round(targetDuration * 0.08));
      if (!best || best.diff > tolerance) return null;
      track = best.item;
    }
    return this.#toSong(track, options);
  }

  async getStreamURL(song) {
    if (!song?.id) throw new Error('Audius song is missing its track ID');
    const url = new URL(this.base + '/tracks/' + encodeURIComponent(song.id) + '/stream');
    url.searchParams.set('app_name', 'P3WDiscordBot');
    if (this.apiKey) url.searchParams.set('api_key', this.apiKey);
    return url.toString();
  }

  async getRelatedSongs() {
    return [];
  }
}

// ───────────────────────────── SoundCloud AAC-HLS + safe source fallback ─────────────────────────────

class P3WSoundCloudPlugin extends ExtractorPlugin {
  constructor(bridge) {
    super();
    this.bridge = bridge;
    this.streamClient = new SoundCloudReadable();
    this.youtube = null;
    this.audius = null;
  }

  #toSong(track, options = {}) {
    return new Song({
      plugin: this,
      source: 'soundcloud',
      playFromSource: true,
      id: String(track.id),
      name: track.title || 'SoundCloud track',
      url: track.permalink_url || track.permalink,
      thumbnail: track.artwork_url || track.artwork?.url || undefined,
      duration: Math.round((Number(track.duration) || 0) / 1000),
      views: Number(track.playback_count) || 0,
      uploader: {
        name: track.user?.username || track.user?.name || 'SoundCloud',
        url: track.user?.permalink_url || undefined,
      },
    }, options);
  }

  async validate(url) {
    try {
      const parsed = new URL(url);
      return ['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com', 'on.soundcloud.com', 'snd.sc'].includes(parsed.hostname);
    } catch {
      return false;
    }
  }

  async resolve(url, options = {}) {
    try {
      await this.streamClient.ensureReady();
      const item = await this.streamClient.fetchItem(url);
      if (item?.kind === 'track') return this.#toSong(item, options);
      if (item?.kind === 'playlist') {
        const playlist = await this.streamClient.getPlaylistDetails(url);
        const songs = (playlist.tracks || [])
          .filter(track => track?.id && track?.permalink_url && track?.title)
          .map(track => this.#toSong(track, options));
        if (!songs.length) {
          throw Object.assign(new Error('SoundCloud playlist is empty or unavailable'), { code: 'SOUNDCLOUD_EMPTY_PLAYLIST' });
        }
        return new Playlist({
          source: 'soundcloud',
          songs,
          id: String(playlist.id),
          name: playlist.title || 'SoundCloud playlist',
          url: playlist.permalink_url || url,
          thumbnail: playlist.artwork_url || undefined,
        }, options);
      }
      throw Object.assign(new Error('SoundCloud URL is not a public track or playlist'), { code: 'SOUNDCLOUD_NOT_SUPPORTED' });
    } catch (error) {
      const metadata = await fetchSoundCloudOEmbed(url);
      const query = metadata ? [metadata.title, metadata.artist].filter(Boolean).join(' ') : '';
      if (query && this.youtube) {
        const alternate = await this.youtube.searchSong(query, options).catch(() => null);
        if (alternate) {
          setNote(alternate, 'SoundCloud не разрешил ссылку: найдено совпадение из доступного источника');
          console.warn('[soundcloud-resolve-fallback] ' + query + ' → ' + sourceLabel(alternate.source));
          return alternate;
        }
      }
      if (query && this.audius) {
        const alternate = await this.audius.searchSong(query, options).catch(() => null);
        if (alternate) {
          setNote(alternate, 'SoundCloud не разрешил ссылку: найдена версия на Audius');
          return alternate;
        }
      }
      throw error;
    }
  }

  async searchSong(query, options = {}, targetDuration = 0) {
    await this.streamClient.ensureReady();
    const results = await this.streamClient.search({ query, limit: 20, type: 'tracks' });
    const candidates = (Array.isArray(results) ? results : [])
      .filter(track => track?.id && track?.permalink_url && track?.title);
    if (!candidates.length) return null;

    let selected = candidates[0];
    if (targetDuration > 0) {
      const ranked = candidates
        .map(track => ({ track, duration: (Number(track.duration) || 0) / 1000 }))
        .filter(item => item.duration > 0)
        .map(item => ({ ...item, diff: Math.abs(item.duration - targetDuration) }))
        .sort((a, b) => a.diff - b.diff);
      const best = ranked[0];
      const tolerance = Math.max(12, Math.round(targetDuration * 0.08));
      if (!best || best.diff > tolerance) return null;
      selected = best.track;
    }
    return this.#toSong(selected, options);
  }

  async #resolveHlsMediaPlaylist(streamUrl) {
    let mediaUrl = streamUrl;
    for (let depth = 0; depth < 3; depth++) {
      const response = await this.streamClient.http.get(mediaUrl, {
        responseType: 'text',
        headers: {
          Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*',
          Referer: 'https://soundcloud.com/',
        },
      });
      const playlist = String(response.data || '');
      if (!playlist.includes('#EXTM3U')) throw new Error('SoundCloud HLS endpoint did not return an M3U8 playlist');

      const encryption = playlist.split(/\r?\n/).find(line =>
        line.startsWith('#EXT-X-KEY:') && !/METHOD=NONE/i.test(line),
      );
      if (encryption) throw new Error('SoundCloud HLS manifest is encrypted; no supported clear-audio transcoding was offered');

      if (!playlist.includes('#EXT-X-STREAM-INF')) return mediaUrl;
      const lines = playlist.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const index = lines.findIndex(line => line.startsWith('#EXT-X-STREAM-INF'));
      const variant = index >= 0 ? lines.slice(index + 1).find(line => line && !line.startsWith('#')) : null;
      if (!variant) throw new Error('SoundCloud HLS master playlist has no media variant');
      mediaUrl = new URL(variant, response.request?.res?.responseUrl || mediaUrl).toString();
      if (depth === 2) throw new Error('SoundCloud HLS playlist nesting exceeds 3');
    }
    throw new Error('SoundCloud HLS playlist nesting exceeds 3');
  }

  async #fallbackStream(song, reasons) {
    const query = buildFallbackQuery(song);
    if (!query) throw new Error('SoundCloud stream unavailable and no fallback search query could be built');

    if (this.youtube) {
      try {
        const candidate = await this.youtube.searchYouTubeOnly(query, { member: song.member }, song.duration);
        if (candidate) {
          const url = await this.youtube.getDirectStreamURL(candidate);
          if (url) {
            setNote(song, 'SoundCloud не отдал воспроизводимый поток: включена найденная версия с YouTube');
            console.warn('[soundcloud-fallback] ' + song.name + ' → YouTube: ' + candidate.name);
            return url;
          }
        }
      } catch (error) {
        reasons.push('YouTube mirror: ' + briefError(error));
      }
    }

    if (this.audius) {
      try {
        const candidate = await this.audius.searchSong(query, { member: song.member }, song.duration);
        if (candidate) {
          const url = await this.audius.getStreamURL(candidate);
          if (url) {
            setNote(song, 'SoundCloud не отдал воспроизводимый поток: включена найденная версия с Audius');
            console.warn('[soundcloud-fallback] ' + song.name + ' → Audius: ' + candidate.name);
            return url;
          }
        }
      } catch (error) {
        reasons.push('Audius mirror: ' + briefError(error));
      }
    }

    throw Object.assign(new Error(
      'SoundCloud не предложил доступный аудиопоток. ' + reasons.slice(0, 5).join(' | '),
    ), { code: 'SOUNDCLOUD_NO_PLAYABLE_STREAM' });
  }

  async getStreamURL(song) {
    const trackUrl = typeof song === 'string' ? song : song?.url;
    if (!trackUrl) throw new Error('SoundCloud track URL is missing');

    let track;
    try {
      track = await this.streamClient.getTrackDetails(trackUrl);
    } catch (error) {
      if (song && typeof song === 'object') {
        return this.#fallbackStream(song, ['SoundCloud metadata: ' + briefError(error)]);
      }
      throw error;
    }
    const songObject = typeof song === 'string' ? this.#toSong(track) : song;
    const transcodings = this.streamClient._getSortedTranscodings(track);
    const failures = [];
    console.log('[soundcloud-stream] ' + (track.title || trackUrl) + ': transcodings=' + transcodings.length);

    for (const transcoding of transcodings) {
      const protocol = transcoding.format?.protocol;
      const mime = transcoding.format?.mime_type || 'unknown';

      if (protocol === 'cbc-encrypted-hls' || protocol === 'ctr-encrypted-hls' || /encrypted-hls/i.test(protocol || '')) {
        failures.push(protocol + ' is DRM/encrypted and cannot be decoded as a clear stream');
        continue;
      }

      try {
        const streamUrl = await this.streamClient.getStreamUrl(transcoding.url);
        let stream = null;

        if (protocol === 'hls') {
          const mediaUrl = await this.#resolveHlsMediaPlaylist(streamUrl);
          stream = await this.streamClient._createHlsStream(mediaUrl, 0, { track });
        } else if (protocol === 'progressive') {
          const response = await this.streamClient.http.get(streamUrl, {
            responseType: 'stream',
            headers: { Referer: 'https://soundcloud.com/' },
          });
          stream = response.data;
        } else {
          throw new Error('Unsupported SoundCloud transcoding protocol: ' + (protocol || 'missing'));
        }

        if (!stream || typeof stream.pipe !== 'function') throw new Error('SoundCloud did not return a readable stream');
        stream.on('error', error => console.warn('[soundcloud-stream] readable error:', error?.message || error));

        await this.bridge.start();
        const bridgeUrl = this.bridge.register(stream, 'SoundCloud · ' + (track.title || trackUrl));
        console.log('[soundcloud-stream] selected ' + protocol + ' ' + mime + ' · bridge=' + safeStreamUrl(bridgeUrl));
        return bridgeUrl;
      } catch (error) {
        const summary = protocol + ' ' + mime + ': ' + (error?.message || error);
        failures.push(summary);
        console.warn('[soundcloud-stream] transcoding failed:', summary);
      }
    }

    if (songObject) {
      return this.#fallbackStream(songObject, failures);
    }
    throw Object.assign(new Error('SoundCloud has no playable transcoding: ' + failures.join(' | ')), {
      code: 'SOUNDCLOUD_NO_PLAYABLE_STREAM',
    });
  }

  async getRelatedSongs(song) {
    const track = await this.streamClient.getTrackDetails(song.url).catch(() => null);
    if (!track?.id) return [];
    const related = await this.streamClient.getRelatedTracks(track.id, { limit: 10 }).catch(() => []);
    return (related || []).filter(item => item?.permalink_url && item?.title).map(item => this.#toSong(item));
  }
}

// ───────────────────────────── YouTube-плагин с несколькими запасными источниками ─────────────────────────────

class P3WYouTubePlugin extends YouTubePlugin {
  constructor(options, bridge) {
    super(options);
    this.bridge = bridge;
    this.soundcloud = null;
    this.fallback = null; // AudiusPlugin, подставляется после создания
    this.cookieHeader = options?.ytdlOptions?.cookie || process.env.YT_COOKIE || '';
    const executableName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    this.ytdlpPath = process.env.YT_DLP_PATH
      || path.join(os.tmpdir(), 'p3w-yt-dlp', executableName);
    this.ytdlpAvailable = false;
    this.ytdlpVersion = '';
    this.ytdlpReady = this.#ensureYtDlp().catch(error => {
      this.ytdlpAvailable = false;
      console.warn('[music-diag] yt-dlp backup extractor unavailable:', clampText(error?.message || String(error), 800));
      return false;
    });
  }

  async #ensureYtDlp() {
    const targetVersion = process.env.YT_DLP_VERSION || '2026.10.26';
    if (process.env.YT_DLP_PATH) {
      const version = getYtDlpVersion(this.ytdlpPath);
      if (!version) throw new Error('YT_DLP_PATH does not point to a working yt-dlp executable');
      this.ytdlpVersion = version;
      this.ytdlpAvailable = true;
      console.log(`✅ YouTube backup extractor: yt-dlp ${version} (custom path)`);
      return true;
    }

    const existingVersion = getYtDlpVersion(this.ytdlpPath);
    if (existingVersion === targetVersion) {
      this.ytdlpVersion = existingVersion;
      this.ytdlpAvailable = true;
      console.log(`✅ YouTube backup extractor: yt-dlp ${existingVersion} (runtime cache)`);
      return true;
    }

    const assets = {
      'linux-x64': 'yt-dlp_linux',
      'linux-arm64': 'yt-dlp_linux_aarch64',
      'win32-x64': 'yt-dlp.exe',
      'darwin-x64': 'yt-dlp_macos',
      'darwin-arm64': 'yt-dlp_macos',
    };
    const asset = assets[`${process.platform}-${process.arch}`];
    if (!asset) throw new Error(`No yt-dlp binary for ${process.platform}/${process.arch}`);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3w-yt-dlp-install-'));
    const tempPath = path.join(tempDir, executableNameForPlatform());
    const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${targetVersion}/${asset}`;
    try {
      console.log(`[music-diag] downloading yt-dlp ${targetVersion} at runtime...`);
      await downloadHttpsFile(url, tempPath);
      if (process.platform !== 'win32') fs.chmodSync(tempPath, 0o755);
      const downloadedVersion = getYtDlpVersion(tempPath);
      if (downloadedVersion !== targetVersion) {
        throw new Error(`yt-dlp version mismatch: expected ${targetVersion}, got ${downloadedVersion || 'unavailable'}`);
      }
      fs.mkdirSync(path.dirname(this.ytdlpPath), { recursive: true });
      fs.copyFileSync(tempPath, this.ytdlpPath);
      if (process.platform !== 'win32') fs.chmodSync(this.ytdlpPath, 0o755);
      const installedVersion = getYtDlpVersion(this.ytdlpPath);
      if (installedVersion !== targetVersion) {
        throw new Error('yt-dlp runtime executable could not be started after installation');
      }
      this.ytdlpVersion = installedVersion;
      this.ytdlpAvailable = true;
      console.log(`✅ YouTube backup extractor: yt-dlp ${installedVersion}`);
      return true;
    } finally {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  }

  async #findFallbackSong(query, options, targetDuration = 0) {
    if (this.soundcloud) {
      try {
        const song = await this.soundcloud.searchSong(query, options || {}, targetDuration);
        if (song) return song;
      } catch (error) {
        console.warn('SoundCloud fallback search failed:', briefError(error));
      }
    }
    if (this.fallback) {
      return this.fallback.searchSong(query, options || {}, targetDuration);
    }
    return null;
  }

  async searchYouTubeOnly(query, options = {}, targetDuration = 0) {
    const song = await super.searchSong(query, options);
    if (!song) return null;
    if (targetDuration > 0 && song.duration > 0) {
      const tolerance = Math.max(12, Math.round(targetDuration * 0.08));
      if (Math.abs(song.duration - targetDuration) > tolerance) return null;
    }
    return song;
  }

  async getDirectStreamURL(song) {
    if (!song?.url || !parseVideoId(song.url)) {
      throw Object.assign(new Error('Cannot resolve YouTube video'), { code: 'CANNOT_RESOLVE_SONG' });
    }
    return this.#prepareStream(song);
  }

  async resolve(url, options) {
    try {
      return await super.resolve(url, options);
    } catch (err) {
      const singleVideo = !parsePlaylistId(url) && parseVideoId(url);
      if (!singleVideo) throw err;
      console.warn('YouTube resolve failed, trying SoundCloud/Audius by title:', briefError(err));
      const title = await fetchOEmbedTitle(url);
      if (!title) throw err;
      const song = await this.#findFallbackSong(title, options || {});
      if (!song) throw err;
      setNote(song, 'YouTube недоступен: найдена воспроизводимая версия из другого источника');
      return song;
    }
  }

  async searchSong(query, options) {
    try {
      const song = await super.searchSong(query, options);
      if (song) return song;
    } catch (err) {
      console.warn('YouTube search failed, trying SoundCloud/Audius:', briefError(err));
    }
    if (!this.soundcloud && !this.fallback) return null;
    return this.#findFallbackSong(query, options || {}).catch(err => {
      console.warn('Music source fallback search failed:', briefError(err));
      return null;
    });
  }

  async getStreamURL(song) {
    if (song.plugin && song.plugin !== this) return song.plugin.getStreamURL(song);
    if (!song.url || !parseVideoId(song.url)) {
      throw Object.assign(new Error('Cannot resolve YouTube video'), { code: 'CANNOT_RESOLVE_SONG' });
    }

    try {
      return await this.#prepareStream(song);
    } catch (err) {
      console.warn('YouTube stream failed for "' + song.name + '":', JSON.stringify(describeMusicError(err), null, 2));
      const query = buildFallbackQuery(song);
      const failures = [];
      if (query && this.soundcloud) {
        try {
          const match = await this.soundcloud.searchSong(query, { member: song.member }, song.duration);
          if (match) {
            const url = await this.soundcloud.getStreamURL(match);
            if (url) {
              setNote(song, 'YouTube не отдал звук: включена подходящая версия с SoundCloud или резервного источника');
              return url;
            }
          }
        } catch (fallbackError) {
          failures.push('SoundCloud: ' + briefError(fallbackError));
        }
      }
      if (query && this.fallback) {
        try {
          const match = await this.fallback.searchSong(query, { member: song.member }, song.duration);
          if (match) {
            const url = await this.fallback.getStreamURL(match);
            if (url) {
              setNote(song, 'YouTube не отдал звук: включена подходящая версия с Audius');
              return url;
            }
          }
        } catch (fallbackError) {
          failures.push('Audius: ' + briefError(fallbackError));
        }
      }
      throw Object.assign(new Error('YouTube stream failed; fallback providers failed: ' + failures.join(' | '), { cause: err }), {
        code: 'MUSIC_ALL_SOURCES_FAILED',
      });
    }
  }

  async #prepareStream(song) {
    let primaryError;
    try {
      return await this.#prepareWithYtdlCore(song);
    } catch (error) {
      primaryError = error;
      if (this.ytdlpReady) await this.ytdlpReady;
      if (!this.ytdlpAvailable) throw error;
      console.warn('[youtube-fallback] ytdl-core failed; trying yt-dlp:', briefError(error));
    }

    try {
      return await this.#prepareWithYtDlp(song);
    } catch (fallbackError) {
      throw Object.assign(new Error(
        'YouTube extraction failed: ytdl-core: ' + briefError(primaryError)
        + ' | yt-dlp: ' + briefError(fallbackError),
        { cause: primaryError },
      ), {
        code: 'YOUTUBE_EXTRACTORS_FAILED',
        errors: [primaryError, fallbackError],
      });
    }
  }

  async #prepareWithYtdlCore(song) {
    const ytdl = this.ytdl;
    const info = await ytdl.getInfo(song.url);
    if (!info.formats?.length) {
      throw Object.assign(new Error('Video has no formats'), { code: 'UNAVAILABLE_VIDEO' });
    }

    try {
      const meta = new YouTubeSong(this, info, {});
      song.ageRestricted = meta.ageRestricted;
      song.thumbnail = song.thumbnail || meta.thumbnail;
      song.related = meta.related;
      song.chapters = meta.chapters;
      song.storyboards = meta.storyboards;
    } catch {
      // Metadata is optional for playback.
    }

    const wait = Number(info.playableAt) - Date.now();
    if (wait > 0) await sleep(Math.min(wait, 60_000));

    const stream = ytdl.download(info, {
      quality: Quality.HighestAudio,
      filter: AUDIO_FILTERS,
      onRetry: event => console.warn('YouTube re-resolve (' + song.name + '): attempt ' + event.attempt + ', ' + event.client + ', ' + event.reason),
    });
    await primeStream(stream);
    await this.bridge.start();
    return this.bridge.register(stream, song.name);
  }

  async #prepareWithYtDlp(song) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3w-ytdlp-'));
    const tempCookiePath = path.join(tempDir, 'youtube-cookies.txt');
    let cookiePath = '';

    try {
      const configuredCookieFile = process.env.YT_COOKIE_FILE
        ? path.resolve(process.env.YT_COOKIE_FILE)
        : '';
      if (configuredCookieFile && fs.existsSync(configuredCookieFile)) {
        cookiePath = configuredCookieFile;
      } else if (this.cookieHeader) {
        const cookieText = toNetscapeCookieFile(this.cookieHeader);
        if (cookieText) {
          fs.writeFileSync(tempCookiePath, cookieText, { mode: 0o600 });
          cookiePath = tempCookiePath;
        }
      }

      if (cookiePath) {
        const cookieEntries = fs.readFileSync(cookiePath, 'utf8')
          .split(/\\r?\\n/)
          .filter(line => line.split('\\t').length >= 7).length;
        console.log(`[youtube-fallback] yt-dlp cookie entries loaded: ${cookieEntries}`);
      } else {
        console.warn('[youtube-fallback] yt-dlp has no cookies; set YT_COOKIE or YT_COOKIE_FILE');
      }

      const args = [
        '--ignore-config',
        '--no-playlist',
        '--no-progress',
        '--no-warnings',
        '--quiet',
        '--extractor-args', process.env.YT_DLP_EXTRACTOR_ARGS || 'youtube:player_client=default,-web_embedded',
        '--format', 'bestaudio/best',
        '--output', '-',
        '--socket-timeout', '20',
        '--retries', '2',
        '--js-runtimes', `node:${process.execPath}`,
      ];
      if (cookiePath) args.push('--cookies', cookiePath);
      args.push(song.url);

      const child = spawn(this.ytdlpPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stderr = '';
      child.stderr.on('data', chunk => {
        stderr = (stderr + chunk.toString('utf8')).slice(-6000);
      });
      child.stdout.on('error', error => {
        console.warn('[youtube-fallback] yt-dlp stdout error:', error?.message || error);
      });

      child.once('error', error => {
        if (child.stdout && !child.stdout.destroyed) child.stdout.destroy(error);
      });
      child.once('close', (code, signal) => {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* cleanup */ }
        if (code !== 0 && child.stdout && !child.stdout.destroyed) {
          const details = clampText(stderr.trim(), 1800);
          child.stdout.destroy(Object.assign(new Error(
            `yt-dlp exited with code ${code}${signal ? ' (' + signal + ')' : ''}${details ? ': ' + details : ''}`,
          ), { code: 'YT_DLP_FAILED' }));
        }
      });
      child.stdout.once('close', () => {
        if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
      });

      try {
        await primeStream(child.stdout, 35_000);
      } catch (error) {
        if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
        const details = clampText(stderr.trim(), 1800);
        if (details && !String(error.message || '').includes(details)) {
          error.message = `${error.message || error} · yt-dlp: ${details}`;
        }
        throw error;
      }

      await this.bridge.start();
      const bridgeUrl = this.bridge.register(child.stdout, 'YouTube yt-dlp · ' + song.name);
      console.log('[youtube-fallback] yt-dlp stream prepared for "' + song.name + '"');
      return bridgeUrl;
    } catch (error) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* cleanup */ }
      throw error;
    }
  }
}


// Yandex Music direct playback with mirror fallback when its stream endpoint fails.
// Metadata resolution still requires the user's Yandex OAuth token and UID.
class P3WYandexMusicPlugin extends YandexMusicPlugin {
  constructor(options, sources) {
    super(options);
    this.sources = sources || {};
  }

  async getStreamURL(song) {
    try {
      return await super.getStreamURL(song);
    } catch (error) {
      const query = buildFallbackQuery(song);
      const failures = ['Yandex Music: ' + briefError(error)];
      if (query && this.sources.youtube) {
        try {
          const candidate = await this.sources.youtube.searchYouTubeOnly(query, { member: song.member }, song.duration);
          if (candidate) {
            const url = await this.sources.youtube.getDirectStreamURL(candidate);
            if (url) {
              setNote(song, 'Яндекс не отдал аудио: включена подходящая версия с YouTube');
              return url;
            }
          }
        } catch (fallbackError) {
          failures.push('YouTube: ' + briefError(fallbackError));
        }
      }
      if (query && this.sources.soundcloud) {
        try {
          const candidate = await this.sources.soundcloud.searchSong(query, { member: song.member }, song.duration);
          if (candidate) {
            const url = await this.sources.soundcloud.getStreamURL(candidate);
            if (url) {
              setNote(song, 'Яндекс не отдал аудио: включена подходящая версия с SoundCloud/Audius');
              return url;
            }
          }
        } catch (fallbackError) {
          failures.push('SoundCloud: ' + briefError(fallbackError));
        }
      }
      if (query && this.sources.audius) {
        try {
          const candidate = await this.sources.audius.searchSong(query, { member: song.member }, song.duration);
          if (candidate) {
            const url = await this.sources.audius.getStreamURL(candidate);
            if (url) {
              setNote(song, 'Яндекс не отдал аудио: включена подходящая версия с Audius');
              return url;
            }
          }
        } catch (fallbackError) {
          failures.push('Audius: ' + briefError(fallbackError));
        }
      }
      throw Object.assign(new Error('Яндекс не отдал поток, резервные источники не нашли рабочую версию: ' + failures.join(' | '), {
        cause: error,
      }), { code: 'YANDEX_NO_PLAYABLE_STREAM' });
    }
  }
}

// ───────────────────────────── панель плеера (чистые функции отрисовки) ─────────────────────────────

function renderPanel(queue) {
  const song = queue?.songs?.[0];
  if (!queue || !song) return renderIdle('⏹️ Плеер не активен');

  const paused = queue.paused;
  const lines = [`**${songLine(song, 100)}**`];
  if (song.uploader?.name) lines.push(`👤 ${mdText(song.uploader.name, 60)}`);
  if (song.isLive) {
    lines.push('🔴 **Прямой эфир**');
  } else if (song.duration) {
    lines.push(`\`${formatDur(queue.currentTime)}\` ${progressBar(queue.currentTime, song.duration)} \`${formatDur(song.duration)}\``);
  }

  const embed = new EmbedBuilder()
    .setColor(paused ? COLORS.paused : COLORS.playing)
    .setAuthor({ name: paused ? '⏸️ Пауза' : '🎵 Сейчас играет' })
    .setDescription(lines.join('\n'))
    .addFields(
      { name: '🔊 Громкость', value: `${queue.volume}%`, inline: true },
      { name: '🔁 Повтор', value: REPEAT_LABELS[queue.repeatMode] || 'выкл', inline: true },
      { name: '📃 В очереди', value: String(Math.max(0, queue.songs.length - 1)), inline: true },
    );

  const next = queue.songs[1];
  if (next) embed.addFields({ name: '⏭️ Дальше', value: songLine(next, 80) });

  if (song.thumbnail && /^https?:\/\//i.test(song.thumbnail)) embed.setThumbnail(song.thumbnail);

  const played = song.stream?.song;
  const origin = played && played !== song
    ? `${sourceLabel(song.source)} → ${sourceLabel(played.source)}`
    : sourceLabel(song.source);
  const requester = song.member?.displayName || song.user?.username;
  const footer = [`Источник: ${origin}`, requester ? `Заказал: ${requester}` : '', getNote(song) || ''].filter(Boolean).join(' · ');
  embed.setFooter({ text: clampText(footer, 200) });

  return { embeds: [embed], components: renderButtons(queue) };
}

function renderButtons(queue) {
  const id = action => `${PREFIX}:${action}`;
  const button = (action, emoji, style = ButtonStyle.Secondary, disabled = false) => new ButtonBuilder()
    .setCustomId(id(action))
    .setEmoji(emoji)
    .setStyle(style)
    .setDisabled(disabled);

  const hasPrev = (queue.previousSongs?.length || 0) > 0;
  const hasNext = queue.songs.length > 1 || queue.autoplay;
  const repeat = queue.repeatMode;

  const row1 = new ActionRowBuilder().addComponents(
    button('prev', '⏮️', ButtonStyle.Secondary, !hasPrev),
    button('toggle', queue.paused ? '▶️' : '⏸️', queue.paused ? ButtonStyle.Success : ButtonStyle.Primary),
    button('skip', '⏭️', ButtonStyle.Secondary, !hasNext),
    button('stop', '⏹️', ButtonStyle.Danger),
    button('loop', repeat === RepeatMode.SONG ? '🔂' : '🔁', repeat === RepeatMode.DISABLED ? ButtonStyle.Secondary : ButtonStyle.Success),
  );
  const row2 = new ActionRowBuilder().addComponents(
    button('shuffle', '🔀', ButtonStyle.Secondary, queue.songs.length < 3),
    button('voldown', '🔉', ButtonStyle.Secondary, queue.volume <= 1),
    button('volup', '🔊', ButtonStyle.Secondary, queue.volume >= 100),
    button('queue', '📜'),
    button('leave', '👋'),
  );
  return [row1, row2];
}

function renderIdle(text) {
  const embed = new EmbedBuilder().setColor(COLORS.idle).setDescription(text);
  return { embeds: [embed], components: [] };
}

function renderQueue(queue, requestedPage) {
  const upcoming = queue.songs.slice(1);
  const pages = Math.max(1, Math.ceil(upcoming.length / QUEUE_PAGE_SIZE));
  const page = clamp(requestedPage, 0, pages - 1);
  const offset = page * QUEUE_PAGE_SIZE;
  const slice = upcoming.slice(offset, offset + QUEUE_PAGE_SIZE);

  const current = queue.songs[0];
  const lines = [`▶️ **Сейчас:** ${songLine(current, 70)} · \`${current?.isLive ? 'LIVE' : formatDur(current?.duration)}\``];
  if (slice.length) {
    lines.push('');
    slice.forEach((song, i) => {
      lines.push(`**${offset + i + 1}.** ${songLine(song, 70)} · \`${song.isLive ? 'LIVE' : formatDur(song.duration)}\``);
    });
  } else {
    lines.push('', '_Дальше в очереди пусто. Добавь треки через /play._');
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.playing)
    .setTitle('🎶 Очередь P3W')
    .setDescription(clampText(lines.join('\n'), 4000))
    .setFooter({ text: `Страница ${page + 1}/${pages} · треков: ${queue.songs.length} · ${queue.formattedDuration || ''} · 🔊 ${queue.volume}%` });

  const components = [];
  if (slice.length) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`${PREFIX}:jump`)
      .setPlaceholder('Перейти к треку…')
      .addOptions(slice.map((song, i) => ({
        label: clampText(`${offset + i + 1}. ${String(song.name || 'Без названия').replace(/\s+/g, ' ')}`, 100),
        description: song.isLive ? 'LIVE' : formatDur(song.duration),
        value: String(offset + i + 1),
      })));
    components.push(new ActionRowBuilder().addComponents(select));
  }
  if (pages > 1) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}:q:${page - 1}`).setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`${PREFIX}:q:${page + 1}`).setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
    ));
  }
  return { embeds: [embed], components };
}

// ───────────────────────────── модуль ─────────────────────────────

function buildCommands() {
  const choice = (name, value) => ({ name, value });
  return [
    new SlashCommandBuilder()
      .setName('play')
      .setDescription('Включить музыку по ссылке или названию')
      .addStringOption(o => o.setName('query').setDescription('YouTube, SoundCloud, Spotify, Audius, Яндекс Музыка или название трека').setRequired(true).setMaxLength(500))
      .addBooleanOption(o => o.setName('next').setDescription('Поставить следующим в очереди'))
      .toJSON(),
    new SlashCommandBuilder().setName('player').setDescription('Показать панель плеера с кнопками').toJSON(),
    new SlashCommandBuilder().setName('skip').setDescription('Пропустить текущий трек').toJSON(),
    new SlashCommandBuilder().setName('pause').setDescription('Приостановить музыку').toJSON(),
    new SlashCommandBuilder().setName('resume').setDescription('Продолжить музыку').toJSON(),
    new SlashCommandBuilder().setName('stop').setDescription('Остановить музыку и очистить очередь').toJSON(),
    new SlashCommandBuilder().setName('queue').setDescription('Показать очередь музыки').toJSON(),
    new SlashCommandBuilder().setName('nowplaying').setDescription('Показать текущий трек с панелью управления').toJSON(),
    new SlashCommandBuilder()
      .setName('volume')
      .setDescription('Изменить громкость музыки')
      .addIntegerOption(o => o.setName('percent').setDescription('Громкость от 1 до 200; выше 100 — усиление с возможным искажением').setRequired(true).setMinValue(1).setMaxValue(VOLUME_MAX))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('loop')
      .setDescription('Режим повтора')
      .addStringOption(o => o.setName('mode').setDescription('Что повторять').setRequired(true)
        .addChoices(choice('Выключить', 'off'), choice('Текущий трек', 'track'), choice('Всю очередь', 'queue')))
      .toJSON(),
    new SlashCommandBuilder().setName('shuffle').setDescription('Перемешать очередь').toJSON(),
    new SlashCommandBuilder().setName('leave').setDescription('Остановить музыку и отключить P3W от войса').toJSON(),
    new SlashCommandBuilder()
      .setName('musictest')
      .setDescription('Проверить доступность источников YouTube, SoundCloud, Spotify, Audius и Яндекс Музыки')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON(),
  ];
}

class MusicModule {
  constructor(client, config = {}) {
    this.client = client;
    this.config = config;
    this.commands = buildCommands();

    this.bridge = new StreamBridge();
    this.panels = new Map();       // guildId -> Message с панелью
    this.locks = new Map();        // guildId -> Promise (последовательные операции с панелью)
    this.emptyTimers = new Map();  // guildId -> Timeout (в канале никого нет)
    this.idleTimers = new Map();   // guildId -> Timeout (очередь закончилась, бот ждёт в канале)
    this.pendingPlays = new Map(); // guildId -> число выполняющихся /play
    this.lastErrors = new Map();   // guildId -> { at, error }

    this.#createDistube();
    this.#bindEvents();



  }

  // ───── создание DisTube ─────

  #createDistube() {
    // Prefer a verified BtbN FFmpeg 9.0.2 build installed by npm postinstall.
    // Fall back to Render's system FFmpeg only if the static binary could not install.
    const bundledFFmpeg = path.join(__dirname, '..', 'vendor', 'ffmpeg', 'bin', 'ffmpeg');
    this.ffmpegPath = process.env.FFMPEG_PATH || (fs.existsSync(bundledFFmpeg) ? bundledFFmpeg : 'ffmpeg');
    const ffmpegVersion = spawnSync(this.ffmpegPath, ['-version'], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    if (ffmpegVersion.error || ffmpegVersion.status !== 0) {
      console.error('[music-diag] FFmpeg unavailable:', ffmpegVersion.error?.message || ffmpegVersion.stderr);
    } else {
      console.log(`🎛️ FFmpeg binary: ${this.ffmpegPath} · ${String(ffmpegVersion.stdout).split('\n')[0]}`);
    }
    const cookie = this.config.YT_COOKIE;

    this.youtube = new P3WYouTubePlugin({ ytdlOptions: cookie ? { cookie } : {} }, this.bridge);
    this.soundcloud = new P3WSoundCloudPlugin(this.bridge);
    this.audius = new P3WAudiusPlugin({ apiKey: this.config.AUDIUS_API_KEY });
    this.spotify = new SpotifyPlugin();

    // Источники соединены в одну fallback-цепочку: YouTube -> SoundCloud -> Audius.
    this.youtube.soundcloud = this.soundcloud;
    this.youtube.fallback = this.audius;
    this.soundcloud.youtube = this.youtube;
    this.soundcloud.audius = this.audius;

    const plugins = [this.youtube, this.soundcloud, this.audius, this.spotify];

    // Яндекс API требует токен и UID одного аккаунта. Если они заданы,
    // Яндекс играет напрямую; Spotify использует общую цепочку поиска плеера.
    this.yandex = null;
    if (this.config.YANDEX_MUSIC_OAUTH_TOKEN && this.config.YANDEX_MUSIC_UID) {
      this.yandex = new P3WYandexMusicPlugin({
        oauthToken: this.config.YANDEX_MUSIC_OAUTH_TOKEN,
        uid: this.config.YANDEX_MUSIC_UID,
      }, { youtube: this.youtube, soundcloud: this.soundcloud, audius: this.audius });
      plugins.splice(plugins.length - 1, 0, this.yandex);
      console.log('✅ Yandex Music source enabled');
    } else {
      console.warn('⚠️ Yandex Music source disabled: YANDEX_MUSIC_OAUTH_TOKEN and YANDEX_MUSIC_UID are not configured');
    }

    this.distube = new DisTube(this.client, {
      plugins,
      emitNewSongOnly: true,
      ffmpeg: { path: this.ffmpegPath },
    });
  }

  #bindEvents() {
    const d = this.distube;

    d.on('initQueue', queue => {
      this.#cancelIdleLeave(queue.id);
      this.#traceVoice(queue);
    });
    d.on('playSong', (queue, song) => {
      this.#cancelIdleLeave(queue.id);
      this.#watchPlayback(queue, song);
      this.#sendPanel(queue, queue.textChannel, song).catch(err => console.error('Music panel error:', err?.message || err));
    });
    d.on('addSong', queue => this.#refreshPanel(queue.id));
    d.on('addList', queue => this.#refreshPanel(queue.id));
    d.on('finish', queue => this.#endPanel(queue.id, '✅ Очередь закончилась'));
    d.on('deleteQueue', queue => {
      this.#endPanel(queue.id, '⏹️ Плеер остановлен');
      this.#scheduleIdleLeave(queue.id);
    });
    d.on('disconnect', queue => this.#endPanel(queue.id, '👋 Бот отключился от канала'));

    d.on('error', (error, queue, song) => {
      const guildId = queue?.id;
      console.error('Music playback error:', JSON.stringify({
        guildId,
        song: song?.name,
        source: song?.plugin?.constructor?.name || song?.source,
        error: describeMusicError(error),
      }, null, 2));
      if (guildId) this.lastErrors.set(guildId, { at: Date.now(), error });
      // Если ошибка случилась во время /play, об этом сообщит сама команда.
      if (guildId && this.pendingPlays.get(guildId)) return;
      queue?.textChannel?.send({
        content: formatMusicError(error),
        allowedMentions: { parse: [] },
      }).catch(err => console.error('Music error announcement failed:', err));
      if (guildId) this.#refreshPanel(guildId);
    });

    // В логи попадают только подозрительные строки ffmpeg (403, обрывы и т.п.).
    d.on('ffmpegDebug', line => {
      if (/error|fail|403|404|denied|invalid|unable|could not|reset|timed out/i.test(line)) {
        console.warn('[ffmpeg]', clampText(String(line), 300));
      }
    });
  }

  // ───── публичный API для bot.js ─────

  get commandsJSON() {
    return this.commands;
  }

  handles(interaction) {
    if (interaction.isChatInputCommand()) return MUSIC_COMMANDS.has(interaction.commandName);
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      return interaction.customId.startsWith(`${PREFIX}:`);
    }
    return false;
  }

  async handleInteraction(interaction) {
    try {
      if (interaction.isChatInputCommand()) return await this.#handleCommand(interaction);
      return await this.#handleComponent(interaction);
    } catch (err) {
      console.error('Music interaction error:', JSON.stringify({
        id: interaction.commandName || interaction.customId,
        error: describeMusicError(err),
      }, null, 2));
      await this.#say(interaction, formatMusicError(err)).catch(() => {});
    }
  }

  async ensureVoice(channel) {
    this.#cancelIdleLeave(channel.guild.id);
    const voice = await this.distube.voices.join(channel);

    // У некоторых версий @discordjs/voice selfMute по умолчанию true, а DisTube по умолчанию
    // заходит deafened: музыкальному боту нужно и то и другое снять.
    const undeafenRequested = voice.setSelfDeaf(false);
    if (!undeafenRequested && voice.selfDeaf) {
      throw Object.assign(new Error('P3W could not clear its self-deaf state'), { code: 'VOICE_SELF_UNDEAF_FAILED' });
    }
    const unmuteRequested = voice.setSelfMute(false);
    if (!unmuteRequested && voice.selfMute) {
      throw Object.assign(new Error('P3W could not clear its self-mute state'), { code: 'VOICE_SELF_UNMUTE_FAILED' });
    }

    // Server mute снимает только модератор.
    if (channel.guild.members.me?.voice?.serverMute) {
      throw Object.assign(new Error('P3W is server-muted by a moderator'), { code: 'VOICE_SERVER_MUTED' });
    }
    return voice;
  }

  // Возвращает true, если событие относится к самому боту (дальше его обрабатывать не нужно).
  onVoiceStateUpdate(oldState, newState) {
    const guild = newState.guild || oldState.guild;
    if (!guild) return false;

    if (newState.id === this.client.user?.id) {
      if (newState.serverMute && newState.channelId) {
        console.error('P3W is server-muted in voice; a moderator must unmute the bot.');
      } else if (newState.selfDeaf && newState.channelId) {
        this.distube.voices.get(guild.id)?.setSelfDeaf(false);
        console.warn('P3W self-deaf detected; requested self-undeafen.');
      } else if (newState.selfMute && newState.channelId) {
        this.distube.voices.get(guild.id)?.setSelfMute(false);
        console.warn('P3W self-mute detected; requested self-unmute.');
      }
      if (!newState.channelId) this.#clearTimer(this.emptyTimers, guild.id);
      return true;
    }

    this.#checkEmptyChannel(guild);
    return false;
  }

  async shutdown() {
    for (const timers of [this.emptyTimers, this.idleTimers]) {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    }
    for (const guild of this.client.guilds.cache.values()) {
      const queue = this.distube.getQueue(guild.id);
      if (queue) await queue.stop().catch(err => console.error('Music shutdown queue error:', err));
      try { this.distube.voices.leave(guild.id); } catch { /* уже отключён */ }
    }
    this.bridge.close();
  }

  // ───── диагностика источников ─────

  async runDiagnostics() {
    const lines = [];
    const check = async (label, fn, timeoutMs = 25_000) => {
      const started = Date.now();
      let timeout;
      console.log('[music-diag] starting: ' + label);
      try {
        const detail = await Promise.race([
          fn(),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('source check timed out after ' + timeoutMs + ' ms')), timeoutMs);
            timeout.unref?.();
          }),
        ]);
        lines.push(`✅ ${label} — ${Date.now() - started} мс${detail ? ` · ${detail}` : ''}`);
        console.log('[music-diag] passed: ' + label);
        return true;
      } catch (err) {
        lines.push(`❌ ${label} — ${clampText(briefError(err), 260)}`);
        console.warn('[music-diag] failed: ' + label + ' · ' + briefError(err));
        return false;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    };

    await check('FFmpeg: системный бинарник', async () => {
      const result = spawnSync(this.ffmpegPath, ['-version'], {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      });
      if (result.error || result.status !== 0) {
        throw new Error(result.error?.message || result.stderr || 'FFmpeg exited with status ' + result.status);
      }
      return String(result.stdout).split('\n')[0].trim();
    });

    await check('FFmpeg: кодирование Opus', async () => {
      const result = spawnSync(this.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3',
        '-ac', '2', '-ar', '48000', '-c:a', 'libopus', '-f', 'ogg', 'pipe:1',
      ], { encoding: 'buffer', timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
      if (result.error || result.status !== 0 || !result.stdout?.length) {
        throw new Error(result.error?.message || result.stderr?.toString() || 'FFmpeg Opus encode failed');
      }
      return `${result.stdout.length} bytes Ogg/Opus`;
    });

    await check('Opus: native encode/decode', async () => {
      const encoder = new OpusEncoder(48000, 2);
      const packet = encoder.encode(Buffer.alloc(3840));
      const decoded = encoder.decode(packet);
      if (!packet.length || decoded.length !== 3840) {
        throw new Error(`invalid Opus frame: encoded=${packet.length}, decoded=${decoded.length}`);
      }
      return `${packet.length} bytes packet · ${decoded.length} bytes PCM`;
    });

    const ytdl = this.youtube.ytdl;
    await check('YouTube: поиск', async () => {
      const [first] = await ytdl.search('never gonna give you up', { limit: 1 });
      if (!first) throw new Error('пустая выдача');
      return clampText(first.title, 40);
    });

    await check('YouTube: аудиопоток (ytdl-core → yt-dlp fallback)', async () => {
      const streamUrl = await this.youtube.getDirectStreamURL({
        url: SELF_TEST_VIDEO,
        name: 'P3W YouTube self-test',
        duration: 0,
      });
      const probe = await probeAudioUrl(streamUrl, 35_000);
      return `${probe.contentType} · ${probe.bytes} bytes`;
    });

    let audiusSong = null;
    await check('Audius: поиск', async () => {
      audiusSong = await this.audius.searchSong(MUSIC_DIAG_AUDIUS_QUERY);
      if (!audiusSong) throw new Error('нет публичных, ungated и streamable треков с допустимой лицензией');
      return clampText(audiusSong.name, 48);
    });

    if (audiusSong) {
      await check('Audius: аудиопоток', async () => {
        const response = await fetch(await this.audius.getStreamURL(audiusSong), {
          headers: { Accept: 'audio/mpeg', Range: 'bytes=0-4095' },
          redirect: 'follow',
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok || !response.body) throw new Error('HTTP ' + response.status + ' · ' + (response.headers.get('content-type') || 'no body'));
        const reader = response.body.getReader();
        const first = await reader.read();
        await reader.cancel().catch(() => {});
        if (!first.value?.byteLength) throw new Error('Audius returned an empty audio response');
        return 'HTTP ' + response.status + ' · ' + (response.headers.get('content-type') || 'unknown') + ' · ' + first.value.byteLength + ' bytes';
      });
    } else {
      lines.push('⏭️ Audius: аудиопоток — пропущен, поиск не дал допустимых результатов');
    }

    let soundCloudSong = null;
    await check('SoundCloud: поиск', async () => {
      soundCloudSong = await this.soundcloud.searchSong('lofi instrumental');
      if (!soundCloudSong) throw new Error('пустая выдача');
      return clampText(soundCloudSong.name, 48);
    });

    if (soundCloudSong) {
      await check('SoundCloud: поток или автоматический fallback', async () => {
        const url = await this.soundcloud.getStreamURL(soundCloudSong);
        const probe = await probeAudioUrl(url);
        return (getNote(soundCloudSong) || 'нативный SoundCloud') + ' · HTTP ' + probe.status + ' · ' + probe.contentType + ' · ' + probe.bytes + ' bytes';
      });
    } else {
      lines.push('⏭️ SoundCloud: поток — пропущен, поиск не дал результатов');
    }

    await check('Spotify: metadata + подбор воспроизводимого источника (DisTube v5)', async () => {
      const spotifySong = await this.spotify.resolve(MUSIC_DIAG_SPOTIFY_URL, {
        member: this.client.guilds.cache.first()?.members?.me || undefined,
      });
      if (!spotifySong?.name) throw new Error('Spotify did not return track metadata');
      const query = await this.spotify.createSearchQuery(spotifySong);
      let matchedSong = null;
      for (const provider of [this.youtube, this.soundcloud, this.audius]) {
        try {
          const candidate = await provider.searchSong(query, { member: spotifySong.member });
          if (candidate) {
            matchedSong = candidate;
            const url = await candidate.plugin.getStreamURL(candidate);
            const probe = await probeAudioUrl(url);
            return spotifySong.name + ' → ' + candidate.name + ' (' + sourceLabel(candidate.source) + ') · ' + probe.bytes + ' bytes';
          }
        } catch (error) {
          console.warn('[spotify-fallback] ' + provider.constructor.name + ': ' + briefError(error));
        }
      }
      throw new Error('Spotify metadata loaded, but YouTube, SoundCloud and Audius found no playable match');
    });

    if (this.yandex) {
      await check('Яндекс Музыка: resolve + аудиопоток/fallback', async () => {
        const song = await this.yandex.resolve('https://music.yandex.ru/album/10030/track/38634572', {});
        const url = await this.yandex.getStreamURL(song);
        const probe = await probeAudioUrl(url);
        return clampText(song.name, 38) + ' · HTTP ' + probe.status + ' · ' + probe.bytes + ' bytes';
      });
    } else {
      lines.push('⚠️ Яндекс Музыка: не включена — Render не содержит OAuth token и UID аккаунта');
    }

    lines.push(this.config.YT_COOKIE ? 'ℹ️ YT_COOKIE задан' : 'ℹ️ YT_COOKIE не задан');
    lines.push(this.youtube.ytdlpAvailable
      ? `ℹ️ yt-dlp fallback: ${this.youtube.ytdlpVersion}`
      : '⚠️ yt-dlp fallback: не установлен');
    return lines;
  }

  // ───── slash-команды ─────

  async #handleCommand(interaction) {
    const name = interaction.commandName;
    if (!interaction.guildId) {
      return this.#say(interaction, '❌ Эта команда работает только на сервере.');
    }

    if (name === 'play') return this.#cmdPlay(interaction);
    if (name === 'leave') return this.#cmdLeave(interaction);
    if (name === 'musictest') return this.#cmdTest(interaction);

    const queue = await this.#controlQueue(interaction);
    if (!queue) return undefined;

    switch (name) {
      case 'queue':
        return interaction.reply({ ...renderQueue(queue, 0), flags: EPHEMERAL, allowedMentions: { parse: [] } });
      case 'nowplaying':
      case 'player': {
        await interaction.deferReply({ flags: EPHEMERAL });
        queue.textChannel = interaction.channel;
        await this.#sendPanel(queue, interaction.channel);
        return interaction.deleteReply().catch(() => {});
      }
      case 'skip': {
        if (queue.songs.length < 2 && !queue.autoplay) return this.#say(interaction, 'ℹ️ В очереди нет следующего трека.');
        await interaction.deferReply();
        await queue.skip();
        return interaction.editReply({ content: `⏭️ Пропущено — ${interaction.user}`, allowedMentions: { parse: [] } });
      }
      case 'pause':
        if (queue.paused) return this.#say(interaction, '⏸️ Музыка уже на паузе.');
        await queue.pause();
        this.#refreshPanel(queue.id);
        return this.#say(interaction, '⏸️ Музыка поставлена на паузу.', false);
      case 'resume':
        if (!queue.paused) return this.#say(interaction, '▶️ Музыка уже играет.');
        await queue.resume();
        this.#refreshPanel(queue.id);
        return this.#say(interaction, '▶️ Продолжаю воспроизведение.', false);
      case 'stop':
        await queue.stop();
        return this.#say(interaction, '⏹️ Воспроизведение остановлено, очередь очищена.', false);
      case 'volume': {
        const percent = interaction.options.getInteger('percent', true);
        queue.setVolume(percent);
        this.#refreshPanel(queue.id);
        return this.#say(interaction, `🔊 Громкость установлена на ${percent}%.`, false);
      }
      case 'loop': {
        const mode = { off: RepeatMode.DISABLED, track: RepeatMode.SONG, queue: RepeatMode.QUEUE }[interaction.options.getString('mode', true)];
        queue.setRepeatMode(mode);
        this.#refreshPanel(queue.id);
        return this.#say(interaction, `🔁 Повтор: ${REPEAT_LABELS[mode]}.`, false);
      }
      case 'shuffle':
        if (queue.songs.length < 3) return this.#say(interaction, 'ℹ️ Для перемешивания нужно хотя бы два трека в очереди.');
        await queue.shuffle();
        this.#refreshPanel(queue.id);
        return this.#say(interaction, '🔀 Очередь перемешана.', false);
      default:
        return undefined;
    }
  }

  async #cmdPlay(interaction) {
    const guildId = interaction.guildId;
    const memberVoice = interaction.member?.voice?.channel;
    if (!memberVoice) return this.#say(interaction, '❌ Сначала зайди в голосовой канал.');

    const permissions = memberVoice.permissionsFor(this.client.user);
    if (!permissions?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
      return this.#say(interaction, '❌ У P3W нет прав подключаться и говорить в этом голосовом канале.');
    }

    const existing = this.distube.getQueue(guildId);
    if (existing && existing.voiceChannel?.id !== memberVoice.id) {
      return this.#say(interaction, '❌ P3W уже играет в другом голосовом канале. Используй /leave, чтобы переместить его.');
    }

    const query = interaction.options.getString('query', true).trim();
    const playNext = Boolean(interaction.options.getBoolean('next'));

    if (/^https?:\/\/(?:(?:www|m)\.)?music\.yandex\./i.test(query)
      && (!this.config.YANDEX_MUSIC_OAUTH_TOKEN || !this.config.YANDEX_MUSIC_UID)) {
      return this.#say(interaction, 'ℹ️ Поддержка Яндекс Музыки уже добавлена, но не подключён аккаунт. В Render добавь секреты YANDEX_MUSIC_OAUTH_TOKEN и YANDEX_MUSIC_UID (из одного аккаунта), затем перезапусти бота.');
    }

    const requester = interaction.guild.members.cache.get(interaction.user.id)
      || await interaction.guild.members.fetch(interaction.user.id).catch(() => null);

    await interaction.deferReply();
    this.pendingPlays.set(guildId, (this.pendingPlays.get(guildId) || 0) + 1);
    const startedAt = Date.now();
    const before = existing?.songs.length || 0;

    try {
      await this.ensureVoice(memberVoice);
      await this.distube.play(memberVoice, query, {
        textChannel: interaction.channel,
        member: requester || undefined,
        ...(playNext && existing ? { position: 1 } : {}),
      });

      const failure = this.lastErrors.get(guildId);
      if (failure && failure.at >= startedAt) {
        return await interaction.editReply({ content: formatMusicError(failure.error), allowedMentions: { parse: [] } });
      }

      const queue = this.distube.getQueue(guildId);
      if (queue) queue.textChannel = interaction.channel;
      const added = queue ? queue.songs.slice(before) : [];
      return await interaction.editReply({
        content: this.#describeAdded(added, before, playNext),
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      console.error('Music play command error:', JSON.stringify({
        guildId,
        query,
        error: describeMusicError(err),
      }, null, 2));
      return interaction.editReply({ content: formatMusicError(err), allowedMentions: { parse: [] } });
    } finally {
      const left = (this.pendingPlays.get(guildId) || 1) - 1;
      if (left > 0) this.pendingPlays.set(guildId, left);
      else this.pendingPlays.delete(guildId);
    }
  }

  #describeAdded(added, before, playNext) {
    if (!added.length) return '✅ Запрос обработан.';
    const note = getNote(added[0]);
    const noteLine = note ? `\nℹ️ ${note}` : '';
    if (added.length > 1) {
      return `➕ Добавлено треков: **${added.length}**. Первый — ${songLine(added[0], 70)}${noteLine}`;
    }
    const song = added[0];
    const duration = song.isLive ? 'LIVE' : formatDur(song.duration);
    if (before === 0) return `▶️ Запускаю: ${songLine(song, 80)} · \`${duration}\`${noteLine}`;
    const position = playNext ? 1 : before;
    return `➕ В очередь (#${position}): ${songLine(song, 80)} · \`${duration}\`${noteLine}`;
  }

  async #cmdLeave(interaction) {
    const guildId = interaction.guildId;
    const botChannel = interaction.guild.members.me?.voice?.channel;
    if (!botChannel) {
      try { this.distube.voices.leave(guildId); } catch { /* уже отключён */ }
      return this.#say(interaction, 'ℹ️ P3W уже не подключён к голосовому каналу.');
    }
    if (interaction.member?.voice?.channel?.id !== botChannel.id) {
      return this.#say(interaction, '❌ Чтобы отключить P3W, зайди в тот же голосовой канал.');
    }
    await interaction.deferReply();
    const queue = this.distube.getQueue(guildId);
    if (queue) await queue.stop().catch(err => console.error('Music leave error:', err));
    try { this.distube.voices.leave(guildId); } catch { /* уже отключён */ }
    return interaction.editReply({ content: '👋 Отключился от голосового канала.' });
  }

  async #cmdTest(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return this.#say(interaction, '❌ Эта команда только для администраторов.');
    }
    await interaction.deferReply({ flags: EPHEMERAL });
    const lines = await this.runDiagnostics();
    const embed = new EmbedBuilder()
      .setColor(lines.some(line => line.startsWith('❌')) ? COLORS.error : COLORS.ok)
      .setTitle('🎵 Проверка музыкальных источников')
      .setDescription(clampText(lines.join('\n'), 3900));
    return interaction.editReply({ embeds: [embed] });
  }

  // ───── кнопки и выпадающие списки ─────

  async #handleComponent(interaction) {
    const [, action, arg] = interaction.customId.split(':');
    const queue = this.distube.getQueue(interaction.guildId);

    if (!queue) {
      // Панель устарела: гасим кнопки и сообщаем об этом.
      if (interaction.isButton() && interaction.message?.editable) {
        await interaction.update(renderIdle('⏹️ Плеер не активен. Запусти трек командой /play.')).catch(() => {});
      } else {
        await this.#say(interaction, 'ℹ️ Сейчас ничего не играет. Запусти трек командой /play.');
      }
      return undefined;
    }

    const memberVoice = interaction.member?.voice?.channel;
    if (!memberVoice || memberVoice.id !== queue.voiceChannel?.id) {
      return this.#say(interaction, '❌ Зайди в тот же голосовой канал, где сейчас находится P3W.');
    }

    switch (action) {
      case 'toggle':
        if (queue.paused) await queue.resume(); else await queue.pause();
        return interaction.update(renderPanel(queue));
      case 'loop':
        queue.setRepeatMode((queue.repeatMode + 1) % 3);
        return interaction.update(renderPanel(queue));
      case 'shuffle':
        if (queue.songs.length > 2) await queue.shuffle();
        return interaction.update(renderPanel(queue));
      case 'voldown':
      case 'volup': {
        const delta = action === 'volup' ? VOLUME_STEP : -VOLUME_STEP;
        queue.setVolume(clamp(queue.volume + delta, 1, VOLUME_MAX));
        return interaction.update(renderPanel(queue));
      }
      case 'queue':
        return interaction.reply({ ...renderQueue(queue, 0), flags: EPHEMERAL, allowedMentions: { parse: [] } });
      case 'q':
        return interaction.update(renderQueue(queue, Number(arg) || 0));
      case 'skip':
        if (queue.songs.length < 2 && !queue.autoplay) return this.#say(interaction, 'ℹ️ В очереди нет следующего трека.');
        await interaction.deferUpdate();
        return this.#guarded(interaction, () => queue.skip());
      case 'prev':
        if (!queue.previousSongs?.length) return this.#say(interaction, 'ℹ️ Предыдущего трека нет.');
        await interaction.deferUpdate();
        return this.#guarded(interaction, () => queue.previous());
      case 'stop':
        await interaction.deferUpdate();
        return this.#guarded(interaction, () => queue.stop());
      case 'leave':
        await interaction.deferUpdate();
        return this.#guarded(interaction, async () => {
          await queue.stop();
          try { this.distube.voices.leave(interaction.guildId); } catch { /* уже отключён */ }
        });
      case 'jump': {
        const index = Number(interaction.values?.[0]);
        if (!Number.isInteger(index) || index < 1 || index >= queue.songs.length) {
          return interaction.update({ ...renderQueue(queue, 0), allowedMentions: { parse: [] } });
        }
        await interaction.update({ content: '⏭️ Перехожу к выбранному треку…', embeds: [], components: [] });
        return this.#guarded(interaction, () => queue.jump(index));
      }
      default:
        return this.#say(interaction, '❓ Неизвестная кнопка.');
    }
  }

  // Выполняет действие после deferUpdate; ошибку показываем отдельным сообщением только для нажавшего.
  async #guarded(interaction, action) {
    try {
      await action();
    } catch (err) {
      console.error('Music button error:', JSON.stringify(describeMusicError(err), null, 2));
      await interaction.followUp({ content: formatMusicError(err), flags: EPHEMERAL, allowedMentions: { parse: [] } }).catch(() => {});
    }
  }

  async #controlQueue(interaction) {
    const queue = this.distube.getQueue(interaction.guildId);
    if (!queue) {
      await this.#say(interaction, 'ℹ️ Сейчас ничего не играет. Запусти трек командой /play.');
      return null;
    }
    const memberVoice = interaction.member?.voice?.channel;
    if (!memberVoice || memberVoice.id !== queue.voiceChannel?.id) {
      await this.#say(interaction, '❌ Зайди в тот же голосовой канал, где сейчас находится P3W.');
      return null;
    }
    return queue;
  }

  async #say(interaction, content, ephemeral = true) {
    const payload = { content, allowedMentions: { parse: [] } };
    if (interaction.isMessageComponent?.() && (interaction.deferred || interaction.replied)) {
      return interaction.followUp({ ...payload, flags: EPHEMERAL });
    }
    if (interaction.deferred && !interaction.replied) return interaction.editReply(payload);
    if (interaction.replied) return interaction.followUp({ ...payload, ...(ephemeral ? { flags: EPHEMERAL } : {}) });
    return interaction.reply({ ...payload, ...(ephemeral ? { flags: EPHEMERAL } : {}) });
  }

  // ───── панель плеера ─────

  // Операции с сообщением-панелью идут по очереди, чтобы быстрые «скип-скип-скип» не плодили дубли.
  #serial(guildId, task) {
    const previous = this.locks.get(guildId) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    this.locks.set(guildId, next.catch(() => {}));
    return next;
  }

  #sendPanel(queue, channel) {
    return this.#serial(queue.id, async () => {
      if (!channel?.send) return;
      const old = this.panels.get(queue.id);
      this.panels.delete(queue.id);
      if (old) await old.delete().catch(() => {});

      const live = this.distube.getQueue(queue.id);
      if (!live || !live.songs.length) return;
      const message = await channel.send({ ...renderPanel(live), allowedMentions: { parse: [] } });
      this.panels.set(queue.id, message);
    });
  }

  #refreshPanel(guildId) {
    return this.#serial(guildId, async () => {
      const message = this.panels.get(guildId);
      if (!message) return;
      const queue = this.distube.getQueue(guildId);
      if (!queue) return;
      await message.edit(renderPanel(queue)).catch(err => {
        if (err?.code === 10008) this.panels.delete(guildId); // сообщение удалили вручную
      });
    });
  }

  #endPanel(guildId, text) {
    return this.#serial(guildId, async () => {
      const message = this.panels.get(guildId);
      if (!message) return;
      this.panels.delete(guildId);
      await message.edit(renderIdle(text)).catch(() => {});
    });
  }

  // ───── диагностика голоса: почему «играет», а звука нет ─────

  // Пишет в лог каждый переход состояния голосового соединения и плеера.
  #traceVoice(queue) {
    const voice = queue.voice;
    if (!voice || voice.__p3wTraced) return;
    voice.__p3wTraced = true;
    voice.connection?.on('stateChange', (from, to) => {
      console.log(`🔌 voice connection ${from.status} -> ${to.status}${to.reason !== undefined ? ` (reason ${to.reason}${to.closeCode ? `, close ${to.closeCode}` : ''})` : ''}`);
    });
    voice.audioPlayer?.on('stateChange', (from, to) => {
      const ending = to.status === 'idle' && from.status !== 'idle';
      const detail = ending
        ? ` · reason=${to.reason || 'unknown'}, playedMs=${from.resource?.playbackDuration ?? 0}, ffmpegExit=${voice.stream?.process?.exitCode ?? 'unknown'}, ffmpegSignal=${voice.stream?.process?.signalCode ?? 'none'}`
        : '';
      console.log(`🎚️ audio player ${from.status} -> ${to.status}${detail}`);
    });
  }

  // Через несколько секунд после старта трека проверяем всю цепочку и называем причину тишины.
  #watchPlayback(queue, song) {
    const timer = setTimeout(() => {
      const report = this.#inspectPlayback(queue, song);
      if (!report) return;
      console.log(`🔎 playback check: ${JSON.stringify(report.state)}`);
      if (report.problem) {
        console.warn(`⚠️ playback problem: ${report.problem}`);
        queue.textChannel?.send({ content: `⚠️ ${report.problem}`, allowedMentions: { parse: [] } }).catch(() => {});
      }
    }, PLAYBACK_CHECK_MS);
    timer.unref?.();
  }

  #inspectPlayback(queue, song) {
    const live = this.distube.getQueue(queue.id);
    if (!live || live.songs[0] !== song || live.paused) return null; // трек уже сменили или поставили на паузу
    const voice = live.voice;
    const me = live.clientMember?.voice;
    const connection = voice?.connection?.state?.status;
    const player = voice?.audioPlayer?.state?.status;
    const played = voice?.stream?.audioResource?.playbackDuration ?? 0;
    const ffmpeg = voice?.stream?.process;
    const state = {
      connection,
      player,
      playedMs: played,
      ffmpegExit: ffmpeg?.exitCode ?? null,
      selfMute: me?.selfMute,
      selfDeaf: me?.selfDeaf,
      serverMute: me?.serverMute,
      suppress: me?.suppress,
      channel: live.voiceChannel?.id,
    };

    let problem = null;
    if (connection && connection !== 'ready') {
      problem = `Голосовое соединение не готово (статус «${connection}»), поэтому звука нет. Попробуй /leave и снова /play. Если повторяется, на хостинге блокируется UDP или не работает шифрование голоса (подробности в логах).`;
    } else if (me?.serverMute || me?.suppress) {
      problem = 'P3W заглушён на сервере (Server Mute / «подавлен»): в канале его не слышно. Снимите заглушение у бота или выдайте право «Говорить» в этом канале.';
    } else if (me?.selfMute) {
      problem = 'P3W остаётся в режиме «микрофон выключен», поэтому его не слышно. Попробуй /leave и снова /play.';
    } else if (ffmpeg && ffmpeg.exitCode !== null && ffmpeg.exitCode !== 0) {
      problem = `ffmpeg завершился с ошибкой (код ${ffmpeg.exitCode}), звука нет. Подробности в логах (строки [ffmpeg]).`;
    } else if (player === 'playing' && played === 0) {
      problem = 'Плеер «играет», но звук не поступает: ffmpeg не отдаёт данные (источник не открылся или не работает Opus-кодек на сервере). Подробности в логах.';
    } else if (player !== 'playing') {
      problem = `Плеер в состоянии «${player}», звук не идёт. Подробности в логах.`;
    }
    return { state, problem };
  }

  // ───── таймеры: пустой канал и простой ─────

  #clearTimer(map, key) {
    const timer = map.get(key);
    if (timer) clearTimeout(timer);
    map.delete(key);
  }

  #checkEmptyChannel(guild) {
    const botChannel = guild.members.me?.voice?.channel;
    if (!botChannel) {
      this.#clearTimer(this.emptyTimers, guild.id);
      return;
    }
    const humans = botChannel.members.filter(member => !member.user.bot).size;
    if (humans > 0) {
      this.#clearTimer(this.emptyTimers, guild.id);
      return;
    }
    if (this.emptyTimers.has(guild.id)) return;

    const timer = setTimeout(async () => {
      this.emptyTimers.delete(guild.id);
      const channel = guild.members.me?.voice?.channel;
      if (!channel || channel.members.some(member => !member.user.bot)) return;
      const queue = this.distube.getQueue(guild.id);
      const textChannel = queue?.textChannel;
      if (queue) await queue.stop().catch(() => {});
      try { this.distube.voices.leave(guild.id); } catch { /* уже отключён */ }
      textChannel?.send({ content: '👋 В голосовом канале никого нет — отключаюсь.', allowedMentions: { parse: [] } }).catch(() => {});
    }, EMPTY_CHANNEL_LEAVE_MS);
    timer.unref?.();
    this.emptyTimers.set(guild.id, timer);
  }

  #scheduleIdleLeave(guildId) {
    this.#clearTimer(this.idleTimers, guildId);
    const timer = setTimeout(() => {
      this.idleTimers.delete(guildId);
      if (this.distube.getQueue(guildId)) return;
      try { this.distube.voices.leave(guildId); } catch { /* уже отключён */ }
    }, IDLE_LEAVE_MS);
    timer.unref?.();
    this.idleTimers.set(guildId, timer);
  }

  #cancelIdleLeave(guildId) {
    this.#clearTimer(this.idleTimers, guildId);
  }
}

function createMusic(client, config = {}) {
  return new MusicModule(client, config);
}

module.exports = {
  createMusic,
  MusicModule,
  // Экспорт для тестов и диагностики.
  describeMusicError,
  formatMusicError,
  StreamBridge,
  primeStream,
  buildFallbackQuery,
  pickBestMatch,
  renderPanel,
  renderQueue,
  renderIdle,
  P3WYouTubePlugin,
};
