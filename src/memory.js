const DEFAULT_MEMORY_VERSION = 2;
const GLOBAL_NOTE_LIMIT = 10;
const CHANNEL_NOTE_LIMIT = 8;
const USER_NOTE_LIMIT = 12;
const SUMMARY_LIMIT = 900;
const NOTE_LIMIT = 220;
const PROMPT_NOTE_LIMIT = 6;

const STOPWORDS = new Set([
  'и', 'в', 'во', 'не', 'что', 'он', 'на', 'я', 'с', 'со', 'как', 'а', 'то', 'все', 'она', 'так', 'его', 'но',
  'да', 'ты', 'к', 'у', 'же', 'вы', 'за', 'бы', 'по', 'только', 'ее', 'мне', 'было', 'вот', 'от', 'меня', 'еще',
  'нет', 'о', 'из', 'ему', 'теперь', 'когда', 'даже', 'ну', 'вдруг', 'ли', 'если', 'уже', 'или', 'ни', 'быть',
  'был', 'него', 'до', 'вас', 'нибудь', 'опять', 'уж', 'вам', 'ведь', 'там', 'потом', 'себя', 'ничего', 'ей',
  'может', 'они', 'тут', 'где', 'есть', 'надо', 'ней', 'для', 'мы', 'тебя', 'их', 'чем', 'была', 'сам', 'чтоб',
  'без', 'будто', 'чего', 'раз', 'тоже', 'себе', 'под', 'будет', 'ж', 'тогда', 'кто', 'этот', 'того', 'потому',
  'этого', 'какой', 'совсем', 'ним', 'здесь', 'этом', 'один', 'почти', 'мой', 'тем', 'чтобы', 'нее', 'сейчас',
  'были', 'куда', 'зачем', 'всех', 'никогда', 'можно', 'при', 'наконец', 'два', 'об', 'другой', 'хоть', 'после',
  'над', 'больше', 'тот', 'через', 'эти', 'нас', 'про', 'всего', 'них', 'какая', 'много', 'разве', 'три', 'эту',
  'моя', 'впрочем', 'хорошо', 'свою', 'этой', 'перед', 'иногда', 'лучше', 'чуть', 'том', 'нельзя', 'такой', 'им',
  'более', 'всегда', 'конечно', 'всю', 'между'
]);

function createEmptyMemory() {
  return {
    schemaVersion: DEFAULT_MEMORY_VERSION,
    globalSummary: '',
    globalNotes: [],
    channels: {},
    users: {},
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(value, max = SUMMARY_LIMIT) {
  const text = normalizeText(value);
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function tokenize(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length > 1 && !STOPWORDS.has(token));
}

function overlapScore(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (!setA.size || !setB.size) return 0;

  let overlap = 0;
  for (const token of setA) {
    if (setB.has(token)) overlap += 1;
  }
  return overlap / Math.max(setA.size, setB.size);
}

function normalizeScopeKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function ensureScope(target, defaults = {}) {
  return {
    summary: truncate(target?.summary || '', SUMMARY_LIMIT),
    notes: Array.isArray(target?.notes) ? target.notes.map(note => sanitizeNote(note)).filter(Boolean) : [],
    displayName: normalizeText(target?.displayName || defaults.displayName || ''),
    lastUpdatedAt: target?.lastUpdatedAt || null,
    lastSeenAt: target?.lastSeenAt || null,
    ...target,
  };
}

function sanitizeNote(note) {
  if (!note || typeof note !== 'object') return null;
  const text = truncate(note.text || note.note || '', NOTE_LIMIT);
  if (!text) return null;
  const importance = Math.max(1, Math.min(5, Number(note.importance ?? 3) || 3));
  return {
    id: normalizeText(note.id || text).toLowerCase().slice(0, 120),
    text,
    importance,
    category: normalizeText(note.category || 'other').toLowerCase().slice(0, 32),
    confidence: Math.max(0, Math.min(1, Number(note.confidence ?? 0.75) || 0.75)),
    createdAt: note.createdAt || note.updatedAt || new Date().toISOString(),
    updatedAt: note.updatedAt || note.createdAt || new Date().toISOString(),
    source: normalizeText(note.source || 'memory-extractor').slice(0, 80),
  };
}

function sortNotes(notes) {
  return [...notes].sort((a, b) => {
    const scoreA = (a.importance || 1) * 1000 + new Date(a.updatedAt || a.createdAt || 0).getTime() / 1000;
    const scoreB = (b.importance || 1) * 1000 + new Date(b.updatedAt || b.createdAt || 0).getTime() / 1000;
    return scoreB - scoreA;
  });
}

function dedupeNotes(notes) {
  const seen = new Map();
  for (const note of notes) {
    const key = normalizeText(note.text).toLowerCase();
    if (!key) continue;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, note);
      continue;
    }
    const existingScore = (existing.importance || 1) * 10 + new Date(existing.updatedAt || existing.createdAt || 0).getTime() / 100000;
    const nextScore = (note.importance || 1) * 10 + new Date(note.updatedAt || note.createdAt || 0).getTime() / 100000;
    if (nextScore >= existingScore) seen.set(key, note);
  }
  return [...seen.values()];
}

function pruneNotes(notes, limit) {
  return sortNotes(dedupeNotes(notes)).slice(0, limit);
}

function mergeSummary(existing, update) {
  const next = truncate(update, SUMMARY_LIMIT);
  if (!next) return truncate(existing, SUMMARY_LIMIT);
  if (!existing) return next;
  return next;
}

function migrateLegacyMemory(raw) {
  const memory = createEmptyMemory();

  if (!raw || typeof raw !== 'object') return memory;

  if (typeof raw.globalSummary === 'string') memory.globalSummary = truncate(raw.globalSummary, SUMMARY_LIMIT);
  if (Array.isArray(raw.globalNotes)) memory.globalNotes = pruneNotes(raw.globalNotes.map(sanitizeNote).filter(Boolean), GLOBAL_NOTE_LIMIT);

  if (raw.channels && typeof raw.channels === 'object' && !Array.isArray(raw.channels)) {
    for (const [channelId, value] of Object.entries(raw.channels)) {
      const normalized = ensureScope(value, {});
      memory.channels[channelId] = {
        summary: truncate(normalized.summary, SUMMARY_LIMIT),
        notes: pruneNotes(normalized.notes, CHANNEL_NOTE_LIMIT),
        displayName: normalized.displayName || '',
        lastUpdatedAt: normalized.lastUpdatedAt || null,
        lastSeenAt: normalized.lastSeenAt || null,
        legacyHistory: Array.isArray(normalized.legacyHistory) ? normalized.legacyHistory.slice(-20) : [],
      };
    }
  }

  if (raw.users && typeof raw.users === 'object' && !Array.isArray(raw.users)) {
    for (const [scopeKey, value] of Object.entries(raw.users)) {
      const normalized = ensureScope(value, {});
      memory.users[scopeKey] = {
        displayName: normalized.displayName || '',
        summary: truncate(normalized.summary, SUMMARY_LIMIT),
        notes: pruneNotes(normalized.notes, USER_NOTE_LIMIT),
        lastUpdatedAt: normalized.lastUpdatedAt || null,
        lastSeenAt: normalized.lastSeenAt || null,
      };
    }
  }

  // Legacy format: ai_memory[channelId] = [{role,name,text}, ...]
  for (const [key, value] of Object.entries(raw)) {
    if (['schemaVersion', 'globalSummary', 'globalNotes', 'channels', 'users'].includes(key)) continue;
    if (!Array.isArray(value)) continue;
    memory.channels[key] = {
      summary: '',
      notes: [],
      displayName: '',
      lastUpdatedAt: null,
      lastSeenAt: null,
      legacyHistory: value
        .filter(item => item && typeof item === 'object')
        .map(item => ({
          role: normalizeText(item.role || 'user').slice(0, 20),
          name: normalizeText(item.name || '').slice(0, 80),
          text: truncate(item.text || '', 300),
        }))
        .slice(-20),
    };
  }

  return memory;
}

function normalizeMemory(raw) {
  if (!raw || typeof raw !== 'object') return createEmptyMemory();
  if (raw.schemaVersion === DEFAULT_MEMORY_VERSION) {
    return {
      schemaVersion: DEFAULT_MEMORY_VERSION,
      globalSummary: truncate(raw.globalSummary || '', SUMMARY_LIMIT),
      globalNotes: pruneNotes(Array.isArray(raw.globalNotes) ? raw.globalNotes.map(sanitizeNote).filter(Boolean) : [], GLOBAL_NOTE_LIMIT),
      channels: Object.fromEntries(
        Object.entries(raw.channels || {}).map(([channelId, value]) => [channelId, {
          summary: truncate(value?.summary || '', SUMMARY_LIMIT),
          notes: pruneNotes(Array.isArray(value?.notes) ? value.notes.map(sanitizeNote).filter(Boolean) : [], CHANNEL_NOTE_LIMIT),
          displayName: normalizeText(value?.displayName || ''),
          lastUpdatedAt: value?.lastUpdatedAt || null,
          lastSeenAt: value?.lastSeenAt || null,
          legacyHistory: Array.isArray(value?.legacyHistory) ? value.legacyHistory.slice(-20) : [],
        }])
      ),
      users: Object.fromEntries(
        Object.entries(raw.users || {}).map(([scopeKey, value]) => [scopeKey, {
          displayName: normalizeText(value?.displayName || ''),
          summary: truncate(value?.summary || '', SUMMARY_LIMIT),
          notes: pruneNotes(Array.isArray(value?.notes) ? value.notes.map(sanitizeNote).filter(Boolean) : [], USER_NOTE_LIMIT),
          lastUpdatedAt: value?.lastUpdatedAt || null,
          lastSeenAt: value?.lastSeenAt || null,
        }])
      ),
    };
  }
  return migrateLegacyMemory(raw);
}

function scopeForUser(memory, guildId, userId, displayName = '') {
  const scopeKey = normalizeScopeKey(guildId, userId);
  if (!memory.users[scopeKey]) {
    memory.users[scopeKey] = {
      displayName: normalizeText(displayName),
      summary: '',
      notes: [],
      lastUpdatedAt: null,
      lastSeenAt: null,
    };
  }
  const user = memory.users[scopeKey];
  if (displayName && (!user.displayName || user.displayName !== displayName)) {
    user.displayName = normalizeText(displayName);
  }
  user.lastSeenAt = new Date().toISOString();
  return { scopeKey, user };
}

function scopeForChannel(memory, channelId, channelName = '') {
  if (!memory.channels[channelId]) {
    memory.channels[channelId] = {
      summary: '',
      notes: [],
      displayName: normalizeText(channelName),
      lastUpdatedAt: null,
      lastSeenAt: null,
      legacyHistory: [],
    };
  }
  const channel = memory.channels[channelId];
  if (channelName && (!channel.displayName || channel.displayName !== channelName)) {
    channel.displayName = normalizeText(channelName);
  }
  channel.lastSeenAt = new Date().toISOString();
  return channel;
}

function addOrMergeNote(notes, incoming) {
  const note = sanitizeNote(incoming);
  if (!note) return notes;

  const key = normalizeText(note.text).toLowerCase();
  const existingIndex = notes.findIndex(item => normalizeText(item.text).toLowerCase() === key);
  if (existingIndex >= 0) {
    const existing = notes[existingIndex];
    notes[existingIndex] = {
      ...existing,
      importance: Math.max(existing.importance || 1, note.importance || 1),
      confidence: Math.max(existing.confidence || 0, note.confidence || 0),
      category: note.category || existing.category || 'other',
      updatedAt: new Date().toISOString(),
    };
    return notes;
  }

  notes.push(note);
  return notes;
}

function applyMemoryUpdate(memory, { guildId, channelId, userId, userName, update = {} }) {
  const next = normalizeMemory(memory);
  const nowIso = new Date().toISOString();
  const { user } = scopeForUser(next, guildId, userId, userName);
  const channel = scopeForChannel(next, channelId);

  const shouldStore = update.should_store !== false;
  if (!shouldStore) return next;

  if (typeof update.global_summary_update === 'string' && update.global_summary_update.trim()) {
    next.globalSummary = mergeSummary(next.globalSummary, update.global_summary_update);
  }

  if (typeof update.channel_summary_update === 'string' && update.channel_summary_update.trim()) {
    channel.summary = mergeSummary(channel.summary, update.channel_summary_update);
    channel.lastUpdatedAt = nowIso;
  }

  if (typeof update.user_summary_update === 'string' && update.user_summary_update.trim()) {
    user.summary = mergeSummary(user.summary, update.user_summary_update);
    user.lastUpdatedAt = nowIso;
  }

  const addNotes = Array.isArray(update.notes_add) ? update.notes_add : [];
  for (const item of addNotes) {
    const scope = normalizeText(item?.scope || 'user').toLowerCase();
    if (scope === 'global') {
      next.globalNotes = addOrMergeNote(next.globalNotes || [], item);
    } else if (scope === 'channel') {
      channel.notes = addOrMergeNote(channel.notes || [], item);
      channel.lastUpdatedAt = nowIso;
    } else {
      user.notes = addOrMergeNote(user.notes || [], item);
      user.lastUpdatedAt = nowIso;
    }
  }

  const removeNotes = Array.isArray(update.notes_remove) ? update.notes_remove : [];
  for (const item of removeNotes) {
    const scope = normalizeText(item?.scope || 'user').toLowerCase();
    const match = normalizeText(item?.match || '').toLowerCase();
    if (!match) continue;

    const filterFn = note => !normalizeText(note.text).toLowerCase().includes(match);
    if (scope === 'global') next.globalNotes = (next.globalNotes || []).filter(filterFn);
    else if (scope === 'channel') channel.notes = (channel.notes || []).filter(filterFn);
    else user.notes = (user.notes || []).filter(filterFn);
  }

  next.globalNotes = pruneNotes(next.globalNotes || [], GLOBAL_NOTE_LIMIT);
  channel.notes = pruneNotes(channel.notes || [], CHANNEL_NOTE_LIMIT);
  user.notes = pruneNotes(user.notes || [], USER_NOTE_LIMIT);

  if (Array.isArray(channel.legacyHistory) && channel.legacyHistory.length > 20) {
    channel.legacyHistory = channel.legacyHistory.slice(-20);
  }

  return next;
}

function relevantNotes(notes, queryText, limit = PROMPT_NOTE_LIMIT) {
  const scored = (Array.isArray(notes) ? notes : []).map(note => {
    const text = note?.text || '';
    const overlap = overlapScore(text, queryText);
    const recency = new Date(note?.updatedAt || note?.createdAt || 0).getTime() / 1e13;
    const importance = (Number(note?.importance || 1) || 1) / 5;
    const score = overlap * 8 + importance * 3 + recency;
    return { note, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => item.note);
}

function formatNoteLine(note) {
  const prefix = note.importance >= 4 ? '★' : note.importance === 3 ? '•' : '·';
  return `${prefix} ${truncate(note.text, 180)}`;
}

function buildMemoryContext(memoryInput, { guildId, channelId, userId, userName = '', channelName = '', queryText = '', recentMessages = [] }) {
  const memory = normalizeMemory(memoryInput);
  const userScope = memory.users[normalizeScopeKey(guildId, userId)] || null;
  const channelScope = memory.channels[channelId] || null;

  const userNotes = relevantNotes(userScope?.notes || [], queryText, 4);
  const channelNotes = relevantNotes(channelScope?.notes || [], queryText, 3);
  const globalNotes = relevantNotes(memory.globalNotes || [], queryText, 3);

  const sections = [];

  if (memory.globalSummary) {
    sections.push(`Общая сводка: ${truncate(memory.globalSummary, 420)}`);
  }

  if (channelScope?.summary) {
    const title = channelScope.displayName ? `Канал ${channelScope.displayName}` : 'Канал';
    sections.push(`${title}: ${truncate(channelScope.summary, 420)}`);
  }

  if (userScope?.summary || userNotes.length) {
    const title = userScope?.displayName || userName || 'Пользователь';
    const lines = [];
    if (userScope?.summary) lines.push(`Сводка: ${truncate(userScope.summary, 320)}`);
    if (userNotes.length) lines.push(`Важное:`);
    for (const note of userNotes) lines.push(formatNoteLine(note));
    sections.push(`Память о ${title}:\n${lines.join('\n')}`);
  }

  if (channelNotes.length) {
    const lines = channelNotes.map(formatNoteLine);
    sections.push(`Полезное по каналу:\n${lines.join('\n')}`);
  }

  if (globalNotes.length) {
    const lines = globalNotes.map(formatNoteLine);
    sections.push(`Глобальные заметки:\n${lines.join('\n')}`);
  }

  if (Array.isArray(recentMessages) && recentMessages.length) {
    const recentLines = recentMessages.slice(-6).map(msg => `${msg.name}: ${truncate(msg.text, 160)}`);
    sections.push(`Свежий контекст:\n${recentLines.join('\n')}`);
  }

  return sections.filter(Boolean).join('\n\n').trim();
}

function buildMemoryExtractionPrompt({ userName, channelName, userText, botReply, recentMessages = [], existingContext = '' }) {
  const recent = recentMessages.slice(-6).map(msg => `${msg.name}: ${truncate(msg.text, 160)}`).join('\n');
  return [
    'Ты — модуль долговременной памяти Discord-бота.',
    'Твоя задача: решить, что стоит запомнить надолго, а что нет.',
    'Сохраняй только устойчивое и полезное: предпочтения, факты, проекты, планы, ограничения, стиль общения, повторяющиеся темы, решения и важные изменения.',
    'Игнорируй шутки, одноразовые детали и мусор.',
    'Если память уже есть, обновляй её кратко, а не раздувай.',
    'Верни ТОЛЬКО JSON без markdown, пояснений и лишнего текста.',
    '',
    'Формат JSON:',
    '{',
    '  "should_store": true,',
    '  "global_summary_update": "краткая общая сводка, если изменилась",',
    '  "channel_summary_update": "краткая сводка темы канала, если изменилась",',
    '  "user_summary_update": "краткая сводка о пользователе, если изменилась",',
    '  "notes_add": [',
    '    {"scope":"user|channel|global", "text":"до 180 символов", "importance": 1, "category":"preference|fact|project|plan|style|constraint|other", "confidence": 0.0}',
    '  ],',
    '  "notes_remove": [',
    '    {"scope":"user|channel|global", "match":"что убрать"}',
    '  ]',
    '}',
    '',
    `Пользователь: ${userName || 'unknown'}`,
    `Канал: ${channelName || 'unknown'}`,
    `Сообщение пользователя: ${truncate(userText, 1200)}`,
    `Ответ бота: ${truncate(botReply, 1200)}`,
    '',
    existingContext ? `Текущая память:\n${existingContext}` : 'Текущая память: пусто',
    recent ? `\nПоследние сообщения:\n${recent}` : '',
  ].filter(Boolean).join('\n');
}

function extractJsonPayload(text) {
  const raw = normalizeText(text);
  if (!raw) return null;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ? fenced[1].trim() : raw;

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  const jsonText = candidate.slice(start, end + 1);
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

module.exports = {
  createEmptyMemory,
  normalizeMemory,
  migrateLegacyMemory,
  buildMemoryContext,
  buildMemoryExtractionPrompt,
  extractJsonPayload,
  applyMemoryUpdate,
  scopeForUser,
  scopeForChannel,
  relevantNotes,
  normalizeScopeKey,
  truncate,
  tokenize,
  overlapScore,
};
