const { SYSTEM_PROMPT, CHAT_TEMPERATURE, CHAT_MAX_OUTPUT_TOKENS } = require('./constants');

const API_BASE = 'https://generativelanguage.googleapis.com';
const REQUEST_TIMEOUT_MS = 45 * 1000;

function timeoutSignal(ms = REQUEST_TIMEOUT_MS) {
  return AbortSignal.timeout(ms);
}
const IMAGEN_PATTERN = /^imagen-/i;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return [429, 500, 503, 504].includes(Number(status));
}

function isRetryableMessage(message) {
  const lower = String(message || '').toLowerCase();
  return ['429', '500', '503', '504', 'rate limit', 'quota', 'too many requests', 'temporarily unavailable', 'timeout', 'aborted', 'fetch failed'].some(token => lower.includes(token));
}

function shouldTryNextModel(err) {
  const status = Number(err && (err.statusCode || err.status) || 0);
  // A bad key or malformed request affects every model; don't waste fallback attempts.
  if ([400, 401].includes(status)) return false;
  if ([403, 404, 408, 409, 429, 500, 502, 503, 504].includes(status)) return true;
  return Boolean(err && err.fallbackable) || isRetryableMessage(err && err.message || err);
}

async function askGemini({
  apiKey,
  model,
  prompt,
  retries = 2,
  temperature = CHAT_TEMPERATURE,
  maxOutputTokens = CHAT_MAX_OUTPUT_TOKENS,
  generationConfig = {},
  systemInstruction = '',
}) {
  if (!apiKey) throw new Error('Нет GEMINI_API_KEY');

  const url = API_BASE + '/v1beta/models/' + model + ':generateContent';
  const maxAttempts = Math.max(1, Math.min(Number(retries) || 1, 2));
  const isGemma = /^gemma-/i.test(model);

  // Gemma 4's hosted API is used without systemInstruction. Fold the character
  // and memory into the first user turn instead of sending an unsupported field.
  let contents = Array.isArray(prompt)
    ? prompt.map(item => ({ role: item.role, parts: (item.parts || []).map(part => ({ ...part })) }))
    : [{ role: 'user', parts: [{ text: String(prompt || '') }] }];
  if (isGemma && systemInstruction) {
    const firstUser = contents.find(item => item.role === 'user');
    const prefix = 'Инструкции для P3W и долговременная память:\n' + systemInstruction + '\n\nПереписка:\n';
    if (firstUser && firstUser.parts && firstUser.parts.length) {
      firstUser.parts[0].text = prefix + String(firstUser.parts[0].text || '');
    } else {
      contents.unshift({ role: 'user', parts: [{ text: prefix }] });
    }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: timeoutSignal(),
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          ...(!isGemma && systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
          contents,
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
        const error = new Error('Gemini ' + model + ' ' + res.status + ': ' + String(errText).slice(0, 700));
        error.statusCode = res.status;
        error.model = model;
        // 429/403/404 are handled by moving to the next model. Only retry transient 5xx here.
        if ([500, 502, 503, 504].includes(res.status) && attempt < maxAttempts) {
          await sleep(1000);
          continue;
        }
        throw error;
      }

      const data = await res.json();
      const candidate = data && data.candidates && data.candidates[0];
      const answer = candidate && candidate.content && Array.isArray(candidate.content.parts)
        ? candidate.content.parts.map(part => part && part.text).filter(Boolean).join('').trim()
        : '';
      const blockReason = data && data.promptFeedback && data.promptFeedback.blockReason;
      const finishReason = candidate && candidate.finishReason;

      // Safety blocks must not be bypassed by switching to a weaker model.
      if (blockReason || ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(finishReason)) {
        return 'Не могу ответить на это.';
      }
      if (answer) return answer;

      const error = new Error(model + ': API вернул пустой ответ' + (finishReason ? ' (finishReason=' + finishReason + ')' : ''));
      error.fallbackable = true;
      error.model = model;
      throw error;
    } catch (err) {
      const message = String(err && err.message || err);
      const hasHttpStatus = Number(err && (err.statusCode || err.status) || 0) > 0;
      const canRetryNetwork = !hasHttpStatus && isRetryableMessage(message);
      if (canRetryNetwork && attempt < maxAttempts) {
        await sleep(1000);
        continue;
      }
      throw err;
    }
  }

  throw new Error('Gemini ' + model + ': исчерпаны попытки запроса');
}

async function askGeminiWithFallback({
  apiKey,
  models,
  prompt,
  retries = 2,
  temperature = CHAT_TEMPERATURE,
  maxOutputTokens = CHAT_MAX_OUTPUT_TOKENS,
  generationConfig = {},
  systemInstruction = '',
}) {
  const modelList = [...new Set((Array.isArray(models) ? models : [models]).filter(Boolean))];
  if (!modelList.length) throw new Error('Не настроен список GEMINI_CHAT_MODELS');

  const errors = [];
  let lastError = null;
  for (const model of modelList) {
    try {
      const answer = await askGemini({
        apiKey, model, prompt, retries, temperature, maxOutputTokens, generationConfig, systemInstruction,
      });
      console.info('[AI] Ответ получен от ' + model);
      return answer;
    } catch (err) {
      lastError = err;
      const message = String(err && err.message || err).slice(0, 220);
      const fallback = shouldTryNextModel(err);
      errors.push(model + ': ' + message);
      console.warn('[AI] ' + model + ' failed; ' + (fallback ? 'trying next model' : 'stopping fallback'), message);
      if (!fallback) throw err;
    }
  }

  const error = new Error('Все модели Gemini/Gemma недоступны. ' + errors.join(' | '));
  error.cause = lastError;
  throw error;
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
          signal: timeoutSignal(90 * 1000),
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
        signal: timeoutSignal(90 * 1000),
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

// Строит системную инструкцию (персона + доп. стиль + выжимка + сведения о канале).
function buildSystemInstruction({ basePrompt = '', summary = '', channelName = '' }) {
  return [
    SYSTEM_PROMPT,
    basePrompt ? `Дополнительный стиль общения:\n${basePrompt}` : '',
    summary ? `Суть прошлых разговоров в этом канале (кратко): ${summary}` : '',
    channelName ? `Текущий канал: #${channelName}` : '',
  ].filter(Boolean).join('\n\n');
}

// История канала -> contents Gemini (чередование user/model, подряд идущие реплики склеиваем).
function buildContents({ turns = [], userName = '', text = '', maxChars = 14000 }) {
  const currentText = (userName || 'Пользователь') + ': ' + String(text || '').slice(-9000);
  const history = (Array.isArray(turns) ? turns : []).slice(-24).map(turn => {
    const isAssistant = turn && turn.role === 'assistant';
    const body = String(turn && turn.text || '').slice(-1400);
    return {
      role: isAssistant ? 'model' : 'user',
      text: isAssistant ? body : (turn && turn.name || 'Пользователь') + ': ' + body,
    };
  }).filter(turn => turn.text.trim());

  const budget = Math.max(2500, Number(maxChars) || 14000);
  let used = currentText.length;
  const selected = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (used + item.text.length + 1 > budget) break;
    selected.unshift(item);
    used += item.text.length + 1;
  }

  // Gemini/Gemma require the first turn to be a user turn.
  while (selected.length && selected[0].role !== 'user') selected.shift();

  const contents = [];
  const push = (role, line) => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts[0].text += '\n' + line;
    else contents.push({ role, parts: [{ text: line }] });
  };
  for (const turn of selected) push(turn.role, turn.text);
  push('user', currentText);
  while (contents.length && contents[0].role !== 'user') contents.shift();
  return contents;
}
// Промпт авто-выжимки старых сообщений (дешёвый вызов раз в N сообщений).
function buildSummaryPrompt({ existingSummary = '', oldMessages = '' }) {
  return [
    'Обнови долговременную память переписки для будущих ответов, а не пересказывай сообщения подряд.',
    'Сохраняй только полезное на будущее: устойчивые предпочтения, явно сообщённые факты, решения, договорённости, активные проекты, незакрытые вопросы и повторяющиеся темы.',
    'Указывай, кому относится каждый факт, если в переписке несколько участников.',
    'Не превращай разовую покупку, шутку, сарказм, гипотезу, обвинение или случайное намерение в постоянный факт или предпочтение.',
    'Если участник явно исправил старую информацию, оставь исправленную версию и убери противоречие.',
    'Не добавляй выводов, которых нет в переписке. Не сохраняй лишние детали и устаревшие сведения.',
    'Верни только короткую выжимку смысловыми строками, максимум 1500 символов, без вступления и markdown-заголовков.',
    '',
    existingSummary ? 'Текущая долговременная память:\n' + existingSummary : 'Текущая долговременная память: пусто',
    '',
    oldMessages ? 'Новые архивные сообщения:\n' + String(oldMessages).slice(-26000) : 'Новые архивные сообщения: пусто',
  ].join('\n');
}
module.exports = {
  askGemini,
  askGeminiWithFallback,
  buildSystemInstruction,
  buildContents,
  buildSummaryPrompt,
  buildImagePrompt,
  generateImageWithFallback,
};



