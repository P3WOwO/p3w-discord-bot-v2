const DEFAULT_MEMORY_VERSION = 6;

const GLOBAL_NOTE_LIMIT = 8;
const CHANNEL_NOTE_LIMIT = 6;
const USER_NOTE_LIMIT = 8;
const SUMMARY_LIMIT = 220;
const DIGEST_LIMIT = 260;
const NOTE_LIMIT = 220;
const PROMPT_NOTE_LIMIT = 4;
const GLOBAL_PENDING_REVIEW_LIMIT = 6;
const CHANNEL_PENDING_REVIEW_LIMIT = 5;
const USER_PENDING_REVIEW_LIMIT = 6;
const LEGACY_HISTORY_LIMIT = 8;

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
  'более', 'всегда', 'конечно', 'всю', 'между', 'это', 'эти', 'тогда', 'там', 'сюда', 'туда', 'зато'
]);


const SYNONYM_GROUPS = [
  ['javascript', 'js', 'яваскрипт', 'джс'],
  ['typescript', 'ts', 'тайпскрипт', 'тс'],
  ['python', 'py', 'питон', 'пайтон'],
  ['discord', 'дискорд', 'dc'],
  ['supabase', 'супабейс'],
  ['gemini', 'джемини', 'гугл-аи'],
  ['prompt', 'промпт', 'запрос'],
  ['memory', 'память', 'memor', 'mem'],
  ['project', 'проект', 'задача', 'таск'],
  ['preference', 'предпочт', 'люблю', 'нравится'],
  ['constraint', 'ограничение', 'нельзя', 'не могу'],
  ['fact', 'факт', 'истина'],
];

function expandTokens(tokens) {
  const set = new Set(tokens);
  const lower = [...set];
  for (const group of SYNONYM_GROUPS) {
    const hits = group.filter(term => lower.includes(term));
    if (!hits.length) continue;
    for (const term of group) set.add(term);
  }
  return [...set];
}

const CATEGORY_BONUS = {
  opinion: 2.6,
  preference: 2.2,
  fact: 1.8,
  constraint: 1.9,
  style: 1.5,
  project: 1.3,
  plan: 1.0,
  other: 1.0,
};

const RISK_KEYWORDS = [
  'вор', 'ворует', 'обманщик', 'лжец', 'лгун', 'мошенник', 'преступник', 'наркоман', 'алкоголик',
  'извращенец', 'педофил', 'насильник', 'убил', 'убийца', 'угрожал', 'домогался', 'клеит', 'клевета',
  'сплетня', 'токсичн', 'мерзкий', 'подлый', 'грязный', 'опасный', 'болен', 'диагноз', 'секрет', 'адрес',
  'телефон', 'паспорт', 'дox', 'dox', 'doxx', 'doxxing'
];

function createEmptyProfile() {
  return {
    summary: '',
    digest: '',
    lastUpdatedAt: null,
    lastRebuiltAt: null,
  };
}

function createEmptyUser(displayName = '') {
  return {
    displayName: normalizeText(displayName),
    summary: '',
    digest: '',
    notes: [],
    pendingReviews: [],
    lastUpdatedAt: null,
    lastSeenAt: null,
    lastRebuiltAt: null,
  };
}

function createEmptyChannel(channelName = '') {
  return {
    summary: '',
    digest: '',
    notes: [],
    pendingReviews: [],
    displayName: normalizeText(channelName),
    lastUpdatedAt: null,
    lastSeenAt: null,
    lastRebuiltAt: null,
    legacyHistory: [],
  };
}

function createEmptyMemory() {
  return {
    schemaVersion: DEFAULT_MEMORY_VERSION,
    globalSummary: '',
    globalDigest: '',
    globalNotes: [],
    globalPendingReviews: [],
    assistantProfile: createEmptyProfile(),
    channels: {},
    users: {},
    memoryMeta: {
      lastUpdateAt: null,
      lastCompactionAt: null,
      compactionCount: 0,
    },
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
  const setA = new Set(expandTokens(tokenize(a)));
  const setB = new Set(expandTokens(tokenize(b)));
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

function stableKeyFromText(text, category = 'other') {
  const tokens = tokenize(text).slice(0, 5).sort();
  const base = tokens.join('|') || normalizeText(text).toLowerCase().slice(0, 40);
  return normalizeText(`${category}:${base}`).toLowerCase().replace(/\s+/g, '_').slice(0, 120);
}

function sanitizeProfile(profile) {
  if (!profile || typeof profile !== 'object') return createEmptyProfile();
  return {
    summary: truncate(profile.summary || profile.text || '', SUMMARY_LIMIT),
    digest: truncate(profile.digest || '', DIGEST_LIMIT),
    lastUpdatedAt: profile.lastUpdatedAt || profile.updatedAt || null,
    lastRebuiltAt: profile.lastRebuiltAt || null,
  };
}

function sanitizeNote(note) {
  if (!note || typeof note !== 'object') return null;
  const text = truncate(note.text || note.note || note.value || '', NOTE_LIMIT);
  if (!text) return null;
  const category = normalizeText(note.category || note.type || 'other').toLowerCase().slice(0, 32) || 'other';
  const importance = Math.max(1, Math.min(5, Number(note.importance ?? 3) || 3));
  const confidence = Math.max(0, Math.min(1, Number(note.confidence ?? 0.75) || 0.75));
  const createdAt = note.createdAt || note.updatedAt || new Date().toISOString();
  const updatedAt = note.updatedAt || note.createdAt || new Date().toISOString();
  const subject = truncate(note.subject || note.entity || note.target || '', 80);
  const key = normalizeText(note.key || note.id || stableKeyFromText(text, category)).toLowerCase().slice(0, 120);
  const aliases = Array.isArray(note.aliases) ? note.aliases : Array.isArray(note.tags) ? note.tags : [];
  const cleanAliases = [...new Set(aliases.map(v => normalizeText(v).toLowerCase()).filter(Boolean))].slice(0, 12);

  return {
    id: normalizeText(note.id || key).toLowerCase().slice(0, 120),
    key,
    text,
    value: truncate(note.value || text, 120),
    subject,
    aliases: cleanAliases,
    tags: cleanAliases,
    importance,
    category,
    confidence,
    createdAt,
    updatedAt,
    lastConfirmedAt: note.lastConfirmedAt || null,
    expiresAt: note.expiresAt || null,
    status: normalizeText(note.status || 'active').toLowerCase().slice(0, 20) || 'active',
    sourceMessageId: normalizeText(note.sourceMessageId || '').slice(0, 120),
    evidence: truncate(note.evidence || note.sourceText || '', 220),
    source: normalizeText(note.source || 'memory-extractor').slice(0, 80),
  };
}

function sanitizePendingReview(item) {
  if (!item || typeof item !== 'object') return null;
  const text = truncate(item.text || item.note || '', 240);
  if (!text) return null;
  const suggestedNote = sanitizeNote(item.suggested_note || item.suggestedNote || null);
  const scope = normalizeText(item.scope || 'user').toLowerCase().slice(0, 20) || 'user';

  return {
    id: normalizeText(item.id || `${scope}:${stableKeyFromText(text, item.category || 'pending')}`).toLowerCase().slice(0, 120),
    scope,
    text,
    reason: truncate(item.reason || '', 180),
    severity: Math.max(1, Math.min(5, Number(item.severity ?? 3) || 3)),
    confidence: Math.max(0, Math.min(1, Number(item.confidence ?? 0.5) || 0.5)),
    status: normalizeText(item.status || 'pending').toLowerCase().slice(0, 20) || 'pending',
    createdAt: item.createdAt || item.updatedAt || new Date().toISOString(),
    updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
    expiresAt: item.expiresAt || null,
    source: normalizeText(item.source || 'memory-extractor').slice(0, 80),
    suggestedNote,
  };
}

function scorePendingReview(item) {
  const severity = Math.max(1, Math.min(5, Number(item?.severity || 1) || 1));
  const confidence = Math.max(0, Math.min(1, Number(item?.confidence ?? 0.5) || 0.5));
  const updated = new Date(item?.updatedAt || item?.createdAt || 0).getTime();
  const recency = Number.isFinite(updated) ? updated / 1e13 : 0;
  return severity * 10 + confidence * 3 + recency;
}

function dedupePendingReviews(items) {
  const deduped = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const item = sanitizePendingReview(raw);
    if (!item) continue;
    const idx = deduped.findIndex(existing => {
      const sameId = existing.id && item.id && existing.id === item.id;
      const sameText = normalizeText(existing.text).toLowerCase() === normalizeText(item.text).toLowerCase();
      return sameId || sameText || overlapScore(existing.text, item.text) >= 0.8;
    });
    if (idx === -1) {
      deduped.push(item);
      continue;
    }
    if (scorePendingReview(item) >= scorePendingReview(deduped[idx])) {
      deduped[idx] = { ...deduped[idx], ...item, updatedAt: new Date().toISOString() };
    }
  }
  return deduped;
}

function prunePendingReviews(items, limit) {
  return dedupePendingReviews(items)
    .sort((a, b) => scorePendingReview(b) - scorePendingReview(a))
    .slice(0, limit);
}

function noteScore(note) {
  const importance = Math.max(1, Math.min(5, Number(note?.importance || 1) || 1));
  const confidence = Math.max(0, Math.min(1, Number(note?.confidence ?? 0.75) || 0.75));
  const updated = new Date(note?.updatedAt || note?.createdAt || 0).getTime();
  const recency = Number.isFinite(updated) ? updated / 1e13 : 0;
  const category = normalizeText(note?.category || 'other').toLowerCase();
  const bonus = CATEGORY_BONUS[category] ?? CATEGORY_BONUS.other;
  return importance * 10 + confidence * 4 + bonus + recency;
}

function sortNotes(notes) {
  return [...notes].sort((a, b) => noteScore(b) - noteScore(a));
}

function notesAreSimilar(a, b) {
  const textA = normalizeText(a?.text).toLowerCase();
  const textB = normalizeText(b?.text).toLowerCase();
  if (!textA || !textB) return false;
  if (textA === textB) return true;
  if (a?.key && b?.key && a.key === b.key) return true;

  const catA = normalizeText(a?.category || a?.entityType || '').toLowerCase();
  const catB = normalizeText(b?.category || b?.entityType || '').toLowerCase();
  const polarCats = new Set(['preference', 'constraint']);
  if (polarCats.has(catA) || polarCats.has(catB)) {
    if (catA !== catB) return false;
  }

  if (textA.includes(textB) || textB.includes(textA)) return true;

  const aliasesA = new Set([...(a?.aliases || []), ...(a?.tags || [])].map(v => normalizeText(v).toLowerCase()).filter(Boolean));
  const aliasesB = new Set([...(b?.aliases || []), ...(b?.tags || [])].map(v => normalizeText(v).toLowerCase()).filter(Boolean));
  for (const alias of aliasesA) if (aliasesB.has(alias)) return true;

  const subjectA = normalizeText(a?.subject || '').toLowerCase();
  const subjectB = normalizeText(b?.subject || '').toLowerCase();
  if (subjectA && subjectA === subjectB && catA && catB && catA === catB) return true;

  return overlapScore(textA, textB) >= 0.72;
}

function isExpiredNote(note) {
  const expiresAt = note?.expiresAt ? new Date(note.expiresAt).getTime() : null;
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt <= Date.now();
}

function addOrMergeNote(notes, incoming) {
  const note = sanitizeNote(incoming);
  if (!note) return notes;
  if (isExpiredNote(note)) return notes;

  const existingIndex = notes.findIndex(item => notesAreSimilar(item, note));
  if (existingIndex >= 0) {
    const existing = notes[existingIndex];
    const next = {
      ...existing,
      ...note,
      importance: Math.max(existing.importance || 1, note.importance || 1),
      confidence: Math.max(existing.confidence || 0, note.confidence || 0),
      category: note.category || existing.category || 'other',
      key: existing.key || note.key,
      updatedAt: new Date().toISOString(),
    };
    // Prefer the most recent clear formulation, but keep the better-scoring metadata.
    if (noteScore(note) >= noteScore(existing) * 0.92) {
      next.text = note.text;
    }
    notes[existingIndex] = next;
    return notes;
  }

  notes.push(note);
  return notes;
}

function pruneNotes(notes, limit) {
  const cleaned = [];
  for (const raw of Array.isArray(notes) ? notes : []) {
    const note = sanitizeNote(raw);
    if (!note || isExpiredNote(note)) continue;
    const same = cleaned.findIndex(existing => notesAreSimilar(existing, note));
    if (same === -1) {
      cleaned.push(note);
      continue;
    }
    if (noteScore(note) >= noteScore(cleaned[same])) cleaned[same] = { ...cleaned[same], ...note, updatedAt: new Date().toISOString() };
  }

  const pruned = cleaned
    .sort((a, b) => noteScore(b) - noteScore(a))
    .filter(note => {
      const ageMs = Date.now() - new Date(note.updatedAt || note.createdAt || 0).getTime();
      const ageDays = Number.isFinite(ageMs) ? ageMs / 86400000 : 0;
      return ageDays < 45 || note.importance >= 3 || note.confidence >= 0.7;
    })
    .slice(0, limit);

  return pruned;
}

function compactPhrase(text, limit = 80) {
  return truncate(
    normalizeText(text)
      .replace(/^(это|это\s+был|это\s+была|это\s+было)\s+/i, '')
      .replace(/^(пользователь|человек|юзер|бот)\s+/i, ''),
    limit
  );
}

function buildScopeSummary(notes, fallback = '', kind = 'user') {
  const top = sortNotes(notes).slice(0, kind === 'channel' ? 2 : 3);
  if (!top.length) return truncate(fallback, kind === 'channel' ? 180 : SUMMARY_LIMIT);

  const seen = new Set();
  const parts = [];
  for (const note of top) {
    const phrase = compactPhrase(note.text, kind === 'channel' ? 80 : 90);
    const key = phrase.toLowerCase();
    if (!phrase || seen.has(key)) continue;
    seen.add(key);
    parts.push(phrase);
  }

  const joined = parts.join(' • ');
  return truncate(joined || fallback, kind === 'channel' ? 180 : SUMMARY_LIMIT);
}

function mergeSummary(existing, update, max = SUMMARY_LIMIT) {
  const current = normalizeText(existing);
  const next = normalizeText(update);
  if (!current) return truncate(next, max);
  if (!next) return truncate(current, max);

  const seen = new Set();
  const sentences = [];
  for (const source of [current, next]) {
    for (const sentence of splitSentences(source)) {
      const normalized = sentence.toLowerCase();
      if (!normalized) continue;
      const duplicate = [...seen].some(prev => prev === normalized || overlapScore(prev, normalized) >= 0.8);
      if (duplicate) continue;
      seen.add(normalized);
      sentences.push(sentence);
    }
  }
  return truncate(sentences.join(' '), max);
}

function trimLegacyHistory(entries, limit = LEGACY_HISTORY_LIMIT) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter(item => item && typeof item === 'object')
    .map(item => ({
      role: normalizeText(item.role || 'user').slice(0, 20),
      name: normalizeText(item.name || '').slice(0, 80),
      text: truncate(item.text || '', 300),
    }))
    .filter(item => item.text)
    .slice(-limit);
}

function normalizeChannel(value) {
  const notes = pruneNotes(Array.isArray(value?.notes) ? value.notes.map(sanitizeNote).filter(Boolean) : [], CHANNEL_NOTE_LIMIT);
  const pendingReviews = prunePendingReviews(Array.isArray(value?.pendingReviews) ? value.pendingReviews.map(sanitizePendingReview).filter(Boolean) : [], CHANNEL_PENDING_REVIEW_LIMIT);
  return {
    summary: buildScopeSummary(notes, value?.summary || '', 'channel'),
    digest: truncate(value?.digest || value?.summary || '', DIGEST_LIMIT),
    notes,
    pendingReviews,
    displayName: normalizeText(value?.displayName || ''),
    lastUpdatedAt: value?.lastUpdatedAt || null,
    lastSeenAt: value?.lastSeenAt || null,
    lastRebuiltAt: value?.lastRebuiltAt || null,
    legacyHistory: trimLegacyHistory(value?.legacyHistory, LEGACY_HISTORY_LIMIT),
  };
}

function normalizeUser(value) {
  const notes = pruneNotes(Array.isArray(value?.notes) ? value.notes.map(sanitizeNote).filter(Boolean) : [], USER_NOTE_LIMIT);
  const pendingReviews = prunePendingReviews(Array.isArray(value?.pendingReviews) ? value.pendingReviews.map(sanitizePendingReview).filter(Boolean) : [], USER_PENDING_REVIEW_LIMIT);
  return {
    displayName: normalizeText(value?.displayName || ''),
    summary: buildScopeSummary(notes, value?.summary || '', 'user'),
    digest: truncate(value?.digest || value?.summary || '', DIGEST_LIMIT),
    notes,
    pendingReviews,
    lastUpdatedAt: value?.lastUpdatedAt || null,
    lastSeenAt: value?.lastSeenAt || null,
    lastRebuiltAt: value?.lastRebuiltAt || null,
  };
}

function migrateLegacyMemory(raw) {
  const memory = createEmptyMemory();
  if (!raw || typeof raw !== 'object') return memory;

  if (typeof raw.globalSummary === 'string') memory.globalSummary = truncate(raw.globalSummary, SUMMARY_LIMIT);
  if (typeof raw.globalDigest === 'string') memory.globalDigest = truncate(raw.globalDigest, DIGEST_LIMIT);
  if (Array.isArray(raw.globalNotes)) memory.globalNotes = pruneNotes(raw.globalNotes.map(sanitizeNote).filter(Boolean), GLOBAL_NOTE_LIMIT);
  if (Array.isArray(raw.globalPendingReviews)) memory.globalPendingReviews = prunePendingReviews(raw.globalPendingReviews.map(sanitizePendingReview).filter(Boolean), GLOBAL_PENDING_REVIEW_LIMIT);
  if (raw.assistantProfile && typeof raw.assistantProfile === 'object') memory.assistantProfile = sanitizeProfile(raw.assistantProfile);

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

  // Legacy pre-v4 format: channelId -> history array.
  for (const [key, value] of Object.entries(raw)) {
    if (['schemaVersion', 'globalSummary', 'globalDigest', 'globalNotes', 'globalPendingReviews', 'assistantProfile', 'channels', 'users', 'memoryMeta'].includes(key)) continue;
    if (!Array.isArray(value)) continue;
    memory.channels[key] = {
      summary: '',
      digest: '',
      notes: [],
      pendingReviews: [],
      displayName: '',
      lastUpdatedAt: null,
      lastSeenAt: null,
      lastRebuiltAt: null,
      legacyHistory: trimLegacyHistory(value, LEGACY_HISTORY_LIMIT),
    };
  }

  return memory;
}

function normalizeMemory(raw) {
  if (!raw || typeof raw !== 'object') return createEmptyMemory();
  if (raw.schemaVersion === DEFAULT_MEMORY_VERSION) return rebalanceMemory(raw);
  return rebalanceMemory(migrateLegacyMemory(raw));
}

function rebuildGlobalSummary(memory) {
  const base = buildScopeSummary(memory.globalNotes || [], memory.globalSummary || '', 'global');
  return truncate(base || memory.globalDigest || '', SUMMARY_LIMIT);
}

function rebalanceMemory(memoryInput) {
  const memory = clone(memoryInput || createEmptyMemory());
  const nowIso = new Date().toISOString();

  memory.schemaVersion = DEFAULT_MEMORY_VERSION;
  memory.memoryMeta = memory.memoryMeta && typeof memory.memoryMeta === 'object'
    ? { ...createEmptyMemory().memoryMeta, ...memory.memoryMeta }
    : { ...createEmptyMemory().memoryMeta };

  memory.globalNotes = pruneNotes(memory.globalNotes || [], GLOBAL_NOTE_LIMIT);
  memory.globalPendingReviews = prunePendingReviews(memory.globalPendingReviews || [], GLOBAL_PENDING_REVIEW_LIMIT);
  memory.globalSummary = rebuildGlobalSummary(memory);
  memory.globalDigest = truncate(memory.globalDigest || '', DIGEST_LIMIT);
  memory.assistantProfile = sanitizeProfile(memory.assistantProfile);

  const rebalanceScopeCollection = (collection, kind) => Object.fromEntries(
    Object.entries(collection || {}).map(([scopeKey, value]) => {
      const normalized = kind === 'channel' ? normalizeChannel(value) : normalizeUser(value);
      normalized.summary = buildScopeSummary(normalized.notes || [], normalized.summary || '', kind);
      normalized.digest = truncate(normalized.digest || '', DIGEST_LIMIT);
      normalized.pendingReviews = prunePendingReviews(normalized.pendingReviews || [], kind === 'channel' ? CHANNEL_PENDING_REVIEW_LIMIT : USER_PENDING_REVIEW_LIMIT);
      normalized.lastRebuiltAt = nowIso;
      if (kind === 'channel') {
        normalized.legacyHistory = trimLegacyHistory(normalized.legacyHistory || [], LEGACY_HISTORY_LIMIT);
      }
      return [scopeKey, normalized];
    })
  );

  memory.channels = rebalanceScopeCollection(memory.channels, 'channel');
  memory.users = rebalanceScopeCollection(memory.users, 'user');

  memory.memoryMeta.compactionCount = Number(memory.memoryMeta.compactionCount || 0) + 1;
  memory.memoryMeta.lastCompactionAt = nowIso;

  return memory;
}

function scopeForUser(memory, guildId, userId, displayName = '') {
  const scopeKey = normalizeScopeKey(guildId, userId);
  if (!memory.users[scopeKey]) memory.users[scopeKey] = createEmptyUser(displayName);
  const user = memory.users[scopeKey];
  if (displayName && (!user.displayName || user.displayName !== displayName)) user.displayName = normalizeText(displayName);
  user.lastSeenAt = new Date().toISOString();
  return { scopeKey, user };
}

function scopeForChannel(memory, channelId, channelName = '') {
  if (!memory.channels[channelId]) memory.channels[channelId] = createEmptyChannel(channelName);
  const channel = memory.channels[channelId];
  if (channelName && (!channel.displayName || channel.displayName !== channelName)) channel.displayName = normalizeText(channelName);
  channel.lastSeenAt = new Date().toISOString();
  return channel;
}

function shouldFlagForConfirmation(text, category = '') {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) return false;
  const cat = normalizeText(category).toLowerCase();
  if (['sensitive', 'defamation', 'accusation', 'insult', 'rumor'].includes(cat)) return true;
  if (RISK_KEYWORDS.some(word => normalized.includes(word))) return true;
  const thirdPersonHints = [' он ', ' она ', ' его ', ' её ', ' их ', ' someone ', ' кто-то ', ' человек ', 'пользователь '];
  const accusationHints = ['вор', 'лжец', 'мошенник', 'преступник', 'насил', 'угрожа', 'клевет', 'сплет', 'обман'];
  return thirdPersonHints.some(hint => normalized.includes(hint)) && accusationHints.some(hint => normalized.includes(hint));
}

function addPendingReview(collection, incoming, limit) {
  const item = sanitizePendingReview(incoming);
  if (!item) return collection;
  const idx = collection.findIndex(existing => existing.id === item.id || normalizeText(existing.text).toLowerCase() === normalizeText(item.text).toLowerCase());
  if (idx >= 0) {
    if (scorePendingReview(item) >= scorePendingReview(collection[idx])) collection[idx] = { ...collection[idx], ...item, updatedAt: new Date().toISOString() };
    return collection;
  }
  collection.push(item);
  return prunePendingReviews(collection, limit);
}

function removeNotesByMatch(notes, match) {
  const needle = normalizeText(match).toLowerCase();
  if (!needle) return notes;
  return (notes || []).filter(note => {
    const text = normalizeText(note.text).toLowerCase();
    const key = normalizeText(note.key || note.id || '').toLowerCase();
    return !(key === needle || text.includes(needle) || overlapScore(text, needle) >= 0.55);
  });
}

function removePendingByMatch(items, match) {
  const needle = normalizeText(match).toLowerCase();
  if (!needle) return items;
  return (items || []).filter(item => {
    const text = normalizeText(item.text).toLowerCase();
    const id = normalizeText(item.id).toLowerCase();
    return !(id === needle || text.includes(needle) || overlapScore(text, needle) >= 0.55);
  });
}

function rebuildDigestFromUpdate(updateText, fallback = '') {
  const source = normalizeText(updateText) || normalizeText(fallback);
  return truncate(source, DIGEST_LIMIT);
}

function applyMemoryUpdate(memoryInput, { guildId, channelId, userId, userName, update = {} }) {
  const next = rebalanceMemory(memoryInput);
  const nowIso = new Date().toISOString();
  const userScope = scopeForUser(next, guildId, userId, userName).user;
  const channelScope = scopeForChannel(next, channelId);
  const shouldStore = update.should_store !== false;

  const memoryActions = Array.isArray(update.memory_actions) ? update.memory_actions : [];
  for (const rawAction of memoryActions) {
    const action = normalizeText(rawAction?.action || '').toLowerCase();
    const scope = normalizeText(rawAction?.scope || 'user').toLowerCase();
    const match = normalizeText(rawAction?.match || rawAction?.text || '').toLowerCase();
    if (!action) continue;

    if (action === 'forget_everything') {
      return rebalanceMemory(createEmptyMemory());
    }

    if (action === 'forget_user' || (action === 'forget_all' && scope === 'user')) {
      next.users[normalizeScopeKey(guildId, userId)] = createEmptyUser(userName);
      continue;
    }

    if (action === 'forget_channel' || (action === 'forget_all' && scope === 'channel')) {
      next.channels[channelId] = createEmptyChannel(channelScope.displayName || '');
      continue;
    }

    if (action === 'forget_global' || (action === 'forget_all' && scope === 'global')) {
      next.globalSummary = '';
      next.globalDigest = '';
      next.globalNotes = [];
      next.globalPendingReviews = [];
      continue;
    }

    if (action === 'remove_note' || action === 'delete_note') {
      if (!match) continue;
      if (scope === 'global') next.globalNotes = removeNotesByMatch(next.globalNotes || [], match);
      else if (scope === 'channel') channelScope.notes = removeNotesByMatch(channelScope.notes || [], match);
      else userScope.notes = removeNotesByMatch(userScope.notes || [], match);
      continue;
    }

    if (action === 'clear_pending') {
      if (!match) continue;
      if (scope === 'global') next.globalPendingReviews = removePendingByMatch(next.globalPendingReviews || [], match);
      else if (scope === 'channel') channelScope.pendingReviews = removePendingByMatch(channelScope.pendingReviews || [], match);
      else userScope.pendingReviews = removePendingByMatch(userScope.pendingReviews || [], match);
      continue;
    }
  }

  if (!shouldStore) return rebalanceMemory(next);

  if (typeof update.global_summary_update === 'string' && update.global_summary_update.trim()) {
    next.globalDigest = rebuildDigestFromUpdate(update.global_summary_update, next.globalDigest);
  }

  if (typeof update.assistant_profile_update === 'string' && update.assistant_profile_update.trim()) {
    next.assistantProfile.summary = rebuildDigestFromUpdate(update.assistant_profile_update, next.assistantProfile.summary);
    next.assistantProfile.lastUpdatedAt = nowIso;
  }

  if (typeof update.channel_summary_update === 'string' && update.channel_summary_update.trim()) {
    channelScope.digest = rebuildDigestFromUpdate(update.channel_summary_update, channelScope.digest);
    channelScope.lastUpdatedAt = nowIso;
  }

  if (typeof update.user_summary_update === 'string' && update.user_summary_update.trim()) {
    userScope.digest = rebuildDigestFromUpdate(update.user_summary_update, userScope.digest);
    userScope.lastUpdatedAt = nowIso;
  }

  const addNotes = Array.isArray(update.notes_add) ? update.notes_add : [];
  for (const item of addNotes) {
    const note = sanitizeNote(item);
    if (!note) continue;
    const scope = normalizeText(item?.scope || 'user').toLowerCase();
    if (shouldFlagForConfirmation(note.text, note.category) || scope === 'pending') {
      const pending = sanitizePendingReview({
        id: item?.id || note.id,
        scope: scope === 'global' ? 'global' : scope === 'channel' ? 'channel' : 'user',
        text: note.text,
        reason: item?.reason || 'needs_confirmation',
        severity: item?.severity || 4,
        confidence: Math.min(note.confidence, 0.7),
        source: note.source,
        suggested_note: note,
      });
      if (scope === 'global') next.globalPendingReviews = addPendingReview(next.globalPendingReviews || [], pending, GLOBAL_PENDING_REVIEW_LIMIT);
      else if (scope === 'channel') channelScope.pendingReviews = addPendingReview(channelScope.pendingReviews || [], pending, CHANNEL_PENDING_REVIEW_LIMIT);
      else userScope.pendingReviews = addPendingReview(userScope.pendingReviews || [], pending, USER_PENDING_REVIEW_LIMIT);
      continue;
    }

    if (scope === 'global') {
      next.globalNotes = addOrMergeNote(next.globalNotes || [], note);
    } else if (scope === 'channel') {
      channelScope.notes = addOrMergeNote(channelScope.notes || [], note);
      channelScope.lastUpdatedAt = nowIso;
    } else {
      userScope.notes = addOrMergeNote(userScope.notes || [], note);
      userScope.lastUpdatedAt = nowIso;
    }
  }

  const removeNotes = Array.isArray(update.notes_remove) ? update.notes_remove : [];
  for (const item of removeNotes) {
    const scope = normalizeText(item?.scope || 'user').toLowerCase();
    const match = normalizeText(item?.match || '').toLowerCase();
    if (!match) continue;
    if (scope === 'global') next.globalNotes = removeNotesByMatch(next.globalNotes || [], match);
    else if (scope === 'channel') channelScope.notes = removeNotesByMatch(channelScope.notes || [], match);
    else userScope.notes = removeNotesByMatch(userScope.notes || [], match);
  }

  const addPending = Array.isArray(update.pending_reviews_add) ? update.pending_reviews_add : [];
  for (const raw of addPending) {
    const pending = sanitizePendingReview(raw);
    if (!pending) continue;
    const scope = normalizeText(pending.scope || 'user').toLowerCase();
    if (scope === 'global') {
      next.globalPendingReviews = addPendingReview(next.globalPendingReviews || [], pending, GLOBAL_PENDING_REVIEW_LIMIT);
    } else if (scope === 'channel') {
      channelScope.pendingReviews = addPendingReview(channelScope.pendingReviews || [], pending, CHANNEL_PENDING_REVIEW_LIMIT);
      channelScope.lastUpdatedAt = nowIso;
    } else {
      userScope.pendingReviews = addPendingReview(userScope.pendingReviews || [], pending, USER_PENDING_REVIEW_LIMIT);
      userScope.lastUpdatedAt = nowIso;
    }
  }

  const removePending = Array.isArray(update.pending_reviews_remove) ? update.pending_reviews_remove : [];
  for (const item of removePending) {
    const scope = normalizeText(item?.scope || 'user').toLowerCase();
    const match = normalizeText(item?.match || item?.text || item?.id || '').toLowerCase();
    if (!match) continue;
    if (scope === 'global') next.globalPendingReviews = removePendingByMatch(next.globalPendingReviews || [], match);
    else if (scope === 'channel') channelScope.pendingReviews = removePendingByMatch(channelScope.pendingReviews || [], match);
    else userScope.pendingReviews = removePendingByMatch(userScope.pendingReviews || [], match);
  }

  // Prune and rebuild snapshots from what is actually stored now.
  next.globalNotes = pruneNotes(next.globalNotes || [], GLOBAL_NOTE_LIMIT);
  next.globalPendingReviews = prunePendingReviews(next.globalPendingReviews || [], GLOBAL_PENDING_REVIEW_LIMIT);
  next.globalSummary = rebuildGlobalSummary(next);
  next.globalDigest = truncate(next.globalDigest || '', DIGEST_LIMIT);

  next.assistantProfile = sanitizeProfile(next.assistantProfile);
  next.assistantProfile.summary = truncate(next.assistantProfile.summary || '', SUMMARY_LIMIT);
  next.assistantProfile.digest = truncate(next.assistantProfile.digest || '', DIGEST_LIMIT);

  channelScope.notes = pruneNotes(channelScope.notes || [], CHANNEL_NOTE_LIMIT);
  channelScope.pendingReviews = prunePendingReviews(channelScope.pendingReviews || [], CHANNEL_PENDING_REVIEW_LIMIT);
  channelScope.summary = buildScopeSummary(channelScope.notes || [], channelScope.summary || '', 'channel');
  channelScope.digest = truncate(channelScope.digest || '', DIGEST_LIMIT);
  channelScope.legacyHistory = trimLegacyHistory(channelScope.legacyHistory || [], LEGACY_HISTORY_LIMIT);
  channelScope.lastUpdatedAt = channelScope.lastUpdatedAt || nowIso;

  userScope.notes = pruneNotes(userScope.notes || [], USER_NOTE_LIMIT);
  userScope.pendingReviews = prunePendingReviews(userScope.pendingReviews || [], USER_PENDING_REVIEW_LIMIT);
  userScope.summary = buildScopeSummary(userScope.notes || [], userScope.summary || '', 'user');
  userScope.digest = truncate(userScope.digest || '', DIGEST_LIMIT);
  userScope.lastUpdatedAt = userScope.lastUpdatedAt || nowIso;

  next.memoryMeta = next.memoryMeta && typeof next.memoryMeta === 'object' ? { ...createEmptyMemory().memoryMeta, ...next.memoryMeta } : { ...createEmptyMemory().memoryMeta };
  next.memoryMeta.lastUpdateAt = nowIso;
  return rebalanceMemory(next);
}

function queryWantsOpinion(queryText) {
  const q = normalizeText(queryText).toLowerCase();
  return ['думаешь', 'считаешь', 'мнение', 'как тебе', 'что лучше', 'стоит ли', 'оцен', 'посовет', 'предпоч', 'лучше'].some(token => q.includes(token));
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
  const meta = [note.category || 'other', note.subject ? `@${truncate(note.subject, 24)}` : '', note.confidence >= 0.9 ? '✓' : note.confidence >= 0.6 ? '~' : '?']
    .filter(Boolean)
    .join(' ');
  return `${prefix} ${truncate(note.text, 180)}${meta ? ` (${meta})` : ''}`;
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
  return [...chosen, ...tail].sort((a, b) => a.index - b.index);
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
    3
  );
  const globalNotes = relevantNotes(memory.globalNotes || [], queryText, 3);
  const recent = compactRecentMessages(recentMessages, queryText, 5);
  const channelLegacy = trimLegacyHistory(channelScope?.legacyHistory || [], 3);
  const sections = [];

  if (memory.assistantProfile?.summary) {
    sections.push(`Профиль бота: ${truncate(memory.assistantProfile.summary, 220)}`);
  }

  if (memory.assistantProfile?.digest) {
    sections.push(`Текущая линия бота: ${truncate(memory.assistantProfile.digest, 220)}`);
  }

  if (memory.globalSummary) {
    sections.push(`Общая сводка: ${truncate(memory.globalSummary, 220)}`);
  }

  if (memory.globalDigest) {
    sections.push(`Свежий общий фон: ${truncate(memory.globalDigest, 220)}`);
  }

  if (channelScope?.summary) {
    const title = channelScope.displayName ? `Канал ${channelScope.displayName}` : 'Канал';
    sections.push(`${title}: ${truncate(channelScope.summary, 200)}`);
  }

  if (channelScope?.digest) {
    const title = channelScope.displayName ? `Сейчас в ${channelScope.displayName}` : 'Сейчас в канале';
    sections.push(`${title}: ${truncate(channelScope.digest, 200)}`);
  }

  if (userScope?.summary || userNotes.length) {
    const title = userScope?.displayName || userName || 'Пользователь';
    const lines = [];
    if (userScope?.summary) lines.push(`Сводка: ${truncate(userScope.summary, 180)}`);
    if (userScope?.digest) lines.push(`Недавнее: ${truncate(userScope.digest, 180)}`);
    if (userNotes.length) {
      lines.push('Ключевые факты:');
      for (const note of userNotes) lines.push(formatNoteLine(note));
    }
    sections.push(`Память о ${title}:
${lines.join('\n')}`);
  }

  if (globalOpinionNotes.length) {
    sections.push(`Позиция/мнения:
${globalOpinionNotes.map(formatNoteLine).join('\n')}`);
  }

  if (channelNotes.length) {
    sections.push(`Полезное по каналу:
${channelNotes.map(formatNoteLine).join('\n')}`);
  }

  const remainingGlobalNotes = globalNotes.filter(note => !globalOpinionNotes.includes(note));
  if (remainingGlobalNotes.length) {
    sections.push(`Глобальные заметки:
${remainingGlobalNotes.map(formatNoteLine).join('\n')}`);
  }

  const pending = prunePendingReviews(userScope?.pendingReviews || [], 2);
  if (pending.length) {
    sections.push(`Неподтверждённое (если это важно, уточни):
${pending.map(item => `? ${truncate(item.text, 180)}`).join('\n')}`);
  }

  if (channelLegacy.length) {
    sections.push(`Следы недавнего диалога:
${channelLegacy.map(item => `${item.name || item.role}: ${item.text}`).join('\n')}`);
  }

  if (recent.length) {
    sections.push(`Свежий контекст:
${recent.map(msg => `${msg.name}: ${msg.text}`).join('\n')}`);
  }

  return sections.filter(Boolean).join('\n\n').trim();
}

function buildMemoryExtractionPrompt({ userName, channelName, userText, botReply, recentMessages = [], existingContext = '' }) {
  const recent = compactRecentMessages(recentMessages, `${userText} ${botReply}`, 6)
    .map(msg => `${msg.name}: ${truncate(msg.text, 160)}`)
    .join('\n');

  return [
    'Ты — модуль долговременной памяти Discord-бота.',
    'Ты НЕ отвечаешь пользователю: твоя задача только решать, что запомнить, что обновить, что удалить, а что отправить на подтверждение.',
    'Сохраняй только устойчивое и полезное: предпочтения, факты, проекты, планы, ограничения, стиль общения, повторяющиеся темы и реальные изменения.',
    'Не записывай одноразовый шум, флуд, эмоциональные всплески и повторные переформулировки.',
    'Если пользователь просит забыть, очистить или удалить память, используй memory_actions и не добавляй новые факты по этому сообщению.',
    'Если запись спорная, токсичная, обвинительная, похожа на клевету, содержит приватные данные или выглядит сомнительной — не сохраняй её как факт сразу; отправь в pending_reviews_add.',
    'Возвращай только валидный JSON без markdown, пояснений и лишнего текста.',
    '',
    'Формат JSON:',
    '{',
    '  "should_store": true,',
    '  "global_summary_update": "краткий общий фон, если нужен",',
    '  "assistant_profile_update": "краткая устойчивая сводка о стиле/характере бота, если она реально изменилась",',
    '  "channel_summary_update": "краткая сводка текущего канала или темы",',
    '  "user_summary_update": "краткая сводка о пользователе без длинных перечислений",',
    '  "notes_add": [',
    '    {"scope":"user|channel|global", "text":"до 180 символов", "value":"краткое значение", "subject":"о ком/чём это", "key":"стабильный ключ", "aliases":["синоним"], "tags":["тег"], "importance": 1, "category":"preference|fact|project|plan|style|constraint|opinion|identity|other", "confidence": 0.0, "evidence":"краткое доказательство", "expiresAt":"ISO или null"}',
    '  ],',
    '  "notes_remove": [',
    '    {"scope":"user|channel|global", "match":"что убрать"}',
    '  ],',
    '  "pending_reviews_add": [',
    '    {"scope":"user|channel|global", "text":"спорная информация", "reason":"needs_confirmation|possible_defamation|uncertain|sensitive", "severity": 1, "confidence": 0.3, "suggested_note": {"scope":"user|channel|global", "text":"что сохранить после подтверждения", "category":"fact", "importance": 1, "confidence": 0.5}}',
    '  ],',
    '  "pending_reviews_remove": [',
    '    {"scope":"user|channel|global", "match":"что снять с проверки"}',
    '  ],',
    '  "memory_actions": [',
    '    {"action":"forget_user|forget_channel|forget_global|forget_everything|remove_note|delete_note|clear_pending|confirm_note", "scope":"user|channel|global", "match":"что удалить/подтвердить"}',
    '  ]',
    '}',
    '',
    'Правила:',
    '- Если ничего не меняется, верни {"should_store": false}.',
    '- Выдавай не более 0–2 новых фактов за ход.',
    '- Для каждой записи выбирай короткий key, чтобы факты можно было обновлять, а не дублировать.',
    '- Если факт уже есть почти дословно, не дублируй его.',
    '- Если новая запись противоречит старой, лучше предложить удалить старую или обновить её, чем хранить обе.',
    '',
    `Пользователь: ${userName || 'unknown'}`,
    `Канал: ${channelName || 'unknown'}`,
    `Сообщение пользователя: ${truncate(userText, 1200)}`,
    `Ответ бота: ${truncate(botReply, 1200)}`,
    '',
    existingContext ? `Текущая память:
${existingContext}` : 'Текущая память: пусто',
    recent ? `
Последние сообщения:
${recent}` : '',
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




function deriveHeuristicMemoryUpdate({ guildId, channelId, userId, userName = '', channelName = '', userText = '', botReply = '', sourceMessageId = '' }) {
  const text = normalizeText(userText);
  if (!text) return {};
  const lower = text.toLowerCase();
  const userLabel = userName || 'пользователь';
  const notes_add = [];
  const pending_reviews_add = [];
  const memory_actions = [];

  const add = (note) => {
    if (note) notes_add.push(note);
  };

  const cleanClause = (value) => normalizeText(String(value || '').split(/(?:\s+и\s+не\s+люблю|\s+но\s+не\s+люблю|\s+и\s+не\s+нравится|\s+но\s+не\s+нравится|[,.!?;]+)/i)[0]);

  const pushNote = ({
    category = 'fact',
    textValue,
    subject = userLabel,
    importance = 4,
    confidence = 0.82,
    scope = 'user',
    aliases = [],
    tags = [],
    evidence = text,
    value = textValue || text,
    key = stableKeyFromText(textValue || text, category, subject),
    expiresAt = null,
  }) => {
    add({
      scope,
      text: truncate(textValue || text, 220),
      value: truncate(value, 120),
      subject: truncate(subject, 80),
      key,
      aliases,
      tags,
      importance,
      category,
      confidence,
      evidence: truncate(evidence, 220),
      expiresAt,
      source: 'heuristic',
      sourceMessageId,
    });
  };

  const rememberTriggers = ['запомни', 'не забудь', 'remember'];
  const rememberTrigger = rememberTriggers.find(trig => lower.includes(trig));
  if (rememberTrigger) {
    const rememberIdx = lower.indexOf(rememberTrigger);
    const tail = cleanClause(text.slice(rememberIdx + rememberTrigger.length));
    const hasSpecific = /(?:люблю|обожаю|нравится|предпочитаю|не люблю|ненавижу|не нравится|избегаю|делаю|строю|пишу|работаю над|разрабатываю|создаю|нельзя|не могу|меня зовут|моё имя|мое имя)/i.test(text);
    if (tail && !hasSpecific) {
      pushNote({
        category: 'fact',
        textValue: tail,
        subject: userLabel,
        importance: 4,
        confidence: 0.72,
        tags: ['remember'],
        key: stableKeyFromText(tail, 'fact', userLabel),
      });
    }
  }

  const identityMatch = text.match(/(?:меня\s+зовут|моё\s+имя|мое\s+имя)\s+([^.,!?\r\n]{2,60})/i);
  if (identityMatch) {
    const name = normalizeText(identityMatch[1]);
    pushNote({
      category: 'identity',
      textValue: `Имя пользователя: ${name}`,
      subject: userLabel,
      importance: 5,
      confidence: 0.98,
      aliases: [name.toLowerCase()],
      tags: ['identity', 'name'],
      key: stableKeyFromText(`имя ${name}`, 'identity', userLabel),
    });
  }

  const firstTriggerIndex = (...triggers) => {
    let best = -1;
    for (const trig of triggers) {
      const idx = lower.indexOf(trig);
      if (idx >= 0 && (best === -1 || idx < best)) best = idx;
    }
    return best;
  };

  const extractAfter = (...triggers) => {
    const idx = firstTriggerIndex(...triggers);
    if (idx < 0) return '';
    return cleanClause(text.slice(idx + triggers.find(t => lower.indexOf(t) === idx).length));
  };

  const positive = extractAfter('люблю', 'обожаю', 'нравится', 'предпочитаю');
  if (positive) {
    pushNote({
      category: 'preference',
      textValue: `Пользователь предпочитает ${positive}`,
      subject: userLabel,
      importance: 5,
      confidence: 0.93,
      aliases: [positive.toLowerCase()],
      tags: ['preference', 'like'],
      key: stableKeyFromText(positive, 'preference', userLabel),
    });
  }

  const negative = extractAfter('не люблю', 'ненавижу', 'не нравится', 'избегаю');
  if (negative) {
    pushNote({
      category: 'constraint',
      textValue: `Пользователь не любит ${negative}`,
      subject: userLabel,
      importance: 4,
      confidence: 0.9,
      aliases: [negative.toLowerCase()],
      tags: ['constraint', 'dislike'],
      key: stableKeyFromText(negative, 'constraint', userLabel),
    });
  }

  const project = extractAfter('делаю', 'строю', 'пишу', 'работаю над', 'разрабатываю', 'создаю');
  if (project) {
    pushNote({
      category: 'project',
      textValue: `Пользователь работает над: ${project}`,
      subject: userLabel,
      importance: 4,
      confidence: 0.84,
      aliases: [project.toLowerCase()],
      tags: ['project'],
      key: stableKeyFromText(project, 'project', userLabel),
    });
  }

  const constraint = extractAfter('мне нельзя', 'нельзя', 'я не могу', 'не могу');
  if (constraint) {
    pushNote({
      category: 'constraint',
      textValue: `Ограничение пользователя: ${constraint}`,
      subject: userLabel,
      importance: 4,
      confidence: 0.86,
      aliases: [constraint.toLowerCase()],
      tags: ['constraint'],
      key: stableKeyFromText(constraint, 'constraint', userLabel),
    });
  }

  if ((lower.includes('кажется') || lower.includes('возможно') || lower.includes('наверное') || lower.includes('не уверен') || lower.includes('не знаю') || lower.includes('maybe')) && notes_add.length === 0) {
    pending_reviews_add.push({
      scope: 'user',
      text: truncate(text, 240),
      reason: 'uncertain',
      severity: 2,
      confidence: 0.35,
      suggested_note: {
        scope: 'user',
        text: truncate(text, 220),
        category: 'fact',
        importance: 2,
        confidence: 0.45,
        subject: userLabel,
      },
    });
  }

  if ((lower.includes('удали') || lower.includes('забудь') || lower.includes('очисти')) && (lower.includes('обо мне') || lower.includes('про меня') || lower.includes('мою память') || lower.includes('всё обо мне') || lower.includes('все обо мне') || lower.includes('всю память'))) {
    memory_actions.push({ action: 'forget_user', scope: 'user', match: 'all', guildId, userId, channelId });
  }

  const channelDigest = channelName ? truncate(`${userName || 'Пользователь'}: ${truncate(userText, 120)}`, 220) : '';
  return {
    notes_add,
    pending_reviews_add,
    memory_actions,
    should_store: notes_add.length > 0 || pending_reviews_add.length > 0 || memory_actions.length > 0,
    global_summary_update: '',
    assistant_profile_update: '',
    channel_summary_update: channelDigest,
    user_summary_update: truncate(userText, 220),
    global_digest_update: truncate(botReply || '', 160),
    channel_digest_update: channelDigest,
    user_digest_update: truncate(userText, 220),
  };
}

module.exports = {
  createEmptyMemory,
  createEmptyProfile,
  createEmptyUser,
  createEmptyChannel,
  normalizeMemory,
  migrateLegacyMemory,
  buildMemoryContext,
  buildMemoryExtractionPrompt,
  extractJsonPayload,
  applyMemoryUpdate,
  deriveHeuristicMemoryUpdate,
  scopeForUser,
  scopeForChannel,
  relevantNotes,
  normalizeScopeKey,
  truncate,
  tokenize,
  overlapScore,
  rebalanceMemory,
};
