// Сундуки (гача): открытие за монеты или ключи, генерация предмета по весам редкости.
const { chests: chestCfg, rarities } = require('./data');
const { rollRarityFromWeights } = require('./items');
const items = require('./items');

function chestById(id) {
  return (chestCfg.chests || []).find(c => c.id === id) || null;
}

function canOpen(profile, chest) {
  if (!chest) return { ok: false, reason: 'chest' };
  if (chest.currency === 'gold') {
    if (profile.gold < chest.cost) return { ok: false, reason: 'no_gold', cost: chest.cost };
  } else if (chest.currency === 'keys') {
    if ((profile.keys || 0) < chest.cost) return { ok: false, reason: 'no_keys', cost: chest.cost };
  } else {
    return { ok: false, reason: 'currency' };
  }
  return { ok: true };
}

function open(profile, chestId) {
  const chest = chestById(chestId);
  const check = canOpen(profile, chest);
  if (!check.ok) return check;

  if (chest.currency === 'gold') profile.gold -= chest.cost;
  else profile.keys -= chest.cost;

  // Уровень предмета — случайный в диапазоне сундука.
  const level = chest.levelRange
    ? chest.levelRange[0] + Math.floor(Math.random() * (chest.levelRange[1] - chest.levelRange[0] + 1))
    : Math.max(1, Math.min(profile.level, 10));

  const rarityId = rollRarityFromWeights(chest.rarityWeights);
  const item = items.generateItem(level, { rarityId, luck: 0 });
  if (!item) return { ok: false, reason: 'gen' };

  const players = require('./players');
  const added = players.addItem(profile, item);
  return { ok: true, item, chest, invFull: Boolean(added.sold) };
}

module.exports = { chestById, canOpen, open };
