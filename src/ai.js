const {
  SYSTEM_PROMPT,
  MEMORY_CHAT_TEMPERATURE,
  MEMORY_MAX_OUTPUT_TOKENS,
  MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS,
  MEMORY_EXTRACTION_MODEL_TEMPERATURE,
} = require('./constants');
const {
  buildMemoryExtractionPrompt,
  extractJsonPayload,
} = require('./memory');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return [429, 500, 503, 504].includes(Number(status));
}

function isRetryableMessage(message) {
  const lower = String(message || '').toLowerCase();
  return [
    '429',
    '503',
    'rate limit',
    'quota',
    'too many requests',
    'temporarily unavailable',
    'fetch',
    'timeout',
  ].some(token => lower.includes(token));
}

async function askGemini({
  apiKey,
  model,
  prompt,
  retries = 3,
  temperature = MEMORY_CHAT_TEMPERATURE,
  maxOutputTokens = MEMORY_MAX_OUTPUT_TOKENS,
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
            maxOutputTokens,
            temperature,
            topP: 0.9,
            ...generationConfig,
          },
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        if (isRetryableStatus(res.status) && attempt < retries) {
          const delay = Math.pow(2, attempt) * 1000;
          await sleep(delay);
          continue;
        }
        throw new Error(`Gemini ${res.status}: ${errText}`);
      }

      const data = await res.json();
      return data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('').trim() || 'Пустой ответ.';
    } catch (err) {
      const message = String(err?.message || err);
      if (attempt < retries && isRetryableMessage(message)) {
        const delay = Math.pow(2, attempt) * 1000;
        await sleep(delay);
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
  temperature = MEMORY_CHAT_TEMPERATURE,
  maxOutputTokens = MEMORY_MAX_OUTPUT_TOKENS,
  generationConfig = {},
}) {
  const modelList = Array.isArray(models) ? models.filter(Boolean) : [models].filter(Boolean);
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

function buildPrompt({ memoryContext = '', recentMessages = [], userName, text, channelName = '', baseStylePrompt = '' }) {
  const memoryBlock = memoryContext
    ? ['Память:', memoryContext]
    : ['Память: пусто'];

  const recentHint = recentMessages.length
    ? `Последний контекст уже учтён в памяти (${recentMessages.length} сообщений).`
    : 'Свежего контекста нет.';

  const styleBlock = baseStylePrompt
    ? ['Базовый стиль общения:', baseStylePrompt]
    : [];

  return [
    SYSTEM_PROMPT,
    '',
    ...styleBlock,
    ...styleBlock.length ? [''] : [],
    'Используй память только если она релевантна текущему вопросу. Если памяти недостаточно или она спорная, уточняй вместо выдумывания.',
    'Не пересказывай память дословно. Применяй её как фон для ответа.',
    'Не делай вид, что у тебя к людям накопились устойчивые симпатии или антипатии, если это не следует из явных фактов.',
    '',
    ...memoryBlock,
    '',
    recentHint,
    '',
    `Сейчас отвечает ${userName}${channelName ? ` в канале ${channelName}` : ''}: ${text}`,
  ].join('\n');
}

function buildMemoryPrompt({ userName, channelName, userText, botReply, recentMessages = [], existingContext = '' }) {
  return buildMemoryExtractionPrompt({
    userName,
    channelName,
    userText,
    botReply,
    recentMessages,
    existingContext,
  });
}

function parseMemoryUpdate(text) {
  const parsed = extractJsonPayload(text);
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed;
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

  const modelList = Array.isArray(models) ? models.filter(Boolean) : [models].filter(Boolean);
  let lastError = null;

  const promptWithFormatHint = [
    prompt,
    '',
    `Формат изображения: ${aspectRatio}.`,
    imageSize ? `Желаемая детализация: ${imageSize}.` : '',
  ].filter(Boolean).join('\n');

  for (const model of modelList) {
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
            contents: [{ parts: [{ text: promptWithFormatHint }] }],
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
        return { ...image, model };
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
  buildPrompt,
  buildMemoryPrompt,
  parseMemoryUpdate,
  generateImageWithFallback,
  MEMORY_EXTRACTION_MODEL_TEMPERATURE,
  MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS,
};
