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

function normalizeModelList(model, fallbackList = []) {
  const values = [model, ...fallbackList].flat().filter(Boolean).map(v => String(v).trim());
  return [...new Set(values)];
}

async function askGemini({
  apiKey,
  model,
  modelCandidates = [],
  prompt,
  retries = 3,
  temperature = MEMORY_CHAT_TEMPERATURE,
  maxOutputTokens = MEMORY_MAX_OUTPUT_TOKENS,
  generationConfig = {},
}) {
  if (!apiKey) throw new Error('Нет GEMINI_API_KEY');

  const candidates = normalizeModelList(model, modelCandidates);
  if (!candidates.length) throw new Error('Не задана модель Gemini');

  let lastError = null;
  for (const candidate of candidates) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${candidate}:generateContent`;

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
          const message = `Gemini ${res.status}: ${errText}`;
          lastError = new Error(message);
          if ((res.status === 429 || res.status === 503) && attempt < retries) {
            const delay = Math.pow(2, attempt) * 1500;
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          break;
        }

        const data = await res.json();
        return data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('').trim() || 'Пустой ответ.';
      } catch (err) {
        lastError = err;
        const message = String(err?.message || err);
        if (attempt < retries && (message.includes('503') || message.includes('429') || message.includes('fetch'))) {
          const delay = Math.pow(2, attempt) * 1500;
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        break;
      }
    }
  }

  throw lastError || new Error('Gemini недоступен');
}

function buildPrompt({ memoryContext = '', recentMessages = [], userName, text, channelName = '', basePrompt = '' }) {
  const memoryBlock = memoryContext
    ? ['Память:', memoryContext]
    : ['Память: пусто'];

  const recentHint = recentMessages.length
    ? `Последний контекст уже учтён в памяти (${recentMessages.length} сообщений).`
    : 'Свежего контекста нет.';

  return [
    SYSTEM_PROMPT,
    basePrompt ? `Дополнительная настройка личности:\n${basePrompt}` : '',
    '',
    'Используй память только если она релевантна текущему вопросу. Если памяти недостаточно или она спорная, уточняй вместо выдумывания.',
    'Не пересказывай память дословно. Применяй её как фон для ответа.',
    '',
    ...memoryBlock,
    '',
    recentHint,
    '',
    `Сейчас отвечает ${userName}${channelName ? ` в канале ${channelName}` : ''}: ${text}`,
  ].filter(Boolean).join('\n');
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

module.exports = {
  askGemini,
  buildPrompt,
  buildMemoryPrompt,
  parseMemoryUpdate,
  MEMORY_EXTRACTION_MODEL_TEMPERATURE,
  MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS,
};
