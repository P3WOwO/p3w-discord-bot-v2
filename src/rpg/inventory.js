// Инвентарь: надеть/снять/продать, заточка.
const { stats: cfg, itemBases, rarities } = require('./data');
const items = require('./items');
const players = require('./players');

function equip(profile, uid) {
  const item = players.findItem(profile, uid);
  if (!item) return { ok: false, reason: 'not_found' };

  const old = profile.equipment?.[item.slot] || null;
  profile.inventory = (profile.inventory || []).filter(i => i.uid !== uid);
  profile.equipment[item.slot] = item;
  if (old) profile.inventory.push(old);
  return { ok: true, item, replaced: old };
}

function unequip(profile, uid) {
  const found = players.equippedItem(profile, uid);
  if (!found) return { ok: false, reason: 'not_found' };
  if ((profile.inventory || []).length >= (cfg.inventoryCap || 60)) {
    return { ok: false, reason: 'inv_full' };
  }
  profile.equipment[found.slot] = null;
  profile.inventory.push(found.item);
  return { ok: true, item: found.item };
}

function sell(profile, uid) {
  const item = players.findItem(profile, uid);
  if (!item) return { ok: false, reason: 'not_found' };
  const price = items.sellPrice(item, cfg.sellPricePerScore);
  profile.inventory = (profile.inventory || []).filter(i => i.uid !== uid);
  profile.gold += price;
  return { ok: true, price, item };
}

// Продать всё обычное и необычное (удобная очистка инвентаря).
function sellJunk(profile) {
  let total = 0;
  let count = 0;
  profile.inventory = (profile.inventory || []).filter(item => {
    if (item.rarity === 'common' || item.rarity === 'uncommon') {
      total += items.sellPrice(item, cfg.sellPricePerScore);
      count += 1;
      return false;
    }
    return true;
  });
  profile.gold += total;
  return { count, total };
}

function upgrade(profile, uid) {
  const item = players.findItem(profile, uid)
    || players.equippedItem(profile, uid)?.item
    || null;
  if (!item) return { ok: false, reason: 'not_found' };

  const maxLevel = cfg.upgrade?.maxLevel || 15;
  if ((item.upg || 0) >= maxLevel) return { ok: false, reason: 'max' };

  const cost = items.upgradeCost(item, cfg.upgrade || {});
  if (profile.gold < cost) return { ok: false, reason: 'no_gold', cost };

  profile.gold -= cost;
  const chance = items.upgradeSuccessChance(item, cfg.upgrade || {});
  const success = Math.random() < chance;
  if (success) {
    item.upg = (item.upg || 0) + 1;
    item.score = items.itemScore(item);
  }
  return { ok: true, success, cost, chance: Math.round(chance * 100), item };
}

// Рядок для списка инвентаря.
function itemLine(item, idx) {
  const rarity = rarities[item.rarity] || {};
  const upg = item.upg ? ` +${item.upg}` : '';
  return `${rarity.emoji || '▫️'} **[${idx}]** ${item.name}${upg} (ур.${item.level}) — ${item.score}(score)`;
}

module.exports = { equip, unequip, sell, sellJunk, upgrade, itemLine };
