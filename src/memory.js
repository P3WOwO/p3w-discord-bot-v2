const { MAX_HISTORY } = require('./constants');
const { clampText, normalizeText } = require('./utils');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createEmptyChannelMemory(title = '') {
  return {
    title: normalizeText(title),
    summary: '',
    digest: '',
    turns: [],
    turnsSinceCompact: 0,
    lastUpdatedAt: null,
    lastCompactedAt: null,
  };
}


const INTERNAL_MEMORY_PATTERNS = [
  /(?:я\s+)?(?:запомнил|записал|сохранил|зафиксировал|добавил(?:\s+в)?\s+память)/i,
  /(?:долгий|краткий)\s+контекст/i,
  /(?:читал|прочитал|прочёл)\s+(?:из\s+)?(?:базы|базы данных|архива)/i,
  /voice_times/i,
  /анналы\s+истории/i,
];

function isInternalAssistantText(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  return INTERNAL_MEMORY_PATTERNS.some(pattern => pattern.test(value));
}

function sanitizeAssistantMemoryText(text) {
  const value = String(text || '').trim();
  if (!value) return value;

  const sentences = value
    .split(/(?<=[.!?…])\s+|\n+/)
    .map(part => part.trim())
    .filter(Boolean);

  const kept = sentences.filter(sentence => !isInternalAssistantText(sentence));

  if (!kept.length) {
    return value
      .replace(/(?:я\s+)?(?:запомнил|записал|сохранил|зафиксировал|добавил(?:\s+в)?\s+память)[^.?!…\n]*/ig, '')
      .replace(/(?:долгий|краткий)\s+контекст[^.?!…\n]*/ig, '')
      .replace(/voice_times[^.?!…\n]*/ig, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  return kept.join(' ').replace(/\s{2,}/g, ' ').trim();
}

function isInternalAssistantTurn(turn) {
  return String(turn?.role || '') === 'assistant' && isInternalAssistantText(turn?.text);
}

function createEmptyMemory() {
  return {
    schemaVersion: 1,
    globalSummary: '',
    globalDigest: '',
    channels: {},
  };
}

function normalizeChannelMemory(raw, title = '') {
  const base = createEmptyChannelMemory(title);
  if (!raw || typeof raw !== 'object') return base;
  base.title = normalizeText(raw.title || title || '');
  base.summary = clampText(raw.summary || '', 1200);
  base.digest = clampText(raw.digest || '', 300);
  base.turns = Array.isArray(raw.turns)
    ? raw.turns
        .map(turn => ({
          role: String(turn?.role || 'user').slice(0, 20),
          name: clampText(turn?.name || '', 80),
          text: clampText(turn?.text || '', 300),
          ts: turn?.ts || new Date().toISOString(),
        }))
        .filter(turn => !isInternalAssistantTurn(turn))
        .slice(-MAX_HISTORY)
    : [];
  base.turnsSinceCompact = Math.max(0, Number(raw.turnsSinceCompact || 0) || 0);
  base.lastUpdatedAt = raw.lastUpdatedAt || null;
  base.lastCompactedAt = raw.lastCompactedAt || null;
  return base;
}

function normalizeMemory(raw) {
  const memory = createEmptyMemory();
  if (!raw || typeof raw !== 'object') return memory;
  memory.schemaVersion = Number(raw.schemaVersion || 1) || 1;
  memory.globalSummary = clampText(raw.globalSummary || '', 1200);
  memory.globalDigest = clampText(raw.globalDigest || '', 300);
  const channels = raw.channels && typeof raw.channels === 'object' ? raw.channels : {};
  memory.channels = Object.fromEntries(
    Object.entries(channels).map(([channelId, channelMemory]) => [
      channelId,
      normalizeChannelMemory(channelMemory),
    ])
  );
  return memory;
}

function appendChannelTurn(memoryInput, channelId, { role, name, text }) {
  const memory = normalizeMemory(memoryInput);
  const channel = memory.channels[channelId] || createEmptyChannelMemory();
  channel.turns = Array.isArray(channel.turns) ? channel.turns : [];
  const safeText = String(role || 'user').slice(0, 20) === 'assistant'
    ? sanitizeAssistantMemoryText(text)
    : text;
  channel.turns.push({
    role: String(role || 'user').slice(0, 20),
    name: clampText(name || '', 80),
    text: clampText(safeText || '', 300),
    ts: new Date().toISOString(),
  });
  channel.turns = channel.turns.slice(-MAX_HISTORY);
  channel.turnsSinceCompact = (Number(channel.turnsSinceCompact || 0) || 0) + 1;
  channel.lastUpdatedAt = new Date().toISOString();
  memory.channels[channelId] = channel;
  return memory;
}

function getChannelMemory(memoryInput, channelId) {
  const memory = normalizeMemory(memoryInput);
  return memory.channels[channelId] || createEmptyChannelMemory();
}

function setChannelMemory(memoryInput, channelId, nextMemory) {
  const memory = normalizeMemory(memoryInput);
  memory.channels[channelId] = normalizeChannelMemory(nextMemory);
  return memory;
}

function buildRecentTurnsText(turns = []) {
  return (turns || [])
    .filter(Boolean)
    .filter(turn => !isInternalAssistantTurn(turn))
    .map(turn => {
      const who = turn.role === 'assistant' ? 'Бот' : (turn.name || 'Пользователь');
      return `${who}: ${clampText(turn.text || '', 220)}`;
    })
    .join('\n');
}

function buildMemoryContext(memoryInput, { channelId, channelName = '', queryText = '', recentMessages = [] }) {
  const memory = normalizeMemory(memoryInput);
  const channel = memory.channels[channelId] || null;
  const sections = [];

  if (channel?.title) sections.push(`Канал: ${channel.title}`);
  else if (channelName) sections.push(`Канал: ${channelName}`);

  if (channel?.summary) sections.push(`Долгий контекст: ${channel.summary}`);
  if (channel?.digest) sections.push(`Краткий фон: ${channel.digest}`);

  if (Array.isArray(recentMessages) && recentMessages.length) {
    sections.push('Последние сообщения:');
    sections.push(buildRecentTurnsText(recentMessages));
  }

  if (queryText) {
    sections.push(`Текущий запрос: ${clampText(queryText, 300)}`);
  }

  return sections.filter(Boolean).join('\n');
}

function extractJsonPayload(text) {
  const raw = normalizeText(text);
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ? fenced[1].trim() : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function compactMemoryFallback(channelMemory) {
  const turns = Array.isArray(channelMemory.turns) ? channelMemory.turns : [];
  const lastTurns = turns
    .filter(turn => !isInternalAssistantTurn(turn))
    .slice(-6)
    .map(turn => `${turn.role === 'assistant' ? 'Бот' : 'Чат'}: ${turn.text}`);
  const summary = clampText(
    [channelMemory.summary, ...lastTurns].filter(Boolean).join(' | '),
    1100
  );
  const digest = clampText(
    turns.slice(-2).map(turn => turn.text).join(' / '),
    260
  );
  return { summary, digest };
}

module.exports = {
  createEmptyMemory,
  normalizeMemory,
  normalizeChannelMemory,
  appendChannelTurn,
  getChannelMemory,
  setChannelMemory,
  buildMemoryContext,
  buildRecentTurnsText,
  extractJsonPayload,
  compactMemoryFallback,
  sanitizeAssistantMemoryText,
  isInternalAssistantText,
};
