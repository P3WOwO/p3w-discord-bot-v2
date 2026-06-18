
const DEFAULT_MEMORY_VERSION = 4;
const GLOBAL_NOTE_LIMIT = 12;
const CHANNEL_NOTE_LIMIT = 10;
const USER_NOTE_LIMIT = 14;
const SUMMARY_LIMIT = 900;
const NOTE_LIMIT = 220;
const PROMPT_NOTE_LIMIT = 6;
const REBUILD_USER_LIMIT = 18;
const REBUILD_CHANNEL_LIMIT = 12;
const REBUILD_NOTE_LIMIT = 8;

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
  opinion: 2.6,
  preference: 2.0,
  fact: 1.8,
  constraint: 1.7,
  style: 1.5,
  project: 1.2,
  plan: 1.1,
  other: 1.0,
};

function createEmptyProfile() {
  return {
    summary: '',
    lastUpdatedAt: null,
  };
}

function createEmptyMeta() {
  return {
    lastUpdateAt: null,
    lastRebuildAt: null,
    lastRebuildReason: '',
    rebuildCount: 0,
    turnCount: 0,
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
    memoryMeta: createEmptyMeta(),
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

function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return createEmptyMeta();
  return {
    lastUpdateAt: meta.lastUpdateAt || meta.updatedAt || null,
    lastRebuildAt: meta.lastRebuildAt || null,
    lastRebuildReason: normalizeText(meta.lastRebuildReason || ''),
    rebuildCount: Math.max(0, Number(meta.rebuildCount || 0) || 0),
    turnCount: Math.max(0, Number(meta.turnCount || 0) || 0),
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

function noteLooksStale(note, { maxAgeDays = 180 } = {}) {
  const importance = Math.max(1, Math.min(5, Number(note?.importance || 1) || 1));
  const confidence = Math.max(0, Math.min(1, Number(note?.confidence ?? 0.75) || 0.75));
  const created = new Date(note?.updatedAt || note?.createdAt || 0).getTime();
  if (!Number.isFinite(created) || created <= 0) return false;
  const ageDays = (Date.now() - created) / (1000 * 60 * 60 * 24);
  if (ageDays < maxAgeDays) return false;
  return importance <= 2 && confidence < 0.8;
}

function dedupeNotes(notes) {
  const deduped = [];
  for (const rawNote of notes) {
    const note = sanitizeNote(rawNote);
    if (!note) continue;
    if (noteLooksStale(note)) continue;

    const idx = deduped.findIndex(existing => notesAreSimilar(existing, note));
    if (idx === -1) {
      deduped.push(note);
      continue;
    }

    const existing = deduped[idx];
    const existingScore = scoreNote(existing);
    const nextScore = scoreNote(note);
    if (nextScore >= existingScore) {
      deduped[idx] = {
        ...existing,
        ...note,
        updatedAt: new Date().toISOString(),
      };
    } else {
      deduped[idx] = {
        ...note,
        ...existing,
        updatedAt: new Date().toISOString(),
      };
    }
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
    if (['schemaVersion', 'globalSummary', 'globalNotes', 'assistantProfile', 'channels', 'users', 'memoryMeta'].includes(key)) continue;
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

  memory.memoryMeta = sanitizeMeta(raw.memoryMeta);
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
      memoryMeta: sanitizeMeta(raw.memoryMeta),
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
  memory.memoryMeta = sanitizeMeta(memory.memoryMeta);

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

function dropLowValueNotes(notes, limit) {
  const prepared = dedupeNotes(notes);
  if (prepared.length <= limit) return prepared;
  const scored = prepared.map(note => {
    const age = new Date(note.updatedAt || note.createdAt || Date.now()).getTime();
    const ageBoost = Number.isFinite(age) ? age / 1e13 : 0;
    const score = scoreNote(note) + ageBoost;
    return { note, score };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => item.note);
}

function applyMemoryUpdate(memoryInput, { guildId, channelId, userId, userName, update = {} }) {
  const next = rebalanceMemory(memoryInput);
  const nowIso = new Date().toISOString();

  const shouldStore = update.should_store !== false;
  if (!shouldStore) return rebalanceMemory(next);

  const { user } = scopeForUser(next, guildId, userId, userName);
  const channel = scopeForChannel(next, channelId);

  next.memoryMeta.lastUpdateAt = nowIso;
  next.memoryMeta.turnCount = Math.max(0, Number(next.memoryMeta.turnCount || 0) || 0) + 1;

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

  next.globalNotes = dropLowValueNotes(next.globalNotes || [], GLOBAL_NOTE_LIMIT);
  channel.notes = dropLowValueNotes(channel.notes || [], CHANNEL_NOTE_LIMIT);
  user.notes = dropLowValueNotes(user.notes || [], USER_NOTE_LIMIT);

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

function extractRelevantSentences(summary, queryText, limit = 2) {
  const sentences = splitSentences(summary);
  if (!sentences.length) return [];
  return sentences
    .map(sentence => ({
      sentence,
      score: overlapScore(sentence, queryText) + Math.min(0.4, sentence.length / 800),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => item.sentence);
}

function formatNoteLine(note) {
  const prefix = note.importance >= 4 ? '★' : note.importance === 3 ? '•' : '·';
  return `${prefix} ${truncate(note.text, 180)}`;
}

function formatSearchHit(hit) {
  const prefix = hit.kind === 'summary' ? '↳' : '•';
  return `${prefix} ${hit.label}: ${truncate(hit.text, 180)}`;
}

function searchMemory(memoryInput, { guildId, channelId, userId, userName = '', channelName = '', queryText = '', limit = 6 } = {}) {
  const memory = rebalanceMemory(normalizeMemory(memoryInput));
  const userScope = memory.users[normalizeScopeKey(guildId, userId)] || null;
  const channelScope = memory.channels[channelId] || null;
  const q = normalizeText(queryText);

  const hits = [];
  const pushHit = (scope, kind, label, text, score) => {
    const clean = truncate(text, kind === 'summary' ? SUMMARY_LIMIT : NOTE_LIMIT);
    if (!clean) return;
    hits.push({ scope, kind, label, text: clean, score });
  };

  if (userScope) {
    for (const sentence of extractRelevantSentences(userScope.summary, q, 2)) {
      pushHit('user', 'summary', userScope.displayName || userName || 'Пользователь', sentence, overlapScore(sentence, q) + 1.2);
    }
    for (const note of relevantNotes(userScope.notes, q, 4)) {
      pushHit('user', 'note', userScope.displayName || userName || 'Пользователь', note.text, overlapScore(note.text, q) + scoreNote(note));
    }
  }

  if (channelScope) {
    const channelLabel = channelScope.displayName || channelName || 'Канал';
    for (const sentence of extractRelevantSentences(channelScope.summary, q, 2)) {
      pushHit('channel', 'summary', channelLabel, sentence, overlapScore(sentence, q) + 1.0);
    }
    for (const note of relevantNotes(channelScope.notes, q, 3)) {
      pushHit('channel', 'note', channelLabel, note.text, overlapScore(note.text, q) + scoreNote(note));
    }
  }

  const globalCandidates = [
    ...extractRelevantSentences(memory.globalSummary, q, 2).map(sentence => ({ kind: 'summary', label: 'Общая сводка', text: sentence, score: overlapScore(sentence, q) + 0.9 })),
    ...relevantNotes(memory.globalNotes || [], q, 4).map(note => ({ kind: 'note', label: 'Глобальная память', text: note.text, score: overlapScore(note.text, q) + scoreNote(note) })),
  ];

  for (const item of globalCandidates) {
    pushHit('global', item.kind, item.label, item.text, item.score);
  }

  const unique = [];
  for (const hit of hits.sort((a, b) => b.score - a.score)) {
    const key = `${hit.kind}:${normalizeText(hit.text).toLowerCase()}`;
    if (unique.some(x => x.key === key)) continue;
    unique.push({ key, ...hit });
  }

  return unique.slice(0, limit).map(({ key, ...hit }) => hit);
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
  const searchHits = searchMemory(memory, { guildId, channelId, userId, userName, channelName, queryText, limit: 5 });
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

  if (searchHits.length) {
    sections.push(`Смысловой поиск:\n${searchHits.map(formatSearchHit).join('\n')}`);
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
    'Каждый пользователь должен иметь свою отдельную память. Не смешивай данные разных людей.',
    'Если это одноразовая шутка, случайная эмоция, шум или слишком слабая деталь — не запоминай.',
    'Если запись устарела, дублирует другую, противоречит более свежей информации или стала неважной — удали её через notes_remove.',
    'Если новая информация уточняет старую, считай старую запись устаревшей и замени её новой.',
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

function buildMemoryRebuildPrompt(memoryInput, { reason = 'periodic', maxUsers = REBUILD_USER_LIMIT, maxChannels = REBUILD_CHANNEL_LIMIT } = {}) {
  const memory = rebalanceMemory(normalizeMemory(memoryInput));

  const sortedUsers = Object.entries(memory.users || {})
    .sort((a, b) => {
      const aMeta = a[1] || {};
      const bMeta = b[1] || {};
      const aScore = (aMeta.notes?.length || 0) + (aMeta.summary ? 1 : 0) + new Date(aMeta.lastSeenAt || aMeta.lastUpdatedAt || 0).getTime() / 1e13;
      const bScore = (bMeta.notes?.length || 0) + (bMeta.summary ? 1 : 0) + new Date(bMeta.lastSeenAt || bMeta.lastUpdatedAt || 0).getTime() / 1e13;
      return bScore - aScore;
    })
    .slice(0, maxUsers)
    .map(([scopeKey, value]) => [scopeKey, {
      displayName: value.displayName,
      summary: truncate(value.summary || '', SUMMARY_LIMIT),
      notes: pruneNotes(value.notes || [], REBUILD_NOTE_LIMIT),
      lastUpdatedAt: value.lastUpdatedAt || null,
      lastSeenAt: value.lastSeenAt || null,
    }]);

  const sortedChannels = Object.entries(memory.channels || {})
    .sort((a, b) => {
      const aMeta = a[1] || {};
      const bMeta = b[1] || {};
      const aScore = (aMeta.notes?.length || 0) + (aMeta.summary ? 1 : 0) + new Date(aMeta.lastSeenAt || aMeta.lastUpdatedAt || 0).getTime() / 1e13;
      const bScore = (bMeta.notes?.length || 0) + (bMeta.summary ? 1 : 0) + new Date(bMeta.lastSeenAt || bMeta.lastUpdatedAt || 0).getTime() / 1e13;
      return bScore - aScore;
    })
    .slice(0, maxChannels)
    .map(([channelId, value]) => [channelId, {
      summary: truncate(value.summary || '', SUMMARY_LIMIT),
      notes: pruneNotes(value.notes || [], REBUILD_NOTE_LIMIT),
      displayName: value.displayName || '',
      lastUpdatedAt: value.lastUpdatedAt || null,
      lastSeenAt: value.lastSeenAt || null,
    }]);

  const snapshot = {
    schemaVersion: memory.schemaVersion,
    globalSummary: truncate(memory.globalSummary || '', SUMMARY_LIMIT),
    globalNotes: pruneNotes(memory.globalNotes || [], GLOBAL_NOTE_LIMIT),
    assistantProfile: sanitizeProfile(memory.assistantProfile),
    channels: Object.fromEntries(sortedChannels),
    users: Object.fromEntries(sortedUsers),
    memoryMeta: sanitizeMeta(memory.memoryMeta),
  };

  return [
    'Ты — модуль пересборки долговременной памяти Discord-бота.',
    'Твоя задача: сжать и очистить память без потери важных устойчивых фактов.',
    'Объединяй дубли, убирай мусор, сокращай длинные формулировки, но не смешивай разных пользователей.',
    'Если старый факт уточнён новым, замени старый новым.',
    'Если запись одноразовая, шумная или неважная — удали её.',
    'Сохрани отдельные профили пользователей и каналы. Не переноси факты одного человека в память другого.',
    'Верни ТОЛЬКО валидный JSON объекта памяти в том же формате, что и входной снимок.',
    '',
    `Причина пересборки: ${reason}`,
    '',
    JSON.stringify(snapshot, null, 2),
  ].join('\n');
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
  buildMemoryRebuildPrompt,
  extractJsonPayload,
  applyMemoryUpdate,
  scopeForUser,
  scopeForChannel,
  relevantNotes,
  searchMemory,
  normalizeScopeKey,
  truncate,
  tokenize,
  overlapScore,
  rebalanceMemory,
  sanitizeMeta,
  sanitizeNote,
  createEmptyMeta,
  formatNoteLine,
  compactRecentMessages,
};
