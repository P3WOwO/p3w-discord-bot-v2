const { SYSTEM_PROMPT, CHAT_TEMPERATURE, CHAT_MAX_OUTPUT_TOKENS } = require('./constants');

const API_BASE = 'https://generativelanguage.googleapis.com';
const IMAGEN_PATTERN = /^imagen-/i;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return [429, 500, 503, 504].includes(Number(status));
}

function isRetryableMessage(message) {
  const lower = String(message || '').toLowerCase();
  return ['429', '500', '503', '504', 'rate limit', 'quota', 'too many requests', 'temporarily unavailable', 'timeout'].some(token => lower.includes(token));
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

  const url = `${API_BASE}/v1beta/models/${model}:generateContent`;

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
            topP: 0.95,
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

// ===== Картинки =====

function buildImagePrompt(text, aspectRatio = '16:9') {
  return [
    String(text || '').trim(),
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
      const inlineData = part?.inlineData || part?.inline_data;
      if (inlineData?.data) {
        return {
          buffer: Buffer.from(inlineData.data, 'base64'),
          mimeType: inlineData.mimeType || inlineData.mime_type || 'image/png',
          text: parts.map(p => p?.text).filter(Boolean).join('\n').trim(),
        };
      }
    }
  }
  return null;
}

// Gemini image models (например gemini-2.5-flash-image) — через generateContent.
// Пробуем с imageConfig (пропорции), при отказе API — повторяем без него.
async function generateImageGemini({ apiKey, model, prompt, aspectRatio, retries }) {
  const url = `${API_BASE}/v1beta/models/${model}:generateContent`;
  const configVariants = [
    { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio } },
    { responseModalities: ['TEXT', 'IMAGE'] },
  ];
  let lastError = null;

  for (const generationConfig of configVariants) {
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
            generationConfig,
          }),
        });

        if (!res.ok) {
          const errText = await res.text();
          if (isRetryableStatus(res.status) && attempt < retries) {
            await sleep(Math.pow(2, attempt) * 1000);
            continue;
          }
          throw new Error(`${model} ${res.status}: ${String(errText).slice(0, 300)}`);
        }

        const data = await res.json();
        const image = extractImageFromResponse(data);
        if (!image) throw new Error(`${model}: ответ не содержит изображение`);
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

  throw lastError;
}

// Imagen models (imagen-4.0-generate-001) — отдельный эндпоинт :predict.
async function generateImageImagen({ apiKey, model, prompt, aspectRatio, retries }) {
  const url = `${API_BASE}/v1/models/${model}:predict`;
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          instances: [{ prompt }],
          parameters: {
            sampleCount: 1,
            aspectRatio,
          },
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        if (isRetryableStatus(res.status) && attempt < retries) {
          await sleep(Math.pow(2, attempt) * 1000);
          continue;
        }
        throw new Error(`${model} ${res.status}: ${errText}`);
      }

      const data = await res.json();
      const prediction = data?.predictions?.[0];
      const base64 = prediction?.bytesBase64Encoded || prediction?.image;
      if (!base64) throw new Error(`${model}: ответ не содержит изображение`);
      return {
        buffer: Buffer.from(base64, 'base64'),
        mimeType: prediction?.mimeType || 'image/png',
        text: '',
        model,
      };
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

  throw lastError;
}

async function generateImageWithFallback({ apiKey, models, prompt, aspectRatio = '16:9', retries = 2 }) {
  if (!apiKey) throw new Error('Нет GEMINI_API_KEY');

  const modelList = (Array.isArray(models) ? models : [models]).filter(Boolean);
  const finalPrompt = buildImagePrompt(prompt, aspectRatio);
  const errors = [];

  for (const model of modelList) {
    const isImagen = IMAGEN_PATTERN.test(model);
    try {
      return isImagen
        ? await generateImageImagen({ apiKey, model, prompt: finalPrompt, aspectRatio, retries })
        : await generateImageGemini({ apiKey, model, prompt: finalPrompt, aspectRatio, retries });
    } catch (err) {
      const message = String(err?.message || err).slice(0, 250);
      errors.push(`${model}: ${message}`);
      console.error(`Image model failed: ${model}:`, message);
    }
  }

  // Показываем в чат ошибки всех моделей — так видно, почему упала каждая.
  throw new Error(`Не удалось сгенерировать изображение. Попытки: ${errors.join(' | ')}`);
}

// ===== Промпты чата =====

function buildChatPrompt({ basePrompt = '', chatContext = '', userName = '', channelName = '', text = '' }) {
  return [
    SYSTEM_PROMPT,
    '',
    basePrompt ? `Дополнительный стиль общения:\n${basePrompt}` : '',
    '',
    chatContext ? `Контекст чата:\n${chatContext}` : 'Контекст чата: пусто',
    '',
    `Пользователь: ${userName || 'unknown'}`,
    channelName ? `Канал: ${channelName}` : '',
    `Сообщение: ${text}`,
  ].filter(Boolean).join('\n');
}

// Промпт авто-выжимки старых сообщений (дешёвый вызов раз в N сообщений).
function buildSummaryPrompt({ existingSummary = '', oldMessages = '' }) {
  return [
    'Сожми переписку в очень короткую выжимку (максимум 2-3 предложения).',
    'Сохрани только суть: темы, договорённости, важные факты, внутренние шутки канала.',
    'Без имён-обращений, без оценок, без markdown. Верни только текст выжимки.',
    '',
    existingSummary ? `Текущая выжимка:\n${existingSummary}` : 'Текущая выжимка: пусто',
    '',
    oldMessages ? `Старые сообщения:\n${oldMessages}` : 'Старые сообщения: пусто',
  ].filter(Boolean).join('\n');
}

module.exports = {
  askGemini,
  askGeminiWithFallback,
  buildChatPrompt,
  buildSummaryPrompt,
  buildImagePrompt,
  generateImageWithFallback,
};



