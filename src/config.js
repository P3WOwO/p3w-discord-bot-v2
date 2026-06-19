require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Не хватает переменной окружения: ${name}`);
  return value;
}

function parseList(value, fallback = []) {
  const items = String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  const merged = [...items, ...fallback];
  return [...new Set(merged)];
}

module.exports = {
  TOKEN: required('TOKEN'),
  CLIENT_ID: required('CLIENT_ID'),
  GUILD_ID: required('GUILD_ID'),

  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
  GEMINI_CHAT_MODELS: parseList(process.env.GEMINI_CHAT_MODELS, [
    process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.0-flash',
  ]),
  GEMINI_IMAGE_MODELS: parseList(process.env.GEMINI_IMAGE_MODELS, [
    'gemini-3.1-flash-image',
    'gemini-2.5-flash-image',
    'gemini-3-pro-image',
  ]),
  BASE_PROMPT: process.env.BASE_PROMPT || process.env.BASE_STYLE_PROMPT || '',
  PREFIX: process.env.PREFIX || '!',
  MEMORY_COMPACT_AFTER_TURNS: Number(process.env.MEMORY_COMPACT_AFTER_TURNS || 8) || 8,

  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  SUPABASE_TABLE: process.env.SUPABASE_TABLE || 'bot_state',
  SUPABASE_ROW_ID: process.env.SUPABASE_ROW_ID || 'main',
};
