'use strict';

/**
 * Музыкальный модуль P3W.
 *
 * Всё, что относится к музыке, живёт здесь: источники (YouTube / SoundCloud /
 * Spotify / Яндекс Музыка), очередь, слэш-команды, панель управления с кнопками
 * и обработка голосового канала. bot.js только подключает модуль.
 *
 * Как устроен YouTube:
 *   DisTube по умолчанию отдаёт ffmpeg «голую» ссылку googlevideo. Новый YouTube
 *   такие ссылки часто режет (403, SABR, PO-токены), поэтому звук берётся через
 *   ytdl.download() — он сам ходит с нужными заголовками, кусками, перезапрашивает
 *   ссылку при 403 и умеет SABR. Поток отдаётся ffmpeg через локальный мост
 *   (127.0.0.1), а если YouTube не отдал даже первые байты — трек автоматически
 *   ищется на SoundCloud.
 */

const http = require('http');
const { randomBytes } = require('crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
  createAudioResource,
  entersState,
  StreamType,
  VoiceConnectionStatus,
  AudioPlayerStatus,
} = require('@discordjs/voice');
const { OpusEncoder } = require('@discordjs/opus');
const { DisTube, RepeatMode } = require('distube');
const { YouTubePlugin, YouTubeSong } = require('@distube/youtube');
const { Quality, parseVideoId, parsePlaylistId } = require('@distube/ytdl-core');
const { SpotifyPlugin } = require('@distube/spotify');
const { SoundCloudPlugin } = require('@distube/soundcloud');
const SoundCloudReadable = require('@zibot/scdl');
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
const PLAYBACK_CHECK_MS = 4000;
const SELF_TEST_VIDEO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const MUSIC_DIAG_SOUNDCLOUD_URL = 'https://soundcloud.com/overtonightofficial/mirrors-demo';

function safeStreamUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

async function readResponsePrefix(response, maxBytes = 64 * 1024) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (length < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const part = Buffer.from(value).subarray(0, maxBytes - length);
      chunks.push(part);
      length += part.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, length);
}

async function inspectSoundCloudHls(url, depth = 0) {
  if (depth > 2) throw new Error('SoundCloud HLS playlist nesting exceeds 2');
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(10000),
  });
  const contentType = response.headers.get('content-type') || 'unknown';
  const body = await readResponsePrefix(response);
  const prefix = body.subarray(0, 7).toString('utf8');
  const base = {
    status: response.status,
    contentType,
    finalUrl: safeStreamUrl(response.url),
    bytesRead: body.length,
    firstBytesHex: body.subarray(0, 16).toString('hex'),
  };
  if (!response.ok) throw new Error(`SoundCloud input HTTP ${response.status} · ${JSON.stringify(base)}`);
  if (!prefix.startsWith('#EXTM3U') && !contentType.toLowerCase().includes('mpegurl')) {
    return { ...base, format: 'direct-audio-or-binary' };
  }

  const lines = body.toString('utf8').split('\n').map(line => line.replaceAll('\r', '').trim());
  const variantIndex = lines.findIndex(line => line.startsWith('#EXT-X-STREAM-INF'));
  if (variantIndex >= 0) {
    const variant = lines.slice(variantIndex + 1).find(line => line && !line.startsWith('#'));
    if (!variant) throw new Error('SoundCloud master playlist has no variant URL');
    const nested = await inspectSoundCloudHls(new URL(variant, response.url).toString(), depth + 1);
    return { ...base, format: 'hls-master', nested };
  }

  const keyLine = lines.find(line => line.startsWith('#EXT-X-KEY')) || '';
  const mapLine = lines.find(line => line.startsWith('#EXT-X-MAP')) || '';
  const mapMatch = mapLine.match(/URI="([^"]+)"/);
  const segmentIndex = lines.findIndex(line => line.startsWith('#EXTINF'));
  const segmentPath = segmentIndex >= 0
    ? lines.slice(segmentIndex + 1).find(line => line && !line.startsWith('#'))
    : lines.find(line => line && !line.startsWith('#'));
  const readAsset = async (relative, label) => {
    if (!relative) return null;
    const assetUrl = new URL(relative, response.url).toString();
    const asset = await fetch(assetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*', Range: 'bytes=0-4095' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    const bytes = await readResponsePrefix(asset, 4096);
    return {
      label,
      status: asset.status,
      contentType: asset.headers.get('content-type') || 'unknown',
      finalUrl: safeStreamUrl(asset.url),
      bytesRead: bytes.length,
      firstBytesHex: bytes.subarray(0, 24).toString('hex'),
      firstBytesAscii: bytes.subarray(0, 12).toString('latin1').replace(/[^\x20-\x7e]/g, '.'),
    };
  };

  return {
    ...base,
    format: 'hls-media',
    hasEncryptionKey: Boolean(keyLine),
    encryptionMethod: keyLine.match(/METHOD=([^,]+)/)?.[1] || null,
    hasInitMap: Boolean(mapMatch),
    initMap: await readAsset(mapMatch?.[1], 'init-map'),
    firstSegment: await readAsset(segmentPath, 'first-segment'),
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

// Заметки про трек (например, «звук взят с SoundCloud»), не засоряя объект Song.
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
  if (/BOT_CHECK|AUTH_FAILED|SIGN_IN|LOGIN_REQUIRED|not a bot/i.test(all)) {
    return '❌ YouTube требует подтвердить, что запросы идут не от бота, а запасной поиск на SoundCloud ничего подходящего не нашёл. Помогает отдельный YT_COOKIE в секретах Render (см. README).';
  }
  if (/AGE_RESTRICTED|PRIVATE|MEMBERS_ONLY|PREMIUM_ONLY|REGION_BLOCKED|UNAVAILABLE_VIDEO|NOT_STARTED/i.test(all)) {
    return '❌ Этот трек недоступен: он приватный, с возрастным ограничением, ограничен по региону или ещё не вышел.';
  }
  if (/RATE_LIMITED|429/i.test(all)) {
    return '❌ Источник временно ограничил запросы. Попробуй немного позже.';
  }
  if (/YT_STREAM_TIMEOUT|YT_STREAM_EMPTY|NO_FORMAT|UNPLAYABLE_FORMATS|PLAYER_SOLVE_FAILED|REQUEST_FAILED/i.test(all)) {
    return '❌ YouTube не отдал аудиопоток, а на SoundCloud такого же трека не нашлось. Попробуй другую ссылку или название, либо подключи YT_COOKIE.';
  }
  if (/NO_RESULT|NOT_FOUND|NO_STREAM_URL|CANNOT_RESOLVE/i.test(code)) {
    return '❌ Не удалось найти трек. Проверь ссылку или попробуй другое название.';
  }
  if (/NOT_SUPPORTED_URL/i.test(code)) {
    return '❌ Эта ссылка не поддерживается. Работают YouTube, SoundCloud, Spotify и Яндекс Музыка.';
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

// Чистим «(Official Video)», «[HD]» и т.п., чтобы поиск на SoundCloud находил больше.
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

// Проверяем, что SoundCloud действительно отдаёт байты медиа, а не только результат поиска.
async function probeHttpStream(url, timeoutMs = 7000, depth = 0) {
  if (typeof url !== 'string' || !(url.startsWith('http://') || url.startsWith('https://'))) {
    throw Object.assign(new Error('SoundCloud returned an invalid stream URL'), { code: 'SOUNDCLOUD_INVALID_STREAM_URL' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader;

  try {
    const response = await fetch(url, {
      headers: { Range: 'bytes=0-65535' },
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw Object.assign(new Error('SoundCloud media returned HTTP ' + response.status), {
        code: 'SOUNDCLOUD_HTTP_ERROR',
        status: response.status,
      });
    }

    if (!response.body) {
      throw Object.assign(new Error('SoundCloud response has no media body'), { code: 'SOUNDCLOUD_STREAM_EMPTY' });
    }

    const contentType = response.headers.get('content-type') || 'unknown';
    reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    let playlist = contentType.toLowerCase().includes('mpegurl');

    // Для HLS читаем небольшой плейлист целиком; для обычного аудио достаточно первого блока.
    while (totalBytes < (playlist ? 128 * 1024 : 4096)) {
      const part = await reader.read();
      if (part.done) break;
      if (part.value && part.value.byteLength) {
        chunks.push(Buffer.from(part.value));
        totalBytes += part.value.byteLength;
      }

      if (!playlist && totalBytes > 0) {
        const prefix = Buffer.concat(chunks, Math.min(totalBytes, 7)).toString('utf8');
        playlist = prefix.startsWith('#EXTM3U');
        if (!playlist) break;
      }
    }

    const body = Buffer.concat(chunks, totalBytes);
    if (!totalBytes) {
      throw Object.assign(new Error('SoundCloud stream returned no media bytes'), { code: 'SOUNDCLOUD_STREAM_EMPTY' });
    }

    if (playlist || body.subarray(0, 7).toString('utf8') === '#EXTM3U') {
      if (depth >= 2) {
        throw Object.assign(new Error('SoundCloud HLS playlist nesting is too deep'), { code: 'SOUNDCLOUD_HLS_INVALID' });
      }

      const lines = body.toString('utf8').split('\n').map(line => line.replaceAll('\r', '').trim());
      const nextUri = index => lines.slice(index + 1).find(line => line && !line.startsWith('#'));
      let mediaPath = null;

      // Master playlist: choose the first variant, then descend into its media playlist.
      const variantIndex = lines.findIndex(line => line.startsWith('#EXT-X-STREAM-INF'));
      if (variantIndex >= 0) mediaPath = nextUri(variantIndex);

      // Media playlist: probe the first actual segment, not the manifest or init-map.
      if (!mediaPath) {
        const segmentIndex = lines.findIndex(line => line.startsWith('#EXTINF'));
        if (segmentIndex >= 0) mediaPath = nextUri(segmentIndex);
      }
      if (!mediaPath) mediaPath = lines.find(line => line && !line.startsWith('#'));

      if (!mediaPath) {
        throw Object.assign(new Error('SoundCloud HLS playlist contains no media segment'), { code: 'SOUNDCLOUD_HLS_SEGMENT_MISSING' });
      }

      const mediaUrl = new URL(mediaPath, response.url).toString();
      const segment = await probeHttpStream(mediaUrl, timeoutMs, depth + 1);
      return {
        ...segment,
        playlistBytes: totalBytes,
        playlistContentType: contentType,
      };
    }

    return {
      status: response.status,
      bytes: totalBytes,
      contentType,
      playlistBytes: 0,
    };
  } catch (err) {
    if (controller.signal.aborted) {
      throw Object.assign(new Error('SoundCloud stream timed out after ' + timeoutMs + ' ms'), {
        code: 'SOUNDCLOUD_STREAM_TIMEOUT',
        cause: err,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (reader) await reader.cancel().catch(() => {});
  }
}

// Проверяем несколько результатов SoundCloud: первый в выдаче не всегда имеет рабочий поток.
async function pickPlayableSoundCloudSong(plugin, candidates, targetDuration = 0) {
  let ranked = Array.isArray(candidates) ? candidates.filter(song => song?.url) : [];

  if (targetDuration > 0) {
    const tolerance = Math.max(8, Math.round(targetDuration * 0.06));
    ranked = ranked
      .map(song => ({ song, diff: Math.abs((Number(song.duration) || 0) - targetDuration) }))
      .filter(item => item.song.duration > 0 && item.diff <= tolerance)
      .sort((a, b) => a.diff - b.diff)
      .map(item => item.song);
  }

  for (const candidate of ranked.slice(0, 5)) {
    try {
      const url = await plugin.getStreamURL(candidate);
      const probe = await probeHttpStream(url);
      return { song: candidate, probe };
    } catch (err) {
      console.warn(`SoundCloud candidate rejected (${candidate.name || candidate.url}):`, briefError(err));
    }
  }

  return null;
}

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

// ───────────────────────────── SoundCloud AAC-HLS → Readable bridge ─────────────────────────────

// @distube/soundcloud resolves and searches tracks, while this maintained stream client
// assembles SoundCloud's AAC HLS init segment + media fragments into one readable stream.
class P3WSoundCloudPlugin extends SoundCloudPlugin {
  constructor(bridge) {
    super();
    this.bridge = bridge;
    this.streamClient = new SoundCloudReadable();
  }

  async getStreamURL(songOrUrl) {
    const trackUrl = typeof songOrUrl === 'string' ? songOrUrl : songOrUrl?.url;
    if (!trackUrl || !/^https?:\/\/(?:www\.)?soundcloud\.com\//i.test(trackUrl)) {
      throw Object.assign(new Error('SoundCloud track URL is missing or invalid'), {
        code: 'SOUNDCLOUD_INVALID_TRACK_URL',
      });
    }

    // downloadTrack() catches and discards every per-format error. Resolve each
    // current SoundCloud transcoding explicitly so logs retain the real failure.
    const track = await this.streamClient.getTrackDetails(trackUrl);
    const transcodings = this.streamClient._getSortedTranscodings(track);
    console.log(`[soundcloud-stream] ${track.title || trackUrl}: policy=${track.policy || 'none'} state=${track.state || 'unknown'} transcodings=${transcodings.length}`);
    console.log('[soundcloud-stream] formats:', JSON.stringify(transcodings.map(item => ({
      protocol: item.format?.protocol || null,
      mime: item.format?.mime_type || null,
      legacy: item.is_legacy_transcoding ?? null,
      preset: item.preset || null,
      endpoint: safeStreamUrl(item.url || ''),
    }))));

    const failures = [];
    for (const transcoding of transcodings) {
      const protocol = transcoding.format?.protocol;
      try {
        const streamUrl = await this.streamClient.getStreamUrl(transcoding.url);
        let stream;
        if (protocol === 'hls') {
          // SoundCloud can return a master playlist. Resolve a media playlist first;
          // @zibot/scdl's low-level fMP4 assembler expects #EXT-X-MAP + #EXTINF.
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
            if (!playlist.includes('#EXTM3U')) throw new Error('HLS endpoint did not return an M3U8 playlist');
            if (!playlist.includes('#EXT-X-STREAM-INF')) break;
            const lines = playlist.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
            const index = lines.findIndex(line => line.startsWith('#EXT-X-STREAM-INF'));
            const variant = index >= 0 ? lines.slice(index + 1).find(line => line && !line.startsWith('#')) : null;
            if (!variant) throw new Error('HLS master playlist has no media variant');
            mediaUrl = new URL(variant, response.request?.res?.responseUrl || mediaUrl).toString();
            if (depth === 2) throw new Error('HLS playlist nesting exceeds 3');
          }
          stream = await this.streamClient._createHlsStream(mediaUrl, 0, { track });
        } else if (protocol === 'progressive') {
          const response = await this.streamClient.http.get(streamUrl, { responseType: 'stream' });
          stream = response.data;
        } else {
          throw new Error(`Unsupported SoundCloud transcoding protocol: ${protocol || 'missing'}`);
        }

        if (stream && typeof stream.pipe === 'function') {
          stream.on('error', error => {
            console.warn(`SoundCloud readable stream error (${track.title || trackUrl}):`, error?.message || error);
          });
          console.log(`[soundcloud-stream] selected ${protocol} ${transcoding.format?.mime_type || 'unknown'}; starting local FFmpeg bridge`);
          await this.bridge.start();
          const bridgeUrl = this.bridge.register(stream, `SoundCloud · ${track.title || trackUrl}`);
          console.log(`[soundcloud-stream] bridge ready: ${safeStreamUrl(bridgeUrl)}`);
          return bridgeUrl;
        }
        throw new Error('SoundCloud transcoding did not return a readable stream');
      } catch (error) {
        const summary = `${protocol || 'unknown'} ${transcoding.format?.mime_type || ''}: ${error?.message || error}`;
        failures.push(summary);
        console.warn('[soundcloud-stream] transcoding failed:', summary);
      }
    }

    throw Object.assign(new Error(
      transcodings.length
        ? `Every SoundCloud transcoding failed: ${failures.join(' | ')}`
        : 'SoundCloud track contains no media.transcodings entries',
    ), { code: 'SOUNDCLOUD_NO_USABLE_TRANSCODING' });
  }
}

// ───────────────────────────── YouTube-плагин с мостом и запасным вариантом ─────────────────────────────

class P3WYouTubePlugin extends YouTubePlugin {
  constructor(options, bridge) {
    super(options);
    this.bridge = bridge;
    this.fallback = null; // SoundCloudPlugin, подставляется после создания
  }

  // Ссылка на ролик: если YouTube не отдаёт данные, берём название через oEmbed и ищем на SoundCloud.
  async resolve(url, options) {
    try {
      return await super.resolve(url, options);
    } catch (err) {
      const singleVideo = !parsePlaylistId(url) && parseVideoId(url);
      if (!singleVideo || !this.fallback) throw err;
      console.warn('YouTube resolve failed, trying SoundCloud by title:', briefError(err));
      const title = await fetchOEmbedTitle(url);
      if (!title) throw err;
      const song = await this.#findSoundCloudSong(title, options).catch(fallbackErr => {
        console.warn('SoundCloud fallback search failed:', briefError(fallbackErr));
        return null;
      });
      if (!song) throw err;
      setNote(song, 'YouTube недоступен: проверенная версия найдена на SoundCloud');
      return song;
    }
  }

  // Текстовый запрос (и подбор трека для Spotify): сначала YouTube, при сбое — SoundCloud.
  async searchSong(query, options) {
    try {
      const song = await super.searchSong(query, options);
      if (song) return song;
    } catch (err) {
      console.warn('YouTube search failed, trying SoundCloud:', briefError(err));
    }
    if (!this.fallback) return null;
    return this.#findSoundCloudSong(query, options).catch(err => {
      console.warn('SoundCloud search failed:', briefError(err));
      return null;
    });
  }

  async #findSoundCloudSong(query, options, targetDuration = 0) {
    const candidates = await this.fallback.search(query, undefined, 8, options || {});
    const selected = await pickPlayableSoundCloudSong(this.fallback, candidates, targetDuration);
    return selected?.song || null;
  }

  async getStreamURL(song) {
    // DisTube может позвать нас для трека другого источника (найденного запасным поиском).
    if (song.plugin && song.plugin !== this) return song.plugin.getStreamURL(song);
    if (!song.url || !parseVideoId(song.url)) {
      throw Object.assign(new Error('Cannot resolve YouTube video'), { code: 'CANNOT_RESOLVE_SONG' });
    }

    try {
      return await this.#prepareStream(song);
    } catch (err) {
      console.warn(`YouTube stream failed for "${song.name}":`, JSON.stringify(describeMusicError(err), null, 2));
      try {
        const alt = await this.#soundCloudStream(song);
        if (alt) return alt;
      } catch (fallbackErr) {
        console.warn('SoundCloud fallback failed:', briefError(fallbackErr));
      }
      throw err;
    }
  }

  async #prepareStream(song) {
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
      // Метаданные не критичны для воспроизведения.
    }

    // Премьеры: ждём начала (но не дольше минуты).
    const wait = Number(info.playableAt) - Date.now();
    if (wait > 0) await sleep(Math.min(wait, 60_000));

    const stream = ytdl.download(info, {
      quality: Quality.HighestAudio,
      filter: AUDIO_FILTERS,
      onRetry: event => console.warn(`YouTube re-resolve (${song.name}): attempt ${event.attempt}, ${event.client}, ${event.reason}`),
    });
    await primeStream(stream);
    await this.bridge.start();
    return this.bridge.register(stream, song.name);
  }

  async #soundCloudStream(song) {
    if (!this.fallback) return null;
    const query = buildFallbackQuery(song);
    if (!query) return null;
    const match = await this.#findSoundCloudSong(query, { member: song.member }, song.duration);
    if (!match) return null;
    const url = await this.fallback.getStreamURL(match);
    if (!url) return null;
    setNote(song, 'YouTube не отдал звук: проверенная версия играет с SoundCloud');
    console.log(`🔁 "${song.name}" → SoundCloud "${match.name}" (поток проверен)`);
    return url;
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
      .addStringOption(o => o.setName('query').setDescription('YouTube, SoundCloud, Spotify, Яндекс Музыка или название трека').setRequired(true).setMaxLength(500))
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
      .addIntegerOption(o => o.setName('percent').setDescription('Громкость от 1 до 100').setRequired(true).setMinValue(1).setMaxValue(100))
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
      .setDescription('Проверить источники музыки (YouTube, SoundCloud) и показать, что сломано')
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

    // Одноразовая автодиагностика по явному флагу Render. Ждём реальной готовности
    // клиента опросом, чтобы не зависеть от порядка регистрации ClientReady listeners.
    console.log(`[music-diag] MUSIC_DIAG_AUTOJOIN=${process.env.MUSIC_DIAG_AUTOJOIN || 'unset'}`);
    if (process.env.MUSIC_DIAG_AUTOJOIN === 'true') {
      const waitForReady = () => {
        if (!client.isReady()) {
          const retry = setTimeout(waitForReady, 1000);
          retry.unref?.();
          return;
        }
        console.log('[music-diag] Discord client ready; startup voice test scheduled');
        setTimeout(() => {
          this.#runStartupVoiceDiagnostic().catch(err => {
            console.error('[music-diag] startup voice test failed:', describeMusicError(err));
          });
        }, 8000);
      };
      const initial = setTimeout(waitForReady, 1000);
      initial.unref?.();
    }
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
    this.youtube.fallback = this.soundcloud;

    const plugins = [this.youtube, this.soundcloud, new SpotifyPlugin()];

    // Яндекс Музыке нужны реальный токен и UID пользователя (хранятся вне репозитория).
    if (this.config.YANDEX_MUSIC_OAUTH_TOKEN && this.config.YANDEX_MUSIC_UID) {
      plugins.push(new YandexMusicPlugin({
        oauthToken: this.config.YANDEX_MUSIC_OAUTH_TOKEN,
        uid: this.config.YANDEX_MUSIC_UID,
      }));
      console.log('✅ Yandex Music source enabled');
    } else {
      console.log('ℹ️ Yandex Music source is installed but disabled: set YANDEX_MUSIC_OAUTH_TOKEN and YANDEX_MUSIC_UID');
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
    const check = async (label, fn) => {
      const started = Date.now();
      try {
        const detail = await fn();
        lines.push(`✅ ${label} — ${Date.now() - started} мс${detail ? ` · ${detail}` : ''}`);
        return true;
      } catch (err) {
        lines.push(`❌ ${label} — ${clampText(briefError(err), 260)}`);
        return false;
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

    let info = null;
    const infoOk = await check('YouTube: данные видео', async () => {
      info = await ytdl.getInfo(SELF_TEST_VIDEO);
      return `${info.formats?.length || 0} форматов`;
    });

    if (infoOk && info) {
      await check('YouTube: аудиопоток', async () => {
        const stream = ytdl.download(info, { quality: Quality.HighestAudio, filter: AUDIO_FILTERS });
        stream.on('error', () => {}); // ошибка уже придёт через primeStream
        try {
          const bytes = await primeStream(stream, 20_000);
          return `первые ${bytes} байт получены`;
        } finally {
          if (!stream.destroyed) stream.destroy();
        }
      });
    } else {
      lines.push('⏭️ YouTube: аудиопоток — пропущен, данные видео не получены');
    }

    let soundCloudCandidates = [];
    await check('SoundCloud: поиск', async () => {
      soundCloudCandidates = await this.soundcloud.search('never gonna give you up', undefined, 6);
      if (!soundCloudCandidates.length) throw new Error('пустая выдача');
      return `${soundCloudCandidates.length} вариантов · ${clampText(soundCloudCandidates[0].name, 40)}`;
    });

    if (soundCloudCandidates.length) {
      await check('SoundCloud: аудиопоток', async () => {
        const selected = await pickPlayableSoundCloudSong(this.soundcloud, soundCloudCandidates);
        if (!selected) {
          throw Object.assign(new Error('Поиск успешен, но ни один из 5 SoundCloud-треков не отдал аудиоданные'), {
            code: 'SOUNDCLOUD_NO_PLAYABLE_STREAM',
          });
        }
        return `${clampText(selected.song.name, 38)} · сегмент ${selected.probe.bytes} байт · HTTP ${selected.probe.status} · ${selected.probe.contentType}${selected.probe.playlistBytes ? ` · HLS ${selected.probe.playlistBytes} байт` : ''}`;
      });
    } else {
      lines.push('⏭️ SoundCloud: аудиопоток — пропущен, результаты поиска не получены');
    }

    lines.push(this.config.YT_COOKIE ? 'ℹ️ YT_COOKIE задан' : 'ℹ️ YT_COOKIE не задан');
    return lines;
  }

  // Автоматическая проверка после деплоя. Подключается только если в GUILD_ID
  // сейчас ровно один занятый обычный voice-канал — не выбирает случайных людей.
  async #runStartupVoiceDiagnostic() {
    const guildId = this.config.GUILD_ID;
    const guild = guildId ? this.client.guilds.cache.get(guildId) : null;
    if (!guild) {
      console.warn('[music-diag] auto-join skipped: configured GUILD_ID is not cached');
      return;
    }

    const forcedChannelId = process.env.MUSIC_DIAG_CHANNEL_ID;
    let channel;
    if (forcedChannelId) {
      channel = guild.channels.cache.get(forcedChannelId)
        || await guild.channels.fetch(forcedChannelId).catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        console.warn(`[music-diag] auto-join skipped: MUSIC_DIAG_CHANNEL_ID ${forcedChannelId} is not a cached/fetchable voice channel`);
        return;
      }
      const permissions = channel.permissionsFor(guild.members.me);
      if (!permissions?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
        console.warn(`[music-diag] auto-join skipped: missing Connect/Speak permission in configured channel ${forcedChannelId}`);
        return;
      }
      console.log(`[music-diag] using configured voice channel "${channel.name}" (${channel.id})`);
    } else {
      const voiceChannels = [...guild.channels.cache.values()].filter(item =>
        item.type === ChannelType.GuildVoice,
      );
      const activeChannels = voiceChannels.filter(item =>
        item.members.some(member => !member.user.bot),
      );

      if (activeChannels.length === 1) {
        channel = activeChannels[0];
      } else if (activeChannels.length === 0) {
        const candidates = voiceChannels
          .filter(item =>
            item.members.size === 0
            && !/afk|away|sleep|сон|неактив/i.test(item.name)
            && item.permissionsFor(guild.members.me)?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]),
          )
          .sort((a, b) => a.rawPosition - b.rawPosition);
        channel = candidates[0];
        if (!channel) {
          console.warn('[music-diag] auto-join skipped: no empty non-AFK voice channel with Connect+Speak permissions');
          return;
        }
        console.log(`[music-diag] no humans online; using empty voice channel "${channel.name}" (${channel.id})`);
      } else {
        console.warn(`[music-diag] auto-join skipped: ${activeChannels.length} occupied voice channels; refusing to interrupt them`);
        return;
      }
    }
    if (this.distube.getQueue(guild.id)) {
      console.warn('[music-diag] auto-join skipped: a music queue is already active');
      return;
    }

    let voice;
    let ffmpeg;
    let playerError;
    const stderr = [];
    const onPlayerError = error => { playerError = error; };
    try {
      console.log(`[music-diag] connecting to occupied voice channel ${channel.id} (${channel.members.filter(m => !m.user.bot).size} human members)`);
      voice = await this.ensureVoice(channel);
      await entersState(voice.connection, VoiceConnectionStatus.Ready, 20_000);
      console.log('[music-diag] voice connection is READY');

      const song = await this.soundcloud.resolve(MUSIC_DIAG_SOUNDCLOUD_URL, {
        member: guild.members.me || undefined,
      });
      const streamUrl = await this.soundcloud.getStreamURL(song);
      console.log(`[music-diag] SoundCloud resolved: ${song.name} · input=${safeStreamUrl(streamUrl)}`);
      console.log('[music-diag] SoundCloud AAC-HLS is assembled by the stream client and handed to FFmpeg through the local bridge');

      ffmpeg = spawn(this.ffmpegPath, [
        '-hide_banner', '-loglevel', 'info', '-nostdin', '-rw_timeout', '15000000',
        '-i', streamUrl,
        '-vn', '-ac', '2', '-ar', '48000', '-t', '5',
        '-f', 's16le', 'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      ffmpeg.stderr.on('data', chunk => {
        const line = String(chunk).trim();
        if (line) {
          stderr.push(line);
          if (stderr.length > 20) stderr.shift();
          console.warn('[music-diag][ffmpeg]', clampText(line, 500));
        }
      });
      const ffmpegClosed = new Promise(resolve => {
        ffmpeg.once('close', (code, signal) => resolve({ code, signal }));
      });

      voice.audioPlayer.on('error', onPlayerError);
      const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
      voice.audioPlayer.play(resource);
      await entersState(voice.audioPlayer, AudioPlayerStatus.Playing, 15_000);
      console.log('[music-diag] audio player entered PLAYING; waiting for real PCM/Opus frames');

      const processResult = await Promise.race([
        ffmpegClosed,
        sleep(9000).then(() => null),
      ]);
      const playedMs = resource.playbackDuration || 0;

      if (playerError) throw playerError;
      if (ffmpeg.signalCode === 'SIGSEGV' || processResult?.signal === 'SIGSEGV') {
        throw new Error('FFmpeg crashed with SIGSEGV while decoding SoundCloud audio');
      }
      if (processResult && processResult.code !== 0) {
        throw new Error(`FFmpeg exited with code ${processResult.code}: ${stderr.join(' | ')}`);
      }
      if (playedMs < 1500) {
        throw new Error(`voice player produced only ${playedMs} ms of playback; expected at least 1500 ms`);
      }
      console.log(`[music-diag] PASS: SoundCloud → system FFmpeg → PCM → Opus → Discord voice; playedMs=${playedMs}, ffmpegExit=${processResult?.code ?? 'still running'}`);
    } catch (err) {
      console.error('[music-diag] FAIL:', describeMusicError(err), {
        ffmpegExit: ffmpeg?.exitCode ?? null,
        ffmpegSignal: ffmpeg?.signalCode ?? null,
        stderr: stderr.join(' | '),
      });
    } finally {
      if (voice?.audioPlayer) {
        voice.audioPlayer.off('error', onPlayerError);
        if (voice.audioPlayer.state.status !== AudioPlayerStatus.Idle) voice.audioPlayer.stop(true);
      }
      if (ffmpeg && ffmpeg.exitCode === null) ffmpeg.kill('SIGTERM');
      try { this.distube.voices.leave(guild.id); } catch { /* already left */ }
      console.log('[music-diag] voice test finished; bot left the channel');
    }
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
        queue.setVolume(clamp(queue.volume + delta, 1, 100));
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
