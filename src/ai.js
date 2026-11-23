const { SYSTEM_PROMPT, CHAT_TEMPERATURE, CHAT_MAX_OUTPUT_TOKENS } = require('./constants');

const API_BASE = 'https://generativelanguage.googleapis.com';
const REQUEST_TIMEOUT_MS = 30 * 1000;
const PROBE_TIMEOUT_MS = REQUEST_TIMEOUT_MS;
const SLOW_RESPONSE_THRESHOLD_MS = 12 * 1000;
const MODEL_PROBE_INTERVAL_MS = 10 * 60 * 1000;
const MODEL_CATALOG_REFRESH_MS = 60 * 60 * 1000;
const MODEL_CATALOG_TIMEOUT_MS = 20 * 1000;
const MAX_MODELS_PER_REQUEST = 5;

function timeoutSignal(ms = REQUEST_TIMEOUT_MS) {
  return AbortSignal.timeout(ms);
}
const IMAGEN_PATTERN = /^imagen-/i;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let discoveredChatModels = [];
let catalogRefreshInFlight = null;

function getModelQuality(model) {
  const id = String(model || '').replace(/^models\//i, '').toLowerCase();
  const match = id.match(/^(gemini|gemma)-(\d+(?:\.\d+)*)-(.+)$/);
  if (!match) return { family: 0, tier: 0, version: 0, stable: 0, parameters: 0 };

  const [, family, versionText, variant] = match;
  const version = versionText.split('.').reduce((score, part, index) => (
    score + (Number(part) || 0) * (1000000 / Math.pow(1000, index))
  ), 0);
  const stable = /(?:preview|experimental|(?:^|-)exp(?:-|$))/i.test(id) ? 0 : 1;

  if (family === 'gemini') {
    let tier = 100;
    if (/(?:^|-)ultra(?:-|$)/.test(variant)) tier = 600;
    else if (/(?:^|-)pro(?:-|$)/.test(variant)) tier = 500;
    else if (/(?:^|-)thinking(?:-|$)/.test(variant)) tier = 450;
    else if (/(?:^|-)flash-lite(?:-|$)/.test(variant)) tier = 200;
    else if (/(?:^|-)flash(?:-|$)/.test(variant)) tier = 300;
    return { family: 2, tier, version, stable, parameters: 0 };
  }

  const parameterMatch = variant.match(/(\d+(?:\.\d+)?)b/i);
  const parameters = parameterMatch ? Number(parameterMatch[1]) : 0;
  return { family: 1, tier: 100, version, stable, parameters };
}

function isSupportedChatModel(model) {
  const id = String(model || '').replace(/^models\//i, '').toLowerCase();
  const match = id.match(/^(gemini|gemma)-(\d+(?:\.\d+)*)-(.+)$/);
  if (!match) return false;

  const [, family, versionText, variant] = match;
  const majorVersion = Number(versionText.split('.')[0] || 0);
  if (family === 'gemini' && majorVersion < 3) return false;
  if (family === 'gemma' && majorVersion < 4) return false;
  if (/(?:^|-)(?:image|imagen|live|tts|transcribe|audio|embedding|robotics|veo|omni|computer-use)(?:-|$)/i.test(id)) {
    return false;
  }

  if (family === 'gemini') {
    return /(?:^|-)pro(?:-|$)|(?:^|-)thinking(?:-|$)|(?:^|-)flash(?:-lite)?(?:-|$)/i.test(variant);
  }

  return /(?:^|-)it(?:-|$)/i.test(variant);
}

function sortModelsByQuality(models) {
  return [...new Set((Array.isArray(models) ? models : [models]).filter(Boolean))]
    .map((model, originalIndex) => ({ model, originalIndex, quality: getModelQuality(model) }))
    .sort((a, b) => {
      const qa = a.quality;
      const qb = b.quality;
      const qualityOrder = qb.family - qa.family
        || qb.tier - qa.tier
        || qb.version - qa.version
        || qb.stable - qa.stable
        || qb.parameters - qa.parameters;
      if (qualityOrder) return qualityOrder;

      // Speed is deliberately only a tie-breaker for models of the same
      // generation and capability tier. It never promotes an older Lite model
      // ahead of a newer or more capable Gemini model.
      const latencyA = modelHealth.get(a.model)?.averageLatencyMs;
      const latencyB = modelHealth.get(b.model)?.averageLatencyMs;
      if (Number.isFinite(latencyA) && Number.isFinite(latencyB) && latencyA !== latencyB) {
        return latencyA - latencyB;
      }
      return a.originalIndex - b.originalIndex;
    })
    .map(item => item.model);
}

async function refreshGeminiModelCatalog({ apiKey, models = [] } = {}) {
  if (!apiKey) {
    return { refreshed: false, models: sortModelsByQuality(models), discovered: discoveredChatModels.length };
  }
  if (catalogRefreshInFlight) return catalogRefreshInFlight;

  catalogRefreshInFlight = (async () => {
    const discovered = new Set();
    let pageToken = '';

    for (let page = 0; page < 10; page++) {
      const url = new URL(API_BASE + '/v1beta/models');
      url.searchParams.set('pageSize', '1000');
      if (pageToken) url.searchParams.set('pageToken', pageToken);

      const response = await fetch(url.toString(), {
        method: 'GET',
        signal: timeoutSignal(MODEL_CATALOG_TIMEOUT_MS),
        headers: { 'x-goog-api-key': apiKey },
      });

      if (!response.ok) {
        const body = (await response.text()).replace(/\s+/g, ' ').slice(0, 350);
        throw new Error('Gemini models.list HTTP ' + response.status + ': ' + body);
      }

      const data = await response.json();
      for (const entry of Array.isArray(data.models) ? data.models : []) {
        const name = String(entry?.name || '').replace(/^models\//i, '');
        const methods = Array.isArray(entry?.supportedGenerationMethods) ? entry.supportedGenerationMethods : [];
        if (methods.includes('generateContent') && isSupportedChatModel(name)) {
          discovered.add(name);
        }
      }

      pageToken = String(data.nextPageToken || '');
      if (!pageToken) break;
    }

    discoveredChatModels = sortModelsByQuality([...discovered]);
    const merged = sortModelsByQuality([...(Array.isArray(models) ? models : [models]), ...discoveredChatModels]);
    console.info('[AI] Каталог Gemini обновлён: найдено ' + discoveredChatModels.length
      + ' чат-моделей, всего в пуле ' + merged.length + '.');
    return { refreshed: true, models: merged, discovered: discoveredChatModels.length };
  })();

  try {
    return await catalogRefreshInFlight;
  } finally {
    catalogRefreshInFlight = null;
  }
}

async function probePreferredGeminiModel({ apiKey, models = [] } = {}) {
  if (!apiKey) return { ok: false, skipped: true, reason: 'missing_api_key' };

  const ordered = sortModelsByQuality([
    ...(Array.isArray(models) ? models : [models]),
    ...discoveredChatModels,
  ]);
  const now = Date.now();
  const model = ordered.find(candidate => {
    const health = getModelHealth(candidate);
    if (health.probeInFlight) return false;
    const isPersistedDailyQuota = /(daily quota|per[_ -]?day|perday|generateRequestsPerDay|requestsPerDay|tokensPerDay|quota[_ -]?exceeded)/i.test(health.lastError);
    return !(isPersistedDailyQuota && health.cooldownUntil > now);
  });

  if (!model) return { ok: false, skipped: true, reason: 'all_candidates_busy_or_daily_limited' };

  const health = getModelHealth(model);
  health.probeInFlight = true;
  const startedAt = Date.now();

  try {
    const answer = await askGemini({
      apiKey,
      model,
      prompt: 'Reply with only the word OK.',
      retries: 1,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputTokens: 8,
      systemInstruction: '',
    });
    if (!String(answer || '').trim()) throw new Error('Gemini вернула пустой ответ при часовой проверке.');

    const elapsedMs = Date.now() - startedAt;
    recordModelSuccess(model, elapsedMs);
    console.info('[AI] Часовая проверка модели ' + model + ' успешна (' + (elapsedMs / 1000).toFixed(1) + 'с).');
    return { ok: true, model, elapsedMs };
  } catch (err) {
    const cooldownMs = getModelCooldown(err) || MODEL_PROBE_INTERVAL_MS;
    recordModelFailure(model, err, cooldownMs);
    console.warn('[AI] Часовая проверка модели ' + model + ' не прошла; fallback сохранён. Ошибка:', String(err?.message || err).slice(0, 300));
    return { ok: false, model, error: String(err?.message || err).slice(0, 300), cooldownMs };
  } finally {
    health.probeInFlight = false;
  }
}

function isRetryableStatus(status) {
  return [429, 500, 503, 504].includes(Number(status));
}

function isRetryableMessage(message) {
  const lower = String(message || '').toLowerCase();
  return ['429', '500', '503', '504', 'rate limit', 'quota', 'too many requests', 'temporarily unavailable', 'timeout', 'aborted', 'fetch failed'].some(token => lower.includes(token));
}

// Adaptive health keeps temporary failures out of the request path, but model
// quality and generation are the primary ordering. Latency is only a tie-breaker
// between models with the same capability tier and version.
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
      const previousError = String(health.lastError || '').toLowerCase();
      const explicitDailyQuota = /(daily quota|per[_ -]?day|perday|generateRequestsPerDay|requestsPerDay|tokensPerDay)/i.test(previousError);
      const legacyTransientFailure = /\b503\b|\b429\b|resource[_ -]?exhausted|high demand|temporarily unavailable|timeout|aborted|fetch failed/i.test(previousError);

      // Older releases incorrectly persisted generic 503/429/RESOURCE_EXHAUSTED
      // responses as a 10-minute or 24-hour outage. Recheck these once after
      // deploy unless the stored error explicitly identifies a daily quota.
      if (health.needsProbe && legacyTransientFailure && !explicitDailyQuota) {
        health.cooldownUntil = 0;
        health.nextProbeAt = now;
      } else if (health.needsProbe && health.nextProbeAt < now && health.cooldownUntil < now) {
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
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;
const OVERLOAD_COOLDOWN_MS = 45 * 1000;
const TRANSIENT_COOLDOWN_MS = 30 * 1000;

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
  const orderedModels = sortModelsByQuality(models);

  for (const [index, model] of orderedModels.entries()) {
    const health = getModelHealth(model);
    if (health.probeInFlight) continue;

    // Do not use a temporarily degraded model before its scheduled retry.
    if (health.needsProbe && Math.max(health.nextProbeAt || 0, health.cooldownUntil || 0) > now) continue;

    const isProbe = health.needsProbe;
    candidates.push({ model, index, isProbe });
  }

  // The strongest eligible model is always tried first. Faster legacy models
  // are fallback candidates, not winners of the default selection.
  if (candidates.some(candidate => candidate.isProbe)) saveGeminiModelHealth();
  return candidates;
}

function recordModelSuccess(model, elapsedMs) {
  const health = getModelHealth(model);
  health.successes++;
  health.lastSuccessAt = Date.now();
  health.lastError = '';
  health.averageLatencyMs = health.averageLatencyMs == null
    ? elapsedMs
    : health.averageLatencyMs * 0.7 + elapsedMs * 0.3;

  // Latency affects preference, not availability. A slow successful model
  // remains a valid fallback and must never be quarantined just for being slow.
  health.needsProbe = false;
  health.cooldownUntil = 0;
  health.nextProbeAt = 0;
  if (elapsedMs >= SLOW_RESPONSE_THRESHOLD_MS) {
    console.info('[AI] ' + model + ' успешно ответила за ' + (elapsedMs / 1000).toFixed(1) + 'с; оставляю её доступной как fallback.');
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

function getQuotaDiagnosticText(err) {
  const apiError = err && err.apiError;
  const details = Array.isArray(apiError?.details) ? apiError.details : [];
  return [
    apiError?.status,
    apiError?.message,
    ...details.map(detail => {
      try { return JSON.stringify(detail); } catch { return ''; }
    }),
    err?.message,
  ].filter(Boolean).join(' ').toLowerCase();
}

function isDailyQuotaError(err) {
  const diagnostic = getQuotaDiagnosticText(err);
  if (isShortRateLimitError(diagnostic)) return false;
  // RESOURCE_EXHAUSTED alone is ambiguous: Google also uses it for short
  // rate limits. Only a per-day marker or the explicit QUOTA_EXCEEDED reason
  // is allowed to create a 24-hour cooldown.
  return /(daily quota|per[_ -]?day|perday|generateRequestsPerDay|requestsPerDay|tokensPerDay|quota[_ -]?exceeded)/i.test(diagnostic);
}

function getModelCooldown(err) {
  const message = getErrorMessage(err);
  const status = Number(err && (err.statusCode || err.status) || 0);

  if (isDailyQuotaError(err)) return QUOTA_COOLDOWN_MS;
  if (status === 404 || (status === 400 && isModelSpecificFailure(err))) {
    return MODEL_UNAVAILABLE_COOLDOWN_MS;
  }
  if (status === 403 && isModelSpecificFailure(err)) return MODEL_ACCESS_COOLDOWN_MS;
  if (status === 429 || ((status === 403 || !status) && isShortRateLimitError(message))) {
    return RATE_LIMIT_COOLDOWN_MS;
  }
  if (status === 503) return OVERLOAD_COOLDOWN_MS;
  if ([500, 502, 504].includes(status)) return TRANSIENT_COOLDOWN_MS;
  if (/api вернул пустой ответ|empty response/i.test(message)) return EMPTY_RESPONSE_COOLDOWN_MS;
  if (!status && /timeout|aborted|fetch failed|network|econn|socket/i.test(message)) {
    return TRANSIENT_COOLDOWN_MS;
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
  retries = 2,
  timeoutMs = REQUEST_TIMEOUT_MS,
  temperature = CHAT_TEMPERATURE,
  maxOutputTokens = CHAT_MAX_OUTPUT_TOKENS,
  generationConfig = {},
  systemInstruction = '',
}) {
  if (!apiKey) throw new Error('Нет GEMINI_API_KEY');

  const url = API_BASE + '/v1beta/models/' + model + ':generateContent';
  const maxAttempts = Math.max(1, Math.min(Number(retries) || 2, 3));
  const isGemma = /^gemma-/i.test(model);
  const isGemini3 = /^gemini-3(?:[.-])/i.test(model);

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
            // Gemini 3 recommends keeping sampling parameters at API defaults.
            ...(!isGemini3 ? { temperature, topP: 0.95 } : {}),
            maxOutputTokens,
            ...generationConfig,
          },
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        let apiError = null;
        try {
          const parsed = JSON.parse(errText);
          apiError = parsed?.error || null;
        } catch {}
        const detailSummary = Array.isArray(apiError?.details)
          ? apiError.details.map(detail => [
              detail?.reason,
              detail?.quotaId,
              detail?.quotaMetric,
              detail?.metadata?.quotaId,
              detail?.metadata?.quotaMetric,
            ].filter(Boolean).join(' ')).filter(Boolean).join('; ')
          : '';
        const errorSummary = [
          apiError?.status,
          apiError?.message,
          detailSummary,
        ].filter(Boolean).join(' | ') || String(errText).replace(/\s+/g, ' ').trim().slice(0, 350);
        const error = new Error('Gemini ' + model + ' ' + res.status + ': ' + errorSummary.slice(0, 500));
        error.statusCode = res.status;
        error.model = model;
        error.apiError = apiError;

        const retryAfter = res.headers.get('retry-after');
        if (retryAfter) {
          const seconds = Number(retryAfter);
          const dateMs = Date.parse(retryAfter);
          error.retryAfterMs = Number.isFinite(seconds) && seconds > 0
            ? seconds * 1000
            : Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : 0;
        }
        if (!error.retryAfterMs && Array.isArray(apiError?.details)) {
          const retryInfo = apiError.details.find(detail => /RetryInfo/i.test(detail?.['@type'] || ''));
          const match = String(retryInfo?.retryDelay || '').match(/^(\d+(?:\.\d+)?)s$/);
          if (match) error.retryAfterMs = Number(match[1]) * 1000;
        }

        // Retry transient server overloads briefly. A long Retry-After is
        // handed to the next model instead of blocking the whole Discord reply.
        if ([500, 502, 503, 504].includes(res.status) && attempt < maxAttempts
          && (!error.retryAfterMs || error.retryAfterMs <= 8000)) {
          const delayMs = Math.max(250, Math.min(error.retryAfterMs || 800 * (2 ** (attempt - 1)), 5000));
          await sleep(delayMs);
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
      if (finishReason === 'MAX_TOKENS' && answer) {
        // A MAX_TOKENS response still contains usable text. Never discard it
        // for a second identical generation request that can time out.
        console.warn('[AI] ' + model + ' hit MAX_TOKENS; returning the available partial answer.');
        return answer;
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
  onStatus = null,
}) {
  const configuredModels = sortModelsByQuality([
    ...(Array.isArray(models) ? models : [models]),
    ...discoveredChatModels,
  ]);
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
  refreshGeminiModelCatalog,
  probePreferredGeminiModel,
  MODEL_CATALOG_REFRESH_MS,
  askGemini,
  askGeminiWithFallback,
  buildSystemInstruction,
  buildContents,
  buildSummaryPrompt,
  buildImagePrompt,
  generateImageWithFallback,
};



