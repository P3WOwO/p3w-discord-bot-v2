const {
  SYSTEM_PROMPT,
  DEFAULT_ASSISTANT_BASE_PROMPT,
  MEMORY_CHAT_TEMPERATURE,
  MEMORY_MAX_OUTPUT_TOKENS,
  MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS,
  MEMORY_EXTRACTION_MODEL_TEMPERATURE,
} = require('./constants');
const {
  buildMemoryExtractionPrompt,
  extractJsonPayload,
  truncate,
} = require('./memory');

function normalizeModelList(modelOrModels, fallbackModels = []) {
  const models = Array.isArray(modelOrModels)
    ? modelOrModels
    : String(modelOrModels || '').split(',').map(v => v.trim()).filter(Boolean);
  return [...new Set([...models, ...fallbackModels].filter(Boolean))];
}

function isRetryableModelError(status, message) {
  const lower = String(message || '').toLowerCase();
  return status === 429 || status === 503 || lower.includes('quota') || lower.includes('rate limit') || lower.includes('resource exhausted') || lower.includes('temporarily unavailable') || lower.includes('overloaded');
}

async function generateContentOnce({ apiKey, model, prompt, temperature = MEMORY_CHAT_TEMPERATURE, maxOutputTokens = MEMORY_MAX_OUTPUT_TOKENS, responseModalities = undefined, responseFormat = undefined }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
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
        ...(responseModalities ? { responseModalities } : {}),
        ...(responseFormat ? { responseFormat } : {}),
      },
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Gemini ${res.status}: ${text}`);
  }

  return JSON.parse(text);
}

async function askGemini({ apiKey, model, models, prompt, retries = 3, temperature = MEMORY_CHAT_TEMPERATURE, maxOutputTokens = MEMORY_MAX_OUTPUT_TOKENS }) {
  if (!apiKey) throw new Error('Нет GEMINI_API_KEY');

  const modelList = normalizeModelList(models || model, [model]);
  let lastErr = null;

  for (const currentModel of modelList) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const data = await generateContentOnce({ apiKey, model: currentModel, prompt, temperature, maxOutputTokens });
        const answer = data?.candidates?.[0]?.content?.parts?.map(p => p?.text || '').join('').trim();
        return answer || 'Пустой ответ.';
      } catch (err) {
        lastErr = err;
        const message = String(err?.message || err);
        const status = Number(message.match(/Gemini\s+(\d+)/)?.[1] || 0);
        if (attempt < retries && isRetryableModelError(status, message)) {
          const delay = Math.min(8000, Math.pow(2, attempt) * 1200);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        if (isRetryableModelError(status, message)) break;
        throw err;
      }
    }
  }

  throw lastErr || new Error('Gemini request failed');
}

async function askGeminiWithFallback(args) {
  return askGemini(args);
}

function buildPrompt({
  assistantPrompt = DEFAULT_ASSISTANT_BASE_PROMPT,
  memoryContext = '',
  recentMessages = [],
  userName,
  text,
  channelName = '',
}) {
  const memoryBlock = memoryContext ? ['Память:', memoryContext] : ['Память: пусто'];
  const recentHint = recentMessages.length
    ? `Последний контекст уже учтён в памяти (${recentMessages.length} сообщений).`
    : 'Свежего контекста нет.';

  return [
    assistantPrompt || SYSTEM_PROMPT,
    '',
    'Руководство:',
    '- Подстраивайся под человека, но не теряй свой аккуратный и дружелюбный тон.',
    '- Не придумывай устойчивую ненависть, любовь или предвзятость к людям.',
    '- Если памяти мало, отвечай честно и без выдумок.',
    '- Если нужен промпт для генерации картинки, сначала сделай его ясным и визуальным.',
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

async function generateGeminiImage({ apiKey, models, prompt, aspectRatio = '16:9', imageSize = '2K', retries = 2 }) {
  if (!apiKey) throw new Error('Нет GEMINI_API_KEY');

  const modelList = normalizeModelList(models);
  let lastErr = null;

  for (const model of modelList) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const payload = {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ['IMAGE'],
            responseFormat: {
              image: {
                aspectRatio,
                imageSize,
              },
            },
          },
        };

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify(payload),
        });

        const text = await res.text();
        if (!res.ok) throw new Error(`Gemini ${res.status}: ${text}`);

        const data = JSON.parse(text);
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const inline = parts.find(part => part?.inlineData?.data);
        const textParts = parts.map(part => part?.text).filter(Boolean);
        if (!inline?.inlineData?.data) {
          return {
            model,
            buffer: null,
            mimeType: null,
            text: textParts.join('\n').trim(),
          };
        }

        const mimeType = inline.inlineData.mimeType || 'image/png';
        const buffer = Buffer.from(inline.inlineData.data, 'base64');
        return {
          model,
          buffer,
          mimeType,
          text: textParts.join('\n').trim(),
        };
      } catch (err) {
        lastErr = err;
        const message = String(err?.message || err);
        const status = Number(message.match(/Gemini\s+(\d+)/)?.[1] || 0);
        if (attempt < retries && isRetryableModelError(status, message)) {
          const delay = Math.min(8000, Math.pow(2, attempt) * 1500);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        if (isRetryableModelError(status, message)) break;
        throw err;
      }
    }
  }

  throw lastErr || new Error('Image generation failed');
}

function buildImagePrompt(userText) {
  const clean = String(userText || '').trim();
  return [
    'Create a high-quality image based on this request.',
    'Make it visually clear, detailed, and well composed.',
    'Do not add random text unless the user asked for text in the image.',
    `Request: ${truncate(clean, 1200)}`,
  ].join(' ');
}

module.exports = {
  askGemini,
  askGeminiWithFallback,
  buildPrompt,
  buildMemoryPrompt,
  parseMemoryUpdate,
  generateGeminiImage,
  buildImagePrompt,
  MEMORY_EXTRACTION_MODEL_TEMPERATURE,
  MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS,
};
