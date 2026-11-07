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
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
  GEMINI_CHAT_MODELS: parseList(process.env.GEMINI_CHAT_MODELS, [
    process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.0-flash',
  ]),
  GEMINI_IMAGE_MODELS: parseList(process.env.GEMINI_IMAGE_MODELS, ['gemini-2.5-flash-image']),
  BASE_PROMPT: process.env.BASE_PROMPT || process.env.BASE_STYLE_PROMPT || '',
  PREFIX: process.env.PREFIX || '!',
  CONTEXT_MAX_TURNS: num(process.env.CONTEXT_MAX_TURNS, 25),
  CONTEXT_SUMMARY_EVERY: num(process.env.CONTEXT_SUMMARY_EVERY, 30),
  AI_USER_COOLDOWN_MS: num(process.env.AI_USER_COOLDOWN_MS, 4000),
  IMAGE_USER_COOLDOWN_MS: num(process.env.IMAGE_USER_COOLDOWN_MS, 20000),

  // Хранилище
  SUPABASE_URL: cleanEnv(process.env.SUPABASE_URL),
  SUPABASE_SERVICE_ROLE_KEY: cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY),
  SUPABASE_TABLE: process.env.SUPABASE_TABLE || 'bot_state',
  SUPABASE_ROW_ID: process.env.SUPABASE_ROW_ID || 'main',

  // Защищённый endpoint для внешнего сборщика игровых новостей
  GAME_NEWS_API_KEY: cleanEnv(process.env.GAME_NEWS_API_KEY),
};
