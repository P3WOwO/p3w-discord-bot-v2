const { SYSTEM_PROMPT, CHAT_TEMPERATURE, CHAT_MAX_OUTPUT_TOKENS } = require('./constants');

const API_BASE = 'https://generativelanguage.googleapis.com';
const REQUEST_TIMEOUT_MS = 8 * 1000;
const PROBE_TIMEOUT_MS = 6 * 1000;
const SLOW_RESPONSE_THRESHOLD_MS = 6 * 1000;
const MODEL_PROBE_INTERVAL_MS = 10 * 60 * 1000;
const MAX_MODELS_PER_REQUEST = 3;

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

// Adaptive model health is kept in memory for this process. Fast, reliable
// models rise to the top; slow or failing models are temporarily sidelined
// and probed again every 10 minutes.
const modelHealth = new Map();
let persistModelHealth = null;

function getGeminiModelHealthSnapshot() {
  return Object.fromEntries([...modelHealth.entries()].map(([model, health]) => [
    model,
    {
      averageLatencyMs: Number.isFinite(health.averageLatencyMs) ? health.averageLatencyMs : null,
      successes: Number(health.successes || 0),
      failures: Number(health.failures || 0),
      cooldownUntil: Number(health.cooldownUntil || 0),
      nextProbeAt: Number(health.nextProbeAt || 0),
      needsProbe: Boolean(health.needsProbe),
      probeInFlight: false,
      lastError: String(health.lastError || '').slice(0, 220),
      lastSuccessAt: Number(health.lastSuccessAt || 0),
    },
  ]));
}

function configureGeminiModelHealth(snapshot = {}, persist = null) {
  modelHealth.clear();
  const now = Date.now();

  if (snapshot && typeof snapshot === 'object') {
    for (const [model, raw] of Object.entries(snapshot)) {
      if (!raw || typeof raw !== 'object') continue;
      modelHealth.set(model, {
        averageLatencyMs: raw.averageLatencyMs == null
          ? null
          : Number.isFinite(Number(raw.averageLatencyMs)) ? Number(raw.averageLatencyMs) : null,
        successes: Number(raw.successes || 0),
        failures: Number(raw.failures || 0),
        cooldownUntil: Number(raw.cooldownUntil || 0),
        nextProbeAt: Number(raw.nextProbeAt || 0),
        needsProbe: Boolean(raw.needsProbe),
        probeInFlight: false,
        lastError: String(raw.lastError || '').slice(0, 220),
        lastSuccessAt: Number(raw.lastSuccessAt || 0),
      });
      const health = modelHealth.get(model);
      if (health.needsProbe && health.nextProbeAt < now && health.cooldownUntil < now) {
        health.nextProbeAt = now;
      }
    }
  }

  persistModelHealth = typeof persist === 'function' ? persist : null;
}

function saveGeminiModelHealth() {
  if (!persistModelHealth) return;
  const snapshot = getGeminiModelHealthSnapshot();
  Promise.resolve(persistModelHealth(snapshot)).catch(err => {
    console.warn('[AI] Не удалось сохранить состояние Gemini-моделей:', err?.message || err);
  });
}

const MODEL_UNAVAILABLE_COOLDOWN_MS = 30 * 60 * 1000;
const MODEL_ACCESS_COOLDOWN_MS = 10 * 60 * 1000;
const EMPTY_RESPONSE_COOLDOWN_MS = MODEL_PROBE_INTERVAL_MS;
const QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const TRANSIENT_COOLDOWN_MS = MODEL_PROBE_INTERVAL_MS;

function getModelHealth(model) {
  if (!modelHealth.has(model)) {
    modelHealth.set(model, {
      averageLatencyMs: null,
      successes: 0,
      failures: 0,
      cooldownUntil: 0,
      nextProbeAt: 0,
      needsProbe: false,
      probeInFlight: false,
      lastError: '',
      lastSuccessAt: 0,
    });
  }
  return modelHealth.get(model);
}

function getModelCooldownRemaining(model) {
  const health = getModelHealth(model);
  return Math.max(0, health.cooldownUntil - Date.now());
}

function selectModelsByHealth(models) {
  const now = Date.now();
  const candidates = [];

  for (const [index, model] of models.entries()) {
    const health = getModelHealth(model);
    if (health.probeInFlight) continue;

    // Keep a degraded model out of the normal pool even after its cooldown
    // expires; it re-enters only as a scheduled probe.
    if (health.needsProbe && health.nextProbeAt > now) continue;

    const isProbe = health.needsProbe && health.nextProbeAt <= now;
    const score = isProbe
      ? -1000 + index
      : health.averageLatencyMs == null
        ? REQUEST_TIMEOUT_MS + index * 1000
        : health.averageLatencyMs;

    candidates.push({ model, index, isProbe, score });
  }

  candidates.sort((a, b) => a.score - b.score || a.index - b.index);
  if (candidates.some(candidate => candidate.isProbe)) saveGeminiModelHealth();
  return candidates;
}

function recordModelSuccess(model, elapsedMs, comparisonModels = []) {
  const health = getModelHealth(model);
  health.successes++;
  health.lastSuccessAt = Date.now();
  health.lastError = '';
  health.averageLatencyMs = health.averageLatencyMs == null
    ? elapsedMs
    : health.averageLatencyMs * 0.7 + elapsedMs * 0.3;

  const fastestAlternative = comparisonModels
    .filter(candidate => candidate !== model)
    .map(candidate => getModelHealth(candidate).averageLatencyMs)
    .filter(value => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b)[0];
  const muchSlowerThanAlternative = fastestAlternative != null && elapsedMs > fastestAlternative * 1.8;
  const isSlow = elapsedMs >= SLOW_RESPONSE_THRESHOLD_MS || muchSlowerThanAlternative;

  if (isSlow) {
    health.needsProbe = true;
    health.cooldownUntil = Date.now() + MODEL_PROBE_INTERVAL_MS;
    health.nextProbeAt = health.cooldownUntil;
    console.warn('[AI] ' + model + ' медленнее оптимального варианта (' + (elapsedMs / 1000).toFixed(1) + 'с); убираю её из обычного выбора на 10 мин. и позже проверю снова.');
  } else {
    health.needsProbe = false;
    health.cooldownUntil = 0;
    health.nextProbeAt = 0;
  }
  saveGeminiModelHealth();
}

function recordModelFailure(model, err, cooldownMs) {
  const health = getModelHealth(model);
  health.failures++;
  health.lastError = String(err && err.message || err || '').slice(0, 220);

  if (cooldownMs > 0) {
    health.needsProbe = true;
    health.cooldownUntil = Date.now() + cooldownMs;
    health.nextProbeAt = health.cooldownUntil;
  }
  saveGeminiModelHealth();
}

function getErrorMessage(err) {
  return String(err && err.message || err || '').toLowerCase();
}

function isModelSpecificFailure(err) {
  const message = getErrorMessage(err);
  const modelMention = /models?\/[a-z0-9._-]+|\bmodel\b|unknown model/i.test(message);
  const unavailable = /not found|not supported|does not support|not available|not enabled|not permitted|not authorized|permission denied|does not exist/i.test(message);
  return /model_not_found|model_not_supported/i.test(message) || (modelMention && unavailable);
}

function isShortRateLimitError(message) {
  return /(per[_ -]?(minute|second)|requests?[_ -]?per[_ -]?(minute|second)|tokens?[_ -]?per[_ -]?(minute|second)|requestsperminute|tokensperminute|\brpm\b|\btpm\b)/i.test(message);
}

function isDailyQuotaError(message) {
  if (/(daily quota|per[_ -]?day|requests?[_ -]?per[_ -]?day|generateRequestsPerDay|free[_ -]?tier.*day)/i.test(message)) return true;
  if (isShortRateLimitError(message)) return false;
  return /(quota exceeded|exceeded.*quota|resource[_ -]?exhausted|limit:\s*0|free[_ -]?tier.*quota)/i.test(message);
}

function getModelCooldown(err) {
  const message = getErrorMessage(err);
  const status = Number(err && (err.statusCode || err.status) || 0);

  // A depleted daily/free-tier quota is parked for a full day, then retried.
  if (isDailyQuotaError(message)) return QUOTA_COOLDOWN_MS;
  if (status === 404 || (status === 400 && isModelSpecificFailure(err))) {
    return MODEL_UNAVAILABLE_COOLDOWN_MS;
  }
  if (status === 403 && isModelSpecificFailure(err)) return MODEL_ACCESS_COOLDOWN_MS;
  if (status === 429 || ((status === 403 || !status) && isShortRateLimitError(message))) {
    return RATE_LIMIT_COOLDOWN_MS;
  }
  if ([500, 502, 503, 504].includes(status)) return TRANSIENT_COOLDOWN_MS;
  if (/api вернул пустой ответ|empty response/i.test(message)) return EMPTY_RESPONSE_COOLDOWN_MS;
  if (!status && /timeout|aborted|fetch failed|network|econn|socket/i.test(message)) {
    return MODEL_PROBE_INTERVAL_MS;
  }
  return 0;
}

function shouldTryNextModel(err) {
  const status = Number(err && (err.statusCode || err.status) || 0);
  const message = getErrorMessage(err);

  // Неверный ключ, отключённый API и общие ошибки запроса не исправятся сменой модели.
  if (status === 401) return false;
  if (status === 400) return isModelSpecificFailure(err);
  if (status === 403) {
    return isModelSpecificFailure(err) || /quota|resource_exhausted|rate limit|too many requests/i.test(message);
  }
  if ([404, 408, 409, 429, 500, 502, 503, 504].includes(status)) return true;
  return Boolean(err && err.fallbackable) || isRetryableMessage(message);
}

async function reportModelStatus(onStatus, event) {
  if (typeof onStatus !== 'function') return;
  try {
    await onStatus(event);
  } catch {
    // Updating a Discord progress message must never break model generation.
  }
}

async function askGemini({
  apiKey,
  model,
  prompt,
  retries = 1,
  timeoutMs = REQUEST_TIMEOUT_MS,
  temperature = CHAT_TEMPERATURE,
  maxOutputTokens = CHAT_MAX_OUTPUT_TOKENS,
  generationConfig = {},
  systemInstruction = '',
  _tokenExpansionAttempt = false,
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
    const prefix = 'Инструкции для OwO и долговременная память:\n' + systemInstruction + '\n\nПереписка:\n';
    if (firstUser && firstUser.parts && firstUser.parts.length) {
      // Multimodal prompts put image parts first. Add instructions to the
      // first text part only, never combine text and inline_data in one Part.
      const firstTextPart = firstUser.parts.find(part => typeof part?.text === 'string');
      if (firstTextPart) {
        firstTextPart.text = prefix + firstTextPart.text;
      } else {
        firstUser.parts.push({ text: prefix });
      }
    } else {
      contents.unshift({ role: 'user', parts: [{ text: prefix }] });
    }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: timeoutSignal(timeoutMs),
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
      if (finishReason === 'MAX_TOKENS' && answer && !_tokenExpansionAttempt) {
        const expandedMaxOutputTokens = Math.min(Math.max(Number(maxOutputTokens) * 2, 2048), 4096);
        console.warn('[AI] ' + model + ' hit MAX_TOKENS; retrying once with maxOutputTokens=' + expandedMaxOutputTokens);
        return askGemini({
          apiKey,
          model,
          prompt,
          retries: 1,
          timeoutMs,
          temperature,
          maxOutputTokens: expandedMaxOutputTokens,
          generationConfig,
          systemInstruction,
          _tokenExpansionAttempt: true,
        });
      }
      if (finishReason === 'MAX_TOKENS' && answer) {
        console.warn('[AI] ' + model + ' still hit MAX_TOKENS after expanded retry; returning the available text');
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
  retries = 1,
  temperature = CHAT_TEMPERATURE,
  maxOutputTokens = CHAT_MAX_OUTPUT_TOKENS,
  generationConfig = {},
  systemInstruction = '',
  onStatus = null,
}) {
  const configuredModels = [...new Set((Array.isArray(models) ? models : [models]).filter(Boolean))];
  if (!configuredModels.length) throw new Error('Не настроен список GEMINI_CHAT_MODELS');

  const availableCandidates = selectModelsByHealth(configuredModels);
  if (!availableCandidates.length) {
    await reportModelStatus(onStatus, { phase: 'unavailable' });
    throw new Error('Все модели Gemini сейчас проверяются или находятся в cooldown. Повторная проверка будет выполнена автоматически.');
  }

  // Cap one reply to three model attempts. Failed candidates are cooled down,
  // so the next message naturally continues further down the fallback chain.
  const modelCandidates = availableCandidates.slice(0, MAX_MODELS_PER_REQUEST);
  const errors = [];
  let lastError = null;
  let skippedModels = configuredModels.length - modelCandidates.length;

  for (let position = 0; position < modelCandidates.length; position++) {
    const candidate = modelCandidates[position];
    const { model, index, isProbe } = candidate;

    await reportModelStatus(onStatus, {
      phase: 'trying',
      model,
      index,
      total: configuredModels.length,
      fallback: position > 0 || skippedModels > 0 || isProbe,
      probe: isProbe,
    });

    const attemptStartedAt = Date.now();
    const timeoutMs = isProbe ? PROBE_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
    if (isProbe) {
      // Reserve only the probe we are actually about to run. Unused probes
      // must remain eligible for the next request instead of being stuck busy.
      const health = getModelHealth(model);
      health.probeInFlight = true;
      health.nextProbeAt = Date.now() + MODEL_PROBE_INTERVAL_MS;
    }

    try {
      const answer = await askGemini({
        apiKey,
        model,
        prompt,
        retries,
        timeoutMs,
        temperature,
        maxOutputTokens,
        generationConfig,
        systemInstruction,
      });

      const elapsedMs = Date.now() - attemptStartedAt;
      recordModelSuccess(model, elapsedMs, configuredModels);
      console.info('[AI] Ответ получен от ' + model + ' за ' + (elapsedMs / 1000).toFixed(1) + 'с'
        + (position > 0 ? ' (fallback)' : '')
        + (isProbe ? ' (повторная проба)' : '') + '.');
      await reportModelStatus(onStatus, { phase: 'success', model, elapsedMs });
      return answer;
    } catch (err) {
      lastError = err;
      const elapsedMs = Date.now() - attemptStartedAt;
      const message = String(err && err.message || err).slice(0, 220);
      const fallback = shouldTryNextModel(err);
      const cooldownMs = getModelCooldown(err);
      recordModelFailure(model, err, cooldownMs || (fallback ? MODEL_PROBE_INTERVAL_MS : 0));

      if (isProbe) getModelHealth(model).probeInFlight = false;

      if (cooldownMs > 0) {
        console.warn('[AI] ' + model + ' временно исключена на ' + Math.ceil(cooldownMs / 60000) + ' мин.; проверю снова после cooldown. Ошибка после '
          + (elapsedMs / 1000).toFixed(1) + 'с:', message);
      } else {
        console.warn('[AI] ' + model + ' не ответила после ' + (elapsedMs / 1000).toFixed(1) + 'с:', message);
      }

      errors.push(model + ': ' + message);
      if (!fallback) {
        await reportModelStatus(onStatus, { phase: 'failed', model });
        throw err;
      }

      const nextCandidate = modelCandidates[position + 1];
      const quotaCooldown = cooldownMs >= QUOTA_COOLDOWN_MS;
      await reportModelStatus(onStatus, {
        phase: quotaCooldown ? 'quota' : nextCandidate ? 'fallback' : 'exhausted',
        model,
        nextModel: nextCandidate?.model || null,
        retryAt: quotaCooldown ? Date.now() + cooldownMs : null,
        cooldownMs,
      });
    } finally {
      if (isProbe) getModelHealth(model).probeInFlight = false;
    }
  }

  await reportModelStatus(onStatus, { phase: 'unavailable' });
  const detail = errors.length ? errors.join(' | ') : 'Все модели находятся в cooldown после предыдущих ошибок.';
  const error = new Error('Все модели Gemini/Gemma недоступны. ' + detail);
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
function buildContents({ turns = [], userName = '', text = '', images = [], maxChars = 20000 }) {
  const currentText = (userName || 'Пользователь') + ': ' + String(text || (images.length ? 'Посмотри на прикреплённое изображение.' : '')).slice(-9000);
  const history = (Array.isArray(turns) ? turns : []).slice(-24).map(turn => {
    const isAssistant = turn && turn.role === 'assistant';
    const body = String(turn && turn.text || '').slice(-1800);
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

  // Images belong only to the current user turn. Keep raw bytes out of saved
  // chat history; Gemini receives the inlineData part in this one request.
  const currentParts = [];
  for (const image of Array.isArray(images) ? images.slice(0, 3) : []) {
    if (!image || !image.mimeType || !image.data) continue;
    // Put image parts before the current question (recommended for Gemma 4
    // and also accepted by Gemini multimodal generateContent requests).
    currentParts.push({
      inline_data: {
        mime_type: image.mimeType,
        data: image.data,
      },
    });
  }
  currentParts.push({ text: currentText });

  const last = contents[contents.length - 1];
  if (last && last.role === 'user') {
    if (currentParts.length > 1) last.parts.push(...currentParts);
    else last.parts[0].text += '\n' + currentText;
  } else {
    contents.push({ role: 'user', parts: currentParts });
  }

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
  configureGeminiModelHealth,
  getGeminiModelHealthSnapshot,
  askGemini,
  askGeminiWithFallback,
  buildSystemInstruction,
  buildContents,
  buildSummaryPrompt,
  buildImagePrompt,
  generateImageWithFallback,
};



