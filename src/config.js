require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Не хватает переменной окружения: ${name}`);
  return value;
}

function parseList(value, fallback) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .concat(Array.isArray(fallback) ? fallback : [])
    .filter((item, index, arr) => arr.indexOf(item) === index);
}

module.exports = {
  TOKEN: required('TOKEN'),
  CLIENT_ID: required('CLIENT_ID'),
  GUILD_ID: required('GUILD_ID'),
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
  GEMINI_IMAGE_MODELS: parseList(process.env.GEMINI_IMAGE_MODELS, [
    'gemini-3.1-flash-image',
    'gemini-2.5-flash-image',
    'gemini-3-pro-image',
  ]),
  BASE_STYLE_PROMPT: process.env.BASE_STYLE_PROMPT || '',
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  SUPABASE_TABLE: process.env.SUPABASE_TABLE || 'bot_state',
  SUPABASE_ROW_ID: process.env.SUPABASE_ROW_ID || 'main',
  PREFIX: process.env.PREFIX || '!',
};
