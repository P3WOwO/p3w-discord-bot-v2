function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function truncate(value, max = 220) {
  const text = normalizeText(value);
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const STOPWORDS = new Set([
  'и','в','во','не','что','он','на','я','с','со','как','а','то','все','она','так','его','но','да','ты','к','у','же','вы','за','бы','по','только','ее','мне','было','вот','от','меня','еще','нет','о','из','ему','теперь','когда','даже','ну','вдруг','ли','если','уже','или','ни','быть','был','до','вас','опять','там','потом','себя','ничего','ей','может','они','тут','где','есть','надо','для','мы','тебя','их','чем','была','сам','чтоб','без','будто','чего','раз','тоже','себе','под','будет','тогда','кто','этот','того','потому','этого','какой','совсем','здесь','этом','один','мой','тем','чтобы','сейчас','были','куда','зачем','всех','никогда','можно','при','два','об','другой','после','больше','тот','через','эти','нас','про','всего','них','какая','много','три','эту','моя','лучше','том','нельзя','такой','им','более','всегда','конечно','всю','между','это','сюда','туда','зато'
]);

function tokenize(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

function overlapScore(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (!setA.size || !setB.size) return 0;
  let overlap = 0;
  for (const token of setA) if (setB.has(token)) overlap += 1;
  return overlap / Math.max(setA.size, setB.size);
}

function queryWantsKnowledge(queryText) {
  const q = normalizeText(queryText).toLowerCase();
  if (!q) return false;
  return [
    'из базы', 'по базе', 'в базе', 'проверь в базе', 'посмотри в базе', 'найди в базе',
    'справка', 'справочник', 'документац', 'lookup', 'search', 'что у нас есть', 'что записано',
    'что ты знаешь о', 'напомни', 'покажи запись', 'внешняя память', 'knowledge'
  ].some(token => q.includes(token));
}

function sanitizeKnowledgeEntry(item) {
  if (!item || typeof item !== 'object') return null;
  const title = truncate(item.title || item.name || item.key || '', 120);
  const content = truncate(item.content || item.text || item.summary || '', 600);
  if (!title && !content) return null;
  const tags = Array.isArray(item.tags)
    ? [...new Set(item.tags.map(v => normalizeText(v).toLowerCase()).filter(Boolean))].slice(0, 12)
    : [];
  const aliases = Array.isArray(item.aliases)
    ? [...new Set(item.aliases.map(v => normalizeText(v).toLowerCase()).filter(Boolean))].slice(0, 12)
    : [];
  return {
    id: normalizeText(item.id || `${title}:${content}`).toLowerCase().slice(0, 120),
    title,
    content,
    scope: normalizeText(item.scope || 'global').toLowerCase().slice(0, 20) || 'global',
    source: normalizeText(item.source || 'supabase').slice(0, 80),
    tags,
    aliases,
    updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
    confidence: Math.max(0, Math.min(1, Number(item.confidence ?? 0.7) || 0.7)),
  };
}

function pickRelevantKnowledgeEntries(entries, queryText, limit = 6) {
  return (Array.isArray(entries) ? entries : [])
    .map(entry => ({
      entry: sanitizeKnowledgeEntry(entry),
      score: overlapScore(`${entry?.title || ''} ${entry?.content || ''} ${(entry?.tags || []).join(' ')} ${(entry?.aliases || []).join(' ')}`, queryText) * 10
        + Math.max(0, Math.min(1, Number(entry?.confidence ?? 0.7) || 0.7)) * 2,
    }))
    .filter(item => item.entry)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => item.entry);
}

function buildKnowledgeSearchTerms(queryText) {
  return tokenize(queryText).slice(0, 6);
}

module.exports = {
  normalizeText,
  truncate,
  tokenize,
  overlapScore,
  queryWantsKnowledge,
  sanitizeKnowledgeEntry,
  pickRelevantKnowledgeEntries,
  buildKnowledgeSearchTerms,
};
