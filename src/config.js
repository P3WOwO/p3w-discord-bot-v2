require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Не хватает переменной окружения: ${name}`);
  return value;
}

function parseList(value, fallback = []) {
  const items = String(value || '').split(',').map(s => s.trim()).filter(Boolean);
  return [...new Set([...items, ...fallback])];
}

const DEFAULT_GEMINI_CHAT_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemma-4-31b-it',
  'gemma-4-26b-a4b-it',
];

function cleanEnv(value) {
  return String(value || '').trim().replace(/^["'`]+/, '').replace(/["'`]+$/, '').trim();
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

module.exports = {
  TOKEN: required('TOKEN'),
  CLIENT_ID: required('CLIENT_ID'),
  GUILD_ID: process.env.GUILD_ID || '',

  // ИИ
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  // Kept as a compatibility alias; Render's GEMINI_MODEL env var is intentionally ignored.
  GEMINI_MODEL: DEFAULT_GEMINI_CHAT_MODELS[0],
  // Preserve custom models as extra fallbacks, after the recommended free-tier chain.
  GEMINI_CHAT_MODELS: [...new Set([
    ...DEFAULT_GEMINI_CHAT_MODELS,
    ...String(process.env.GEMINI_CHAT_MODELS || '').split(',').map(s => s.trim()).filter(Boolean),
  ])],
  GEMINI_IMAGE_MODELS: parseList(process.env.GEMINI_IMAGE_MODELS, ['gemini-2.5-flash-image']),
  BASE_PROMPT: process.env.BASE_PROMPT || process.env.BASE_STYLE_PROMPT || '',
  PREFIX: process.env.PREFIX || '!',
  CONTEXT_MAX_TURNS: num(process.env.CONTEXT_MAX_TURNS, 18),
  CONTEXT_SUMMARY_EVERY: num(process.env.CONTEXT_SUMMARY_EVERY, 24),
  AI_USER_COOLDOWN_MS: num(process.env.AI_USER_COOLDOWN_MS, 4000),
  IMAGE_USER_COOLDOWN_MS: num(process.env.IMAGE_USER_COOLDOWN_MS, 20000),

  // YouTube: необязательный Cookie header, только через секрет Render.
  YT_COOKIE: cleanEnv(process.env.YT_COOKIE),

  // Яндекс Музыка: оба значения должны принадлежать одному аккаунту.
  YANDEX_MUSIC_OAUTH_TOKEN: cleanEnv(process.env.YANDEX_MUSIC_OAUTH_TOKEN),
  YANDEX_MUSIC_UID: (() => {
    const uid = Number(cleanEnv(process.env.YANDEX_MUSIC_UID));
    return Number.isSafeInteger(uid) && uid > 0 ? uid : 0;
  })(),

  // Хранилище
  SUPABASE_URL: cleanEnv(process.env.SUPABASE_URL),
  SUPABASE_SERVICE_ROLE_KEY: cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY),
  SUPABASE_TABLE: process.env.SUPABASE_TABLE || 'bot_state',
  SUPABASE_ROW_ID: process.env.SUPABASE_ROW_ID || 'main',

  // Защищённый endpoint для внешнего сборщика игровых новостей
  GAME_NEWS_API_KEY: cleanEnv(process.env.GAME_NEWS_API_KEY),
  // Резервный канал из последней подтверждённой публикации; /news channel может его переопределить.
  GAME_NEWS_CHANNEL_ID: cleanEnv(process.env.GAME_NEWS_CHANNEL_ID) || '1568708487440244796',
};
