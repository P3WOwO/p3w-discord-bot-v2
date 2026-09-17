// Процедурная генерация предметов: база + редкость + аффиксы + скейл от уровня.
const { rarities, itemBases, affixes, weightedPick, randInt, pick } = require('./data');

// Плоские статы (целые) — остальное проценты.
const FLAT_KEYS = new Set(['hp', 'atk', 'def', 'spd']);
const PERCENT_KEYS = new Set([
  'critChance', 'critDmg', 'dodge', 'lifesteal', 'block', 'counterChance',
  'stunChance', 'reflect', 'pierce', 'goldFind', 'xpBonus', 'luck', 'regen',
]);

const SCORE_WEIGHTS = {
  hp: 0.5, atk: 4, def: 3, spd: 2, regen: 6,
  critChance: 8, critDmg: 3, dodge: 8, lifesteal: 6, block: 6,
  counterChance: 5, stunChance: 10, reflect: 4, pierce: 5,
  goldFind: 1, xpBonus: 1, luck: 2,
};

function levelMult(level) {
  return 1 + (Math.max(1, level) - 1) * 0.12;
}

// Сдвигает веса к редким при высокой удаче.
function rollRarity(luck = 0) {
  const order = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
  const entries = order
    .filter(id => rarities[id])
    .map((id, idx) => ({ id, weight: (rarities[id].weight || 0) * (1 + (luck / 100) * idx) }));
  const picked = weightedPick(entries, e => e.weight);
  return picked ? picked.id : 'common';
}

function rollRarityFromWeights(weights) {
  const entries = Object.entries(weights || {}).map(([id, weight]) => ({ id, weight }));
  const picked = weightedPick(entries, e => e.weight);
  return picked ? picked.id : 'common';
}

// Огненный -> Огненная / Огненное / Огненные
function declineAdjective(adj, gender) {
  const a = String(adj || '');
  if (gender === 'f') return a.replace(/ый$/, 'ая').replace(/ий$/, 'яя').replace(/ой$/, 'ая');
  if (gender === 'n') return a.replace(/ый$/, 'ое').replace(/ий$/, 'ее').replace(/ой$/, 'ое');
  if (gender === 'pl') return a.replace(/ый$/, 'ые').replace(/ий$/, 'ие').replace(/ой$/, 'ые');
  return a;
}

function newUid() {
  return `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function rollAffixBonus(bonusRange, rarityDef, level) {
  const result = {};
  for (const [stat, range] of Object.entries(bonusRange || {})) {
    const raw = randInt(range[0], range[1]);
    if (!raw) continue;
    const scaled = Math.round(raw * rarityDef.mult * (1 + (level - 1) * 0.05) * 10) / 10;
    result[stat] = scaled;
  }
  return result;
}

// level: уровень предмета (= уровень моба/данжа). opts: { rarityId, luck, slot }
function generateItem(level, opts = {}) {
  const lvl = Math.max(1, level);
  const rarityId = opts.rarityId || rollRarity(opts.luck || 0);
  const rarityDef = rarities[rarityId] || rarities.common || { mult: 1, affixes: [0, 0] };

  const slot = opts.slot || pick(itemBases.slots || []);
  const basePool = (itemBases.bases || {})[slot] || [];
  if (!basePool.length) return null;
  const base = pick(basePool);

  const mult = rarityDef.mult * levelMult(lvl);
  const stats = {};
  for (const [stat, range] of Object.entries(base.stats || {})) {
    const value = Math.round(randInt(range[0], range[1]) * mult * 10) / 10;
    if (value === 0) continue;
    stats[stat] = value;
  }

  const [minAff, maxAff] = rarityDef.affixes || [0, 0];
  const affixCount = randInt(minAff, maxAff);
  const prefixIds = new Set((affixes.prefixes || []).map(a => a.id));
  const chosen = [];
  const usedIds = new Set();

  for (let i = 0; i < affixCount; i++) {
    const pool = i === 0 ? (affixes.prefixes || []) : (affixes.suffixes || []);
    const candidates = pool.filter(a => !usedIds.has(a.id));
    if (!candidates.length) break;
    const aff = pick(candidates);
    usedIds.add(aff.id);
    chosen.push({
      id: aff.id,
      name: aff.name,
      bonus: rollAffixBonus(aff.bonus, rarityDef, lvl),
    });
  }

  // Имя: [Прилагательное] [База] [Суффикс]
  let name = base.name;
  if (chosen.length) {
    const prefixAff = chosen.find(a => prefixIds.has(a.id));
    const suffixAffs = chosen.filter(a => !prefixIds.has(a.id));
    const gender = (itemBases.genders || {})[base.id] || 'm';
    const parts = [];
    if (prefixAff) parts.push(declineAdjective(prefixAff.name, gender));
    parts.push(base.name);
    if (suffixAffs.length) parts.push(suffixAffs.map(a => a.name).join(' '));
    name = parts.join(' ');
  }

  const item = {
    uid: newUid(),
    slot,
    baseId: base.id,
    name,
    rarity: rarityId,
    level: lvl,
    stats,
    affixes: chosen,
    upg: 0,
  };
  item.score = itemScore(item);
  return item;
}

// Итоговые статы предмета с учётом заточки.
function effectiveItemStats(item) {
  const mult = 1 + (item.upg || 0) * 0.08;
  const out = {};
  for (const [stat, value] of Object.entries(item.stats || {})) {
    out[stat] = Math.round(value * mult * 10) / 10;
  }
  for (const aff of item.affixes || []) {
    for (const [stat, value] of Object.entries(aff.bonus || {})) {
      out[stat] = Math.round(((out[stat] || 0) + value * mult) * 10) / 10;
    }
  }
  return out;
}

function itemScore(item) {
  const all = {};
  for (const [stat, value] of Object.entries(item.stats || {})) all[stat] = (all[stat] || 0) + value;
  for (const aff of item.affixes || []) {
    for (const [stat, value] of Object.entries(aff.bonus || {})) all[stat] = (all[stat] || 0) + value;
  }
  let score = 0;
  for (const [stat, value] of Object.entries(all)) {
    score += (SCORE_WEIGHTS[stat] || 1) * value;
  }
  return Math.max(1, Math.round(score * (1 + (item.upg || 0) * 0.1)));
}

function sellPrice(item, perScore) {
  return Math.max(5, Math.round(itemScore(item) * (perScore || 2)));
}

function upgradeCost(item, cfg) {
  return Math.max(10, Math.round((cfg.baseCost || 60) * Math.pow(cfg.costGrowth || 1.5, item.upg || 0)));
}

function upgradeSuccessChance(item, cfg) {
  return Math.max(cfg.successFloor || 0.35, (cfg.successBase || 0.92) - (cfg.successDecay || 0.04) * (item.upg || 0));
}

module.exports = {
  FLAT_KEYS,
  PERCENT_KEYS,
  SCORE_WEIGHTS,
  rollRarity,
  rollRarityFromWeights,
  declineAdjective,
  generateItem,
  effectiveItemStats,
  itemScore,
  sellPrice,
  upgradeCost,
  upgradeSuccessChance,
};


