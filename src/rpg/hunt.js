// Охота: генерация моба, авто-бой, лут, xp/голда, кулдаун.
const { stats: cfg, mobs: mobData, randInt } = require('./data');
const { generateMob } = require('./mobs');
const { simulateBattle } = require('./combat');
const items = require('./items');
const players = require('./players');

function isOnCooldown(profile) {
  const cd = (cfg.cooldowns?.hunt || 40) * 1000;
  return Date.now() - (profile.lastHunt || 0) < cd;
}

function cooldownLeft(profile) {
  const cd = (cfg.cooldowns?.hunt || 40) * 1000;
  return Math.max(0, Math.ceil(((profile.lastHunt || 0) + cd - Date.now()) / 1000));
}

function availableZones(profile) {
  return (mobData.zones || []).filter(z => profile.level >= (z.minLevel || 1));
}

function zoneById(zoneId) {
  return (mobData.zones || []).find(z => z.id === zoneId) || null;
}

function rollLoot(mob, profile) {
  const luck = players.totalStats(profile).luck || 0;
  const dropChance = Math.min(80, (cfg.itemDropChance || 35) * mob.lootMult + luck * 0.2);
  if (Math.random() * 100 >= dropChance) return null;
  return items.generateItem(mob.level, { luck });
}

function rollKey(mob) {
  const keyChance = Math.min(40, (cfg.keyDropChance || 10) * mob.lootMult);
  return Math.random() * 100 < keyChance;
}

// Полный цикл охоты. Возвращает данные для отображения.
function hunt(profile, zoneId) {
  const zone = zoneById(zoneId);
  if (!zone) return { ok: false, reason: 'zone' };

  const mob = generateMob(zone, profile.level);
  if (!mob) return { ok: false, reason: 'mob' };

  const playerStats = players.totalStats(profile);
  const battle = simulateBattle(playerStats, mob.stats, {
    nameA: profile.name,
    nameB: `${mob.emoji} ${mob.name}`,
  });

  profile.lastHunt = Date.now();
  const result = {
    ok: true,
    mob,
    battle,
    win: battle.winnerIsA,
    xp: 0,
    gold: 0,
    levelUps: 0,
    item: null,
    key: false,
    invFull: false,
  };

  if (result.win) {
    const gs = playerStats.goldFind || 0;
    const xs = playerStats.xpBonus || 0;
    result.gold = Math.max(1, Math.round(mob.gold * (1 + gs / 100)));
    result.xp = Math.max(1, Math.round(mob.xp * (1 + xs / 100)));
    profile.gold += result.gold;
    result.levelUps = players.addXp(profile, result.xp);
    result.item = rollLoot(mob, profile);
    if (result.item) {
      const added = players.addItem(profile, result.item);
      result.invFull = added.sold;
      if (added.sold) result.item = null;
    }
    result.key = rollKey(mob);
    if (result.key) profile.keys += 1;
  } else {
    result.xp = Math.max(1, Math.round(mob.xp * 0.2));
    result.levelUps = players.addXp(profile, result.xp);
  }

  return result;
}

module.exports = { isOnCooldown, cooldownLeft, availableZones, zoneById, hunt, rollLoot };
