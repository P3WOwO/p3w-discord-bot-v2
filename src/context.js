const { CONTEXT_MAX_TURNS, CONTEXT_ARCHIVE_LIMIT } = require('./constants');
const { clampText, normalizeText } = require('./utils');

// Простой контекст канала: последние N сообщений + выжимка старых.
// Никакой "умной памяти" — только окно и одна короткая авто-выжимка.

function normalizeTurn(turn) {
  return {
    role: String(turn?.role || 'user').slice(0, 20),
    name: clampText(turn?.name || '', 80),
    text: clampText(turn?.text || '', 500),
    ts: turn?.ts || null,
  };
}

function createChannelContext(title = '') {
  return {
    title: normalizeText(title),
    summary: '',
    turns: [],
    archive: [],
    turnsSinceSummary: 0,
    lastUpdatedAt: null,
  };
}

function normalizeChannelContext(raw, title = '') {
  const base = createChannelContext(title);
  if (!raw || typeof raw !== 'object') return base;

  base.title = normalizeText(raw.title || title || '');
  base.summary = clampText(raw.summary || '', 800);
  base.turns = Array.isArray(raw.turns) ? raw.turns.map(normalizeTurn).slice(-CONTEXT_MAX_TURNS) : [];
  base.archive = Array.isArray(raw.archive)
    ? raw.archive.map(normalizeTurn).slice(-CONTEXT_ARCHIVE_LIMIT)
    : [];
  base.turnsSinceSummary = Math.max(0, Number(raw.turnsSinceSummary || 0) || 0);
  base.lastUpdatedAt = raw.lastUpdatedAt || null;
  return base;
}

function addTurnToContext(ctx, { role = 'user', name = '', text = '' }) {
  ctx.turns.push(normalizeTurn({ role, name, text, ts: new Date().toISOString() }));

  // Вытесняем старые сообщения в архив, когда окно переполнено.
  while (ctx.turns.length > CONTEXT_MAX_TURNS) {
    ctx.archive.push(ctx.turns.shift());
    ctx.turnsSinceSummary += 1;
  }

  if (ctx.archive.length > CONTEXT_ARCHIVE_LIMIT) {
    ctx.archive.splice(0, ctx.archive.length - CONTEXT_ARCHIVE_LIMIT);
  }

  ctx.lastUpdatedAt = new Date().toISOString();
  return ctx;
}

function buildTurnLine(turn) {
  const who = turn.role === 'assistant' ? 'Бот' : (turn.name || 'Пользователь');
  return `${who}: ${turn.text}`;
}

function buildChatContext(ctx) {
  const parts = [];
  if (ctx?.summary) parts.push(`Суть прошлых разговоров (кратко): ${ctx.summary}`);
  if (Array.isArray(ctx?.turns) && ctx.turns.length) {
    parts.push('Последние сообщения чата:');
    parts.push(ctx.turns.map(buildTurnLine).join('\n'));
  }
  return parts.join('\n\n');
}

// Источник для авто-выжимки: старые вытесненные сообщения.
function buildSummarySource(ctx) {
  return (Array.isArray(ctx?.archive) ? ctx.archive : [])
    .map(buildTurnLine)
    .join('\n');
}

module.exports = {
  createChannelContext,
  normalizeChannelContext,
  addTurnToContext,
  buildChatContext,
  buildSummarySource,
};
