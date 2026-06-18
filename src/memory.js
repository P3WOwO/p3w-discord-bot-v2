
const DEFAULT_MEMORY_VERSION = 3;
const GLOBAL_NOTE_LIMIT = 12;
const CHANNEL_NOTE_LIMIT = 10;
const USER_NOTE_LIMIT = 14;
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

const CATEGORY_BONUS = {
  opinion: 2.4,
  preference: 1.9,
  fact: 1.6,
  constraint: 1.7,
  style: 1.4,
  project: 1.1,
  plan: 1.0,
  other: 1.0,
};

function createEmptyProfile() {
  return {
    summary: '',
    lastUpdatedAt: null,
  };
}

function createEmptyMemory() {
  return {
    schemaVersion: DEFAULT_MEMORY_VERSION,
    globalSummary: '',
    globalNotes: [],
    assistantProfile: createEmptyProfile(),
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

function splitSentences(value) {
  return normalizeText(value)
    .split(/(?<=[.!?。！？])\s+|\n+/u)
    .map(part => normalizeText(part))
    .filter(Boolean);
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

function sanitizeProfile(profile) {
  if (!profile || typeof profile !== 'object') return createEmptyProfile();
  return {
    summary: truncate(profile.summary || profile.text || '', SUMMARY_LIMIT),
    lastUpdatedAt: profile.lastUpdatedAt || profile.updatedAt || null,
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

function scoreNote(note) {
  const importance = Math.max(1, Math.min(5, Number(note?.importance || 1) || 1));
  const confidence = Math.max(0, Math.min(1, Number(note?.confidence ?? 0.75) || 0.75));
  const updated = new Date(note?.updatedAt || note?.createdAt || 0).getTime();
  const recency = Number.isFinite(updated) ? updated / 1e13 : 0;
  const category = normalizeText(note?.category || 'other').toLowerCase();
  const bonus = CATEGORY_BONUS[category] ?? CATEGORY_BONUS.other;
  return importance * 10 + confidence * 4 + bonus + recency;
}

function sortNotes(notes) {
  return [...notes].sort((a, b) => scoreNote(b) - scoreNote(a));
}

function notesAreSimilar(a, b) {
  const textA = normalizeText(a?.text).toLowerCase();
  const textB = normalizeText(b?.text).toLowerCase();
  if (!textA || !textB) return false;
  if (textA === textB) return true;
  if (textA.includes(textB) || textB.includes(textA)) return true;
  return overlapScore(textA, textB) >= 0.72;
}

function dedupeNotes(notes) {
  const deduped = [];
  for (const rawNote of notes) {
    const note = sanitizeNote(rawNote);
    if (!note) continue;

    const idx = deduped.findIndex(existing => notesAreSimilar(existing, note));
    if (idx === -1) {
      deduped.push(note);
      continue;
    }

    const existing = deduped[idx];
    const existingScore = scoreNote(existing);
    const nextScore = scoreNote(note);
    if (nextScore >= existingScore) deduped[idx] = { ...existing, ...note, updatedAt: new Date().toISOString() };
  }
  return deduped;
}

function pruneNotes(notes, limit) {
  return sortNotes(dedupeNotes(notes)).slice(0, limit);
}

function compactSummary(existing, update, max = SUMMARY_LIMIT) {
  const pieces = [];
  const seen = [];

  for (const source of [existing, update]) {
    for (const sentence of splitSentences(source)) {
      const normalized = sentence.toLowerCase();
      if (!normalized) continue;
      const duplicate = seen.some(prev => prev === normalized || overlapScore(prev, normalized) >= 0.78);
      if (duplicate) continue;
      seen.push(normalized);
      pieces.push(sentence);
    }
  }

  return truncate(pieces.join(' '), max);
}

function mergeSummary(existing, update, max = SUMMARY_LIMIT) {
  const next = truncate(update, max);
  if (!next) return truncate(existing, max);
  if (!existing) return next;
  return compactSummary(existing, next, max);
}

function trimLegacyHistory(entries, limit = 8) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter(item => item && typeof item === 'object')
    .map(item => ({
      role: normalizeText(item.role || 'user').slice(0, 20),
      name: normalizeText(item.name || '').slice(0, 80),
      text: truncate(item.text || '', 300),
    }))
    .slice(-limit);
}

function normalizeChannel(value) {
  return {
    summary: truncate(value?.summary || '', SUMMARY_LIMIT),
    notes: pruneNotes(Array.isArray(value?.notes) ? value.notes.map(sanitizeNote).filter(Boolean) : [], CHANNEL_NOTE_LIMIT),
    displayName: normalizeText(value?.displayName || ''),
    lastUpdatedAt: value?.lastUpdatedAt || null,
    lastSeenAt: value?.lastSeenAt || null,
    legacyHistory: trimLegacyHistory(value?.legacyHistory, 8),
  };
}

function normalizeUser(value) {
  return {
    displayName: normalizeText(value?.displayName || ''),
    summary: truncate(value?.summary || '', SUMMARY_LIMIT),
    notes: pruneNotes(Array.isArray(value?.notes) ? value.notes.map(sanitizeNote).filter(Boolean) : [], USER_NOTE_LIMIT),
    lastUpdatedAt: value?.lastUpdatedAt || null,
    lastSeenAt: value?.lastSeenAt || null,
  };
}

function migrateLegacyMemory(raw) {
  const memory = createEmptyMemory();

  if (!raw || typeof raw !== 'object') return memory;

  if (typeof raw.globalSummary === 'string') memory.globalSummary = truncate(raw.globalSummary, SUMMARY_LIMIT);
  if (Array.isArray(raw.globalNotes)) memory.globalNotes = pruneNotes(raw.globalNotes.map(sanitizeNote).filter(Boolean), GLOBAL_NOTE_LIMIT);
  if (raw.assistantProfile && typeof raw.assistantProfile === 'object') {
    memory.assistantProfile = sanitizeProfile(raw.assistantProfile);
  }

  if (raw.channels && typeof raw.channels === 'object' && !Array.isArray(raw.channels)) {
    for (const [channelId, value] of Object.entries(raw.channels)) {
      memory.channels[channelId] = normalizeChannel(value);
    }
  }

  if (raw.users && typeof raw.users === 'object' && !Array.isArray(raw.users)) {
    for (const [scopeKey, value] of Object.entries(raw.users)) {
      memory.users[scopeKey] = normalizeUser(value);
    }
  }

  // Legacy format: ai_memory[channelId] = [{role,name,text}, ...]
  for (const [key, value] of Object.entries(raw)) {
    if (['schemaVersion', 'globalSummary', 'globalNotes', 'assistantProfile', 'channels', 'users'].includes(key)) continue;
    if (!Array.isArray(value)) continue;
    memory.channels[key] = {
      summary: '',
      notes: [],
      displayName: '',
      lastUpdatedAt: null,
      lastSeenAt: null,
      legacyHistory: trimLegacyHistory(value, 8),
    };
  }

  return memory;
}

function normalizeMemory(raw) {
  if (!raw || typeof raw !== 'object') return createEmptyMemory();

  if (raw.schemaVersion === DEFAULT_MEMORY_VERSION) {
    const memory = {
      schemaVersion: DEFAULT_MEMORY_VERSION,
      globalSummary: truncate(raw.globalSummary || '', SUMMARY_LIMIT),
      globalNotes: pruneNotes(Array.isArray(raw.globalNotes) ? raw.globalNotes.map(sanitizeNote).filter(Boolean) : [], GLOBAL_NOTE_LIMIT),
      assistantProfile: sanitizeProfile(raw.assistantProfile),
      channels: Object.fromEntries(
        Object.entries(raw.channels || {}).map(([channelId, value]) => [channelId, normalizeChannel(value)])
      ),
      users: Object.fromEntries(
        Object.entries(raw.users || {}).map(([scopeKey, value]) => [scopeKey, normalizeUser(value)])
      ),
    };
    return rebalanceMemory(memory);
  }

  const migrated = migrateLegacyMemory(raw);
  return rebalanceMemory(migrated);
}

function rebalanceMemory(memoryInput) {
  const memory = clone(memoryInput || createEmptyMemory());

  memory.schemaVersion = DEFAULT_MEMORY_VERSION;
  memory.globalSummary = truncate(memory.globalSummary || '', SUMMARY_LIMIT);
  memory.globalNotes = pruneNotes(memory.globalNotes || [], GLOBAL_NOTE_LIMIT);
  memory.assistantProfile = sanitizeProfile(memory.assistantProfile);

  memory.channels = Object.fromEntries(
    Object.entries(memory.channels || {}).map(([channelId, value]) => {
      const channel = normalizeChannel(value);
      if (channel.summary) {
        channel.notes = channel.notes.filter(note => overlapScore(note.text, channel.summary) < 0.9);
      }
      return [channelId, channel];
    })
  );

  memory.users = Object.fromEntries(
    Object.entries(memory.users || {}).map(([scopeKey, value]) => {
      const user = normalizeUser(value);
      if (user.summary) {
        user.notes = user.notes.filter(note => overlapScore(note.text, user.summary) < 0.9);
      }
      return [scopeKey, user];
    })
  );

  return memory;
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
  const existingIndex = notes.findIndex(item => {
    const existingKey = normalizeText(item.text).toLowerCase();
    return existingKey === key || notesAreSimilar(item, note);
  });

  if (existingIndex >= 0) {
    const existing = notes[existingIndex];
    notes[existingIndex] = {
      ...existing,
      ...note,
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

function applyMemoryUpdate(memoryInput, { guildId, channelId, userId, userName, update = {} }) {
  const next = rebalanceMemory(memoryInput);
  const nowIso = new Date().toISOString();

  const shouldStore = update.should_store !== false;
  if (!shouldStore) return rebalanceMemory(next);

  const { user } = scopeForUser(next, guildId, userId, userName);
  const channel = scopeForChannel(next, channelId);

  if (typeof update.global_summary_update === 'string' && update.global_summary_update.trim()) {
    next.globalSummary = mergeSummary(next.globalSummary, update.global_summary_update);
  }

  if (typeof update.assistant_profile_update === 'string' && update.assistant_profile_update.trim()) {
    next.assistantProfile.summary = mergeSummary(next.assistantProfile.summary, update.assistant_profile_update);
    next.assistantProfile.lastUpdatedAt = nowIso;
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

    const filterFn = note => {
      const text = normalizeText(note.text).toLowerCase();
      return !(text.includes(match) || overlapScore(text, match) >= 0.55);
    };

    if (scope === 'global') next.globalNotes = (next.globalNotes || []).filter(filterFn);
    else if (scope === 'channel') channel.notes = (channel.notes || []).filter(filterFn);
    else user.notes = (user.notes || []).filter(filterFn);
  }

  next.globalNotes = pruneNotes(next.globalNotes || [], GLOBAL_NOTE_LIMIT);
  channel.notes = pruneNotes(channel.notes || [], CHANNEL_NOTE_LIMIT);
  user.notes = pruneNotes(user.notes || [], USER_NOTE_LIMIT);

  if (Array.isArray(channel.legacyHistory)) {
    channel.legacyHistory = trimLegacyHistory(channel.legacyHistory, 8);
  }

  return rebalanceMemory(next);
}

function queryWantsOpinion(queryText) {
  const q = normalizeText(queryText).toLowerCase();
  return [
    'думаешь', 'считаешь', 'мнение', 'как тебе', 'что лучше', 'стоит ли', 'оцен', 'посовет', 'предпоч',
  ].some(token => q.includes(token));
}

function relevantNotes(notes, queryText, limit = PROMPT_NOTE_LIMIT) {
  const opinionMode = queryWantsOpinion(queryText);
  const scored = (Array.isArray(notes) ? notes : []).map(note => {
    const text = note?.text || '';
    const overlap = overlapScore(text, queryText);
    const recency = new Date(note?.updatedAt || note?.createdAt || 0).getTime() / 1e13;
    const importance = (Number(note?.importance || 1) || 1) / 5;
    const category = normalizeText(note?.category || 'other').toLowerCase();
    const categoryBonus = CATEGORY_BONUS[category] ?? CATEGORY_BONUS.other;
    const opinionBonus = opinionMode && category === 'opinion' ? 2.5 : 0;
    const score = overlap * 8 + importance * 3 + categoryBonus + opinionBonus + recency;
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

function compactRecentMessages(recentMessages, queryText, limit = 4) {
  if (!Array.isArray(recentMessages) || recentMessages.length === 0) return [];
  const normalized = recentMessages
    .map((msg, index) => ({
      index,
      name: normalizeText(msg?.name || 'unknown').slice(0, 80),
      text: truncate(msg?.text || '', 160),
    }))
    .filter(msg => msg.text);

  if (normalized.length <= limit) return normalized;

  const tailCount = Math.min(2, limit);
  const tail = normalized.slice(-tailCount);
  const pool = normalized.slice(0, -tailCount).map(msg => ({
    ...msg,
    score: overlapScore(msg.text, queryText) + msg.text.length / 1000,
  }));

  const chosen = pool.sort((a, b) => b.score - a.score).slice(0, Math.max(0, limit - tail.length));
  const merged = [...chosen, ...tail].sort((a, b) => a.index - b.index);
  return merged;
}

function buildMemoryContext(memoryInput, { guildId, channelId, userId, userName = '', channelName = '', queryText = '', recentMessages = [] }) {
  const memory = rebalanceMemory(normalizeMemory(memoryInput));
  const userScope = memory.users[normalizeScopeKey(guildId, userId)] || null;
  const channelScope = memory.channels[channelId] || null;

  const userNotes = relevantNotes(userScope?.notes || [], queryText, 4);
  const channelNotes = relevantNotes(channelScope?.notes || [], queryText, 3);
  const globalOpinionNotes = relevantNotes(
    (memory.globalNotes || []).filter(note => normalizeText(note?.category || '').toLowerCase() === 'opinion'),
    queryText,
    2
  );
  const globalNotes = relevantNotes(memory.globalNotes || [], queryText, 3);
  const recent = compactRecentMessages(recentMessages, queryText, 4);

  const sections = [];

  if (memory.assistantProfile?.summary) {
    sections.push(`Профиль бота: ${truncate(memory.assistantProfile.summary, 360)}`);
  }

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
    if (userNotes.length) {
      lines.push('Важное:');
      for (const note of userNotes) lines.push(formatNoteLine(note));
    }
    sections.push(`Память о ${title}:\n${lines.join('\n')}`);
  }

  if (globalOpinionNotes.length) {
    const lines = globalOpinionNotes.map(formatNoteLine);
    sections.push(`Позиция/мнения:\n${lines.join('\n')}`);
  }

  if (channelNotes.length) {
    const lines = channelNotes.map(formatNoteLine);
    sections.push(`Полезное по каналу:\n${lines.join('\n')}`);
  }

  const remainingGlobalNotes = globalNotes.filter(note => !globalOpinionNotes.includes(note));
  if (remainingGlobalNotes.length) {
    const lines = remainingGlobalNotes.map(formatNoteLine);
    sections.push(`Глобальные заметки:\n${lines.join('\n')}`);
  }

  if (recent.length) {
    const recentLines = recent.map(msg => `${msg.name}: ${msg.text}`);
    sections.push(`Свежий контекст:\n${recentLines.join('\n')}`);
  }

  return sections.filter(Boolean).join('\n\n').trim();
}

function buildMemoryExtractionPrompt({ userName, channelName, userText, botReply, recentMessages = [], existingContext = '' }) {
  const recent = compactRecentMessages(recentMessages, `${userText} ${botReply}`, 6)
    .map(msg => `${msg.name}: ${truncate(msg.text, 160)}`)
    .join('\n');

  return [
    'Ты — модуль долговременной памяти Discord-бота.',
    'Твоя задача: решить, что стоит запомнить надолго, что считать мнением/выводом, а что удалить как мусор.',
    'Запоминай только устойчивое и полезное: предпочтения, факты, проекты, планы, ограничения, стиль общения, повторяющиеся темы, решения, противоречия и важные изменения.',
    'Если это одноразовая шутка, случайная эмоция, шум или слишком слабая деталь — не запоминай.',
    'Если запись устарела, дублирует другую, противоречит более свежей информации или стала неважной — удали её через notes_remove.',
    'Если в поведении или теме есть устойчивый вывод, добавь его в assistant_profile_update или как global note категории opinion.',
    'Если память не должна обновляться, верни {"should_store": false}.',
    'Верни ТОЛЬКО JSON без markdown, пояснений и лишнего текста.',
    '',
    'Формат JSON:',
    '{',
    '  "should_store": true,',
    '  "global_summary_update": "краткая общая сводка, если изменилась",',
    '  "assistant_profile_update": "краткая стабильная сводка о стиле, позиции, предпочтениях и характере бота, если появилась новая устойчивая информация",',
    '  "channel_summary_update": "краткая сводка темы канала, если изменилась",',
    '  "user_summary_update": "краткая сводка о пользователе, если изменилась",',
    '  "notes_add": [',
    '    {"scope":"user|channel|global", "text":"до 180 символов", "importance": 1, "category":"preference|fact|project|plan|style|constraint|opinion|other", "confidence": 0.0}',
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
  createEmptyProfile,
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
  rebalanceMemory,
};
