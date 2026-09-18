// Загрузка JSON-конфигов RPG. Весь контент правится в файлах, код не трогаем.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

function loadJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch (err) {
    console.error(`⚠️ RPG data load failed: ${name}: ${err.message}`);
    return fallback;
  }
}

const rarities = loadJson('rarities.json', {});
const stats = loadJson('stats.json', {});
const itemBases = loadJson('items.json', { slots: [], bases: {}, genders: {}, slotNames: {} });
const affixes = loadJson('affixes.json', { prefixes: [], suffixes: [] });
const mobs = loadJson('mobs.json', { archetypes: [], zones: [], modifiers: [] });
const chests = loadJson('chests.json', { chests: [] });
const dungeons = loadJson('dungeons.json', { dungeons: [], cooldownMinutes: 3 });
const pets = loadJson('pets.json', {});
const casino = loadJson('casino.json', { minBet: 10, maxBet: 10000 });
const event = loadJson('event.json', {});

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Взвешенный выбор из массива с полем weight.
function weightedPick(entries, weightFn) {
  const getWeight = weightFn || (e => e.weight);
  const pool = entries.filter(e => getWeight(e) > 0);
  const total = pool.reduce((sum, e) => sum + getWeight(e), 0);
  if (!pool.length || total <= 0) return null;
  let roll = Math.random() * total;
  for (const entry of pool) {
    roll -= getWeight(entry);
    if (roll <= 0) return entry;
  }
  return pool[pool.length - 1];
}

module.exports = {
  rarities,
  stats,
  itemBases,
  affixes,
  mobs,
  chests,
  dungeons,
  pets,
  casino,
  event,
  randInt,
  pick,
  clamp,
  weightedPick,
};
