require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Не хватает переменной окружения: ${name}`);
  return value;
}

module.exports = {
  TOKEN: required('TOKEN'),
  CLIENT_ID: required('CLIENT_ID'),
  GUILD_ID: required('GUILD_ID'),
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
  GEMINI_MODEL_FALLBACK: process.env.GEMINI_MODEL_FALLBACK || 'gemini-2.5-flash',
  GEMINI_IMAGE_MODEL: process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image',
  GEMINI_IMAGE_MODEL_FALLBACK: process.env.GEMINI_IMAGE_MODEL_FALLBACK || 'gemini-3.1-flash-image',
  BOT_BASE_PROMPT: process.env.BOT_BASE_PROMPT || '',
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  SUPABASE_TABLE: process.env.SUPABASE_TABLE || 'bot_state',
  SUPABASE_ROW_ID: process.env.SUPABASE_ROW_ID || 'main',
  PREFIX: process.env.PREFIX || '!',
};
