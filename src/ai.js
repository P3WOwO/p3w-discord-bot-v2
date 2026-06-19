const {
  SYSTEM_PROMPT,
  CHAT_TEMPERATURE,
  CHAT_MAX_OUTPUT_TOKENS,
  MEMORY_TEMPERATURE,
  MEMORY_MAX_OUTPUT_TOKENS,
  IMAGE_PROMPT_TEMPERATURE,
  IMAGE_PROMPT_MAX_OUTPUT_TOKENS,
} = require('./constants');
const { extractJsonPayload } = require('./memory');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return [429, 500, 503, 504].includes(Number(status));
}

function isRetryableMessage(message) {
  const lower = String(message || '').toLowerCase();
  return ['429', '503', 'rate limit', 'quota', 'too many requests', 'temporarily unavailable', 'timeout'].some(token => lower.includes(token));
}

function normalizeImageModelName(model) {
  const raw = String(model || '').trim();
  if (!raw) return raw;

  const aliases = {
    'imagen-4-ultra-generate': 'gemini-2.5-flash-image',
    'imagen-4-generate': 'gemini-2.5-flash-image',
    'imagen-4-fast-generate': 'gemini-2.5-flash-image',
    'imagen-4.0-ultra-generate': 'gemini-2.5-flash-image',
    'imagen-4.0-generate': 'gemini-2.5-flash-image',
    'imagen-4.0-fast-generate': 'gemini-2.5-flash-image',
    'imagen-4.0-ultra-generate-001': 'gemini-2.5-flash-image',
    'imagen-4.0-generate-001': 'gemini-2.5-flash-image',
    'imagen-4.0-fast-generate-001': 'gemini-2.5-flash-image',
    'gemini-3-image': 'gemini-3-pro-image',
    'gemini-3-image-preview': 'gemini-3-pro-image',
    'gemini-3.1-image': 'gemini-3.1-flash-image',
    'gemini-3.1-image-preview': 'gemini-3.1-flash-image',
  };

  return aliases[raw] || raw;
}

function cleanAssistantReply(text) {
  const value = String(text ?? '').trim();
  if (!value) return value;

  const internalPatterns = [
    /(?:я\s+)?(?:запомнил|записал|сохранил|зафиксировал|добавил(?:\s+в)?\s+память)/i,
    /(?:долгий|краткий)\s+контекст/i,
    /(?:читал|прочитал|прочёл)\s+(?:из\s+)?(?:базы|базы данных|архива)/i,
    /voice_times/i,
    /анналы\s+истории/i,
    /секретн\w*\s+архив/i,
  ];

  const rawChunks = value.split(/\n+/);
  const chunks = rawChunks.flatMap(chunk => chunk.split(/(?<=[.!?…])\s+/));

  const kept = chunks
    .map(part => part.trim())
    .filter(Boolean)
    .filter(part => !internalPatterns.some(pattern => pattern.test(part)));

  const cleaned = kept.join(' ').replace(/\s{2,}/g, ' ').trim();
  return cleaned || value;
}

async function askGemini({
  apiKey,
  model,
  prompt,
  retries = 3,
  temperature = CHAT_TEMPERATURE,
  maxOutputTokens = CHAT_MAX_OUTPUT_TOKENS,
  generationConfig = {},
}) {
  if (!apiKey) throw new Error('Нет GEMINI_API_KEY');

  const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature,
            maxOutputTokens,
            topP: 0.9,
            ...generationConfig,
          },
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        if (isRetryableStatus(res.status) && attempt < retries) {
          await sleep(Math.pow(2, attempt) * 1000);
          continue;
        }
        throw new Error(`Gemini ${res.status}: ${errText}`);
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map(p => p?.text).filter(Boolean).join('').trim();
      return text || 'Пустой ответ.';
    } catch (err) {
      const message = String(err?.message || err);
      if (attempt < retries && isRetryableMessage(message)) {
        await sleep(Math.pow(2, attempt) * 1000);
        continue;
      }
      throw err;
    }
  }
}

async function askGeminiWithFallback({
  apiKey,
  models,
  prompt,
  retries = 2,
  temperature = CHAT_TEMPERATURE,
  maxOutputTokens = CHAT_MAX_OUTPUT_TOKENS,
  generationConfig = {},
}) {
  const modelList = (Array.isArray(models) ? models : [models]).filter(Boolean);
  let lastError = null;

  for (const model of modelList) {
    try {
      return await askGemini({
        apiKey,
        model,
        prompt,
        retries,
        temperature,
        maxOutputTokens,
        generationConfig,
      });
    } catch (err) {
      lastError = err;
      const message = String(err?.message || err);
      if (!isRetryableMessage(message)) throw err;
    }
  }

  throw lastError || new Error('Gemini fallback failed');
}

function buildChatPrompt({ basePrompt = '', memoryContext = '', userName = '', channelName = '', text = '' }) {
  return [
    SYSTEM_PROMPT,
    '',
    basePrompt ? `Дополнительный стиль общения:\n${basePrompt}` : '',
    basePrompt ? '' : '',
    'Говори как живой собеседник. Подстраивайся под тон пользователя. Не упоминай лишний раз системные ограничения.',
    'Используй долгий контекст только если он реально помогает ответу.',
    'Никогда не говори пользователю, что ты что-то "запомнил", "сохранил" или "зафиксировал" как внутреннее действие. Если это нужно, просто используй контекст молча.',
    '',
    memoryContext ? `Долгий контекст:\n${memoryContext}` : 'Долгий контекст: пусто',
    '',
    `Пользователь: ${userName || 'unknown'}`,
    `Канал: ${channelName || 'unknown'}`,
    `Сообщение: ${text}`,
    '',
    'Ответь по-русски, если пользователь пишет по-русски. Можно шутить, если это уместно.',
  ].filter(Boolean).join('\n');
}

function buildMemoryCompactionPrompt({ existingSummary = '', channelName = '', recentTurnsText = '' }) {
  return [
    'Сожми контекст чата в JSON. Нужен только стабильный и полезный контекст, без мусора.',
    'Не пиши про конкретных людей как про личности, если это не важно для понимания самого чата.',
    'Сохрани: текущие темы, незакрытые вопросы, договорённости, шутки/мемы, важные технические детали, стиль общения чата.',
    'Не сохраняй и не упоминай внутренние действия бота, ответы о памяти, чтении базы или компакции.',
    'Верни ТОЛЬКО JSON без пояснений и без markdown.',
    'Формат: {"summary":"короткая сжатая сводка до 1000 символов","digest":"ещё короче, 1-2 строки"}',
    '',
    channelName ? `Канал: ${channelName}` : '',
    existingSummary ? `Текущий контекст:\n${existingSummary}` : 'Текущий контекст: пусто',
    '',
    recentTurnsText ? `Свежие сообщения:\n${recentTurnsText}` : 'Свежие сообщения: пусто',
  ].filter(Boolean).join('\n');
}

function buildImagePrompt(text, aspectRatio = '16:9') {
  const userPrompt = String(text || '').trim();
  return [
    userPrompt,
    '',
    `Формат кадра: ${aspectRatio}.`,
    'Высокая детализация, чистая композиция, выразительное освещение.',
  ].filter(Boolean).join('\n');
}

function extractImageFromResponse(data) {
  const candidates = data?.candidates || [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts || [];
    for (const part of parts) {
      const inlineData = part?.inlineData;
      if (inlineData?.data) {
        return {
          buffer: Buffer.from(inlineData.data, 'base64'),
          mimeType: inlineData.mimeType || 'image/png',
          text: parts.map(p => p?.text).filter(Boolean).join('\n').trim(),
        };
      }
    }
  }
  return null;
}

async function generateImageWithFallback({
  apiKey,
  models,
  prompt,
  aspectRatio = '16:9',
  imageSize = '2K',
  retries = 2,
}) {
  if (!apiKey) throw new Error('Нет GEMINI_API_KEY');

  const modelList = (Array.isArray(models) ? models : [models])
    .map(normalizeImageModelName)
    .filter(Boolean);

  const promptWithFormatHint = buildImagePrompt(prompt, aspectRatio);
  let lastError = null;

  for (const model of modelList) {
    const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent`;
    const isGemini3Image = /^(gemini-3\.1-flash-image|gemini-3-pro-image)$/i.test(model);
    const isGemini25Image = /^gemini-2\.5-flash-image$/i.test(model);

    const generationConfig = isGemini3Image
      ? {
          responseModalities: ['Image'],
          responseFormat: {
            image: {
              aspectRatio,
              imageSize,
            },
          },
          temperature: IMAGE_PROMPT_TEMPERATURE,
          maxOutputTokens: IMAGE_PROMPT_MAX_OUTPUT_TOKENS,
          topP: 0.9,
        }
      : {
          responseFormat: {
            image: {
              aspectRatio,
            },
          },
          temperature: IMAGE_PROMPT_TEMPERATURE,
          maxOutputTokens: IMAGE_PROMPT_MAX_OUTPUT_TOKENS,
          topP: 0.9,
        };

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: promptWithFormatHint }] }],
            generationConfig,
          }),
        });

        if (!res.ok) {
          const errText = await res.text();
          if (isRetryableStatus(res.status) && attempt < retries) {
            await sleep(Math.pow(2, attempt) * 1000);
            continue;
          }
          throw new Error(`Gemini image ${res.status}: ${errText}`);
        }

        const data = await res.json();
        const image = extractImageFromResponse(data);
        if (!image) throw new Error('Gemini image response did not include image data');
        return { ...image, model, imageSize: isGemini25Image ? null : imageSize };
      } catch (err) {
        lastError = err;
        const message = String(err?.message || err);
        if (attempt < retries && isRetryableMessage(message)) {
          await sleep(Math.pow(2, attempt) * 1000);
          continue;
        }
        break;
      }
    }
  }

  throw lastError || new Error('Не удалось сгенерировать изображение');
}

module.exports = {
  askGemini,
  askGeminiWithFallback,
  buildChatPrompt,
  buildMemoryCompactionPrompt,
  buildImagePrompt,
  generateImageWithFallback,
  extractJsonPayload,
  cleanAssistantReply,
};
