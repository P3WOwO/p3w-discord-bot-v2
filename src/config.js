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
  GEMINI_CHAT_MODELS: (process.env.GEMINI_CHAT_MODELS || 'gemini-2.5-flash-lite,gemini-2.5-flash,gemini-2.5-pro').split(',').map(s => s.trim()).filter(Boolean),
  GEMINI_IMAGE_MODELS: (process.env.GEMINI_IMAGE_MODELS || 'gemini-3.1-flash-image,gemini-3-pro-image,gemini-2.5-flash-image').split(',').map(s => s.trim()).filter(Boolean),
  GEMINI_IMAGE_ASPECT_RATIO: process.env.GEMINI_IMAGE_ASPECT_RATIO || '16:9',
  GEMINI_IMAGE_SIZE: process.env.GEMINI_IMAGE_SIZE || '2K',
  AI_BASE_PROMPT: process.env.AI_BASE_PROMPT || '',
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  SUPABASE_TABLE: process.env.SUPABASE_TABLE || 'bot_state',
  SUPABASE_ROW_ID: process.env.SUPABASE_ROW_ID || 'main',
  PREFIX: process.env.PREFIX || '!',
};
