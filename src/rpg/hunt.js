// Охота: 1-3 врага по зоне, энергия вместо кулдауна, HP переносится между врагами.
const { stats: cfg, mobs: mobData, event: eventCfg, randInt } = require('./data');
const { generateMob } = require('./mobs');
const { simulateBattle } = require('./combat');
const items = require('./items');
const players = require('./players');
const pets = require('./pets');

function eventActive() {
  return Boolean(eventCfg && eventCfg.active && eventCfg.endsAt && Date.now() < new Date(eventCfg.endsAt).getTime());
}

function pickEncounterCount(zone) {
  const weights = zone.encounters || [100];
  const total = weights.reduce((s, w) => s + w, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return i + 1;
  }
  return 1;
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

function rollCrystals(kills) {
  if (!eventActive() || kills <= 0) return 0;
  if (Math.random() * 100 >= (eventCfg.dropFromKillChance || 20)) return 0;
  const min = (eventCfg.dropFromKillAmount || [1, 3])[0];
  const max = (eventCfg.dropFromKillAmount || [1, 3])[1];
  return randInt(min, max) + Math.max(0, kills - 1);
}

function hunt(profile, zoneId) {
  const zone = zoneById(zoneId);
  if (!zone) return { ok: false, reason: 'zone' };

  const energyCost = (cfg.energy && cfg.energy.huntCost) || 10;
  if (!players.spendEnergy(profile, energyCost)) {
    return { ok: false, reason: 'no_energy', need: energyCost, energy: players.getEnergy(profile) };
  }

  const playerStats = players.totalStats(profile);
  const count = pickEncounterCount(zone);
  const result = {
    ok: true,
    zone,
    enemies: [],
    kills: 0,
    total: count,
    win: true,
    hpLeft: playerStats.hp,
    maxHp: playerStats.hp,
    xp: 0,
    gold: 0,
    crystals: 0,
    levelUps: 0,
    item: null,
    key: false,
    pet: null,
    invFull: false,
  };

  for (let i = 0; i < count; i++) {
    const mob = generateMob(zone, profile.level);
    if (!mob) continue;
    mob.name = `Враг ${i + 1}: ${mob.name}`;
    const battle = simulateBattle(playerStats, mob.stats, {
      nameA: profile.name,
      nameB: `${mob.emoji} ${mob.name}`,
      playerStartHp: result.hpLeft,
    });
    result.hpLeft = battle.aHp;
    result.enemies.push({ mob, battle, defeated: battle.winnerIsA });

    if (!battle.winnerIsA) {
      result.win = false;
      break;
    }
    result.kills += 1;
    result.xp += mob.xp;
    result.gold += mob.gold;
  }

  if (result.kills > 0) {
    const gs = playerStats.goldFind || 0;
    const xs = playerStats.xpBonus || 0;
    result.gold = Math.round(result.gold * (1 + gs / 100));
    result.xp = Math.round(result.xp * (1 + xs / 100));
    profile.gold += result.gold;
    result.levelUps = players.addXp(profile, result.xp);

    const lastKilled = result.enemies.slice().reverse().find(e => e.defeated);
    if (lastKilled) {
      result.item = rollLoot(lastKilled.mob, profile);
      if (result.item) {
        const added = players.addItem(profile, result.item);
        result.invFull = added.sold;
        if (added.sold) result.item = null;
      }
      result.key = rollKey(lastKilled.mob);
      if (result.key) profile.keys += 1;
      result.pet = pets.tryCapture(lastKilled.mob, profile, playerStats.luck || 0);
    }

    result.crystals = rollCrystals(result.kills);
    if (result.crystals > 0) profile.eventCurrency = (profile.eventCurrency || 0) + result.crystals;
  } else {
    result.xp = 5;
    result.levelUps = players.addXp(profile, 5);
  }

  return result;
}

function availableZones(profile) {
  return (mobData.zones || []).filter(z => profile.level >= (z.minLevel || 1));
}

module.exports = { hunt, zoneById, availableZones, rollLoot, pickEncounterCount, eventActive };