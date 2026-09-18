// Данжи: волны мобов + босс, вход за монеты/ключи, жирный лут.
const { stats: cfg, dungeons: dungeonCfg, event: eventCfg, randInt, pick } = require('./data');
const { generateMob, generateWaveMob, generateBoss } = require('./mobs');
const { simulateBattle } = require('./combat');
const items = require('./items');
const players = require('./players');
const pets = require('./pets');

function dungeonById(id) {
  return (dungeonCfg.dungeons || []).find(d => d.id === id) || null;
}

function isOnCooldown(profile) {
  return false;
}

function cooldownLeft(profile) {
  return 0;
}

function canEnter(profile, dungeon) {
  if (profile.level < (dungeon.minLevel || 1)) return { ok: false, reason: 'level', need: dungeon.minLevel };
  if (dungeon.currency === 'gold' && profile.gold < (dungeon.entryCost || 0)) return { ok: false, reason: 'no_gold', cost: dungeon.entryCost };
  if (dungeon.currency === 'keys' && (profile.keys || 0) < (dungeon.entryCost || 0)) return { ok: false, reason: 'no_keys', cost: dungeon.entryCost };
  return { ok: true };
}

// Полный забег: волны → босс. Всё мгновенно, результат — сводка.
function run(profile, dungeonId) {
  const dungeon = dungeonById(dungeonId);
  if (!dungeon) return { ok: false, reason: 'dungeon' };

  const check = canEnter(profile, dungeon);
  if (!check.ok) return check;

  if (dungeon.currency === 'gold') profile.gold -= dungeon.entryCost;
  else profile.keys -= dungeon.entryCost;

  const dEnergy = (cfg.energy && cfg.energy.dungeonCost) || 20;
  if (!players.spendEnergy(profile, dEnergy)) {
    return { ok: false, reason: 'no_energy', energy: players.getEnergy(profile) };
  }

  profile.lastDungeon = Date.now();

  const log = [];
  const result = {
    ok: true,
    dungeon,
    win: false,
    waveReached: 0,
    xp: 0,
    gold: 0,
    items: [],
    keys: 0,
    pet: null,
    levelUps: 0,
  };

  const playerStats = players.totalStats(profile);

  // Волны обычных мобов
  for (let wave = 1; wave <= (dungeon.waves || 3); wave++) {
    const archetypeId = pick(dungeon.mobs || []);
    const level = randInt(dungeon.levelRange?.[0] || 1, dungeon.levelRange?.[1] || 10);
    const mob = generateWaveMob(archetypeId, level, dungeon.rewardMult || 1);
    if (!mob) return { ok: false, reason: 'gen' };
    mob.name = `Волна ${wave}: ${mob.name}`;

    const battle = simulateBattle(playerStats, mob.stats, { nameA: profile.name, nameB: `${mob.emoji} ${mob.name}` });
    log.push(`Волна ${wave}/${dungeon.waves}: ${battle.winnerIsA ? '✅ пройдена' : '💀 поражение'} (HP ${battle.aHp}/${battle.aMaxHp})`);
    result.waveReached = wave;

    if (!battle.winnerIsA) {
      result.win = false;
      result.xp = Math.max(1, Math.round((dungeon.xp?.[0] || 30) * 0.3 * wave / dungeon.waves));
      result.levelUps = players.addXp(profile, result.xp);
      result.log = log;
      return result;
    }
  }

  // Босс
  const bossLevel = dungeon.levelRange?.[1] || 10;
  const boss = generateBoss(dungeon.boss, bossLevel, 2.0);
  const bossBattle = simulateBattle(playerStats, boss.stats, { nameA: profile.name, nameB: `${boss.emoji} ${boss.name}` });
  log.push(`👑 Босс «${boss.shortName}»: ${bossBattle.winnerIsA ? '✅ повержен!' : '💀 не осилен'}`);
  result.waveReached = dungeon.waves + 1;

  if (!bossBattle.winnerIsA) {
    result.win = false;
    result.boss = boss;
    result.xp = Math.max(1, Math.round((dungeon.xp?.[0] || 30) * 0.6));
    result.levelUps = players.addXp(profile, result.xp);
    result.log = log;
    return result;
  }

  // Победа: награды
  result.win = true;
  result.boss = boss;
  result.xp = randInt(dungeon.xp?.[0] || 50, dungeon.xp?.[1] || 100);
  result.gold = randInt(dungeon.gold?.[0] || 50, dungeon.gold?.[1] || 100);
  profile.gold += result.gold;
  result.levelUps = players.addXp(profile, result.xp);

  const [minItems, maxItems] = dungeon.itemCount || [1, 1];
  const count = randInt(minItems, maxItems);
  for (let i = 0; i < count; i++) {
    const rarityId = items.rollRarityFromWeights(dungeon.rarityWeights);
    const item = items.generateItem(randInt(dungeon.levelRange?.[0] || 1, dungeon.levelRange?.[1] || 10), { rarityId, luck: playerStats.luck || 0 });
    if (item) {
      const added = players.addItem(profile, item);
      if (added.sold) result.gold += items.sellPrice(item, cfg.sellPricePerScore);
      else result.items.push(item);
    }
  }

  if (Math.random() * 100 < (dungeon.keyChance || 20)) {
    profile.keys += 1;
    result.keys = 1;
  }

  const eventActiveNow = Boolean(eventCfg && eventCfg.active && eventCfg.endsAt && Date.now() < new Date(eventCfg.endsAt).getTime());
  if (eventActiveNow) {
    const dbMin = (eventCfg.dungeonBonus || [5, 10])[0];
    const dbMax = (eventCfg.dungeonBonus || [5, 10])[1];
    result.crystals = randInt(dbMin, dbMax);
    profile.eventCurrency = (profile.eventCurrency || 0) + result.crystals;
  }

  const pet = pets.tryCapture(
    { archetypeId: boss.archetypeId, shortName: boss.shortName, emoji: '🐾', level: boss.level, modifierId: null },
    profile,
    playerStats.luck || 0
  );
  result.pet = pet;

  result.log = log;
  return result;
}


// Пати-данж: боец = сумма HP, общая атака, лут каждому.
function runParty(members, dungeonId) {
  const dungeon = dungeonById(dungeonId);
  if (!dungeon) return { ok: false, reason: 'dungeon' };
  for (const m of members) {
    if ((m.level || 1) < (dungeon.minLevel || 1)) return { ok: false, reason: 'level', member: m, need: dungeon.minLevel };
    if (dungeon.currency === 'gold' && m.gold < (dungeon.entryCost || 0)) return { ok: false, reason: 'no_gold', member: m, cost: dungeon.entryCost };
    if (dungeon.currency === 'keys' && (m.keys || 0) < (dungeon.entryCost || 0)) return { ok: false, reason: 'no_keys', member: m, cost: dungeon.entryCost };
  }
  const dEnergy = (cfg.energy && cfg.energy.dungeonCost) || 20;
  for (const m of members) {
    if (!players.spendEnergy(m, dEnergy)) return { ok: false, reason: 'no_energy', member: m, energy: players.getEnergy(m) };
  }
  for (const m of members) {
    if (dungeon.currency === 'gold') m.gold -= dungeon.entryCost;
    else m.keys -= dungeon.entryCost;
    m.lastDungeon = Date.now();
  }

  const allStats = members.map(m => players.totalStats(m));
  const team = {
    hp: allStats.reduce((s, st) => s + st.hp, 0),
    atk: Math.round(allStats.reduce((s, st) => s + st.atk, 0) * 0.65),
    def: Math.round((allStats.reduce((s, st) => s + st.def, 0) / members.length) * 0.9),
    spd: Math.max(...allStats.map(st => st.spd)),
    critChance: Math.max(...allStats.map(st => st.critChance || 0)),
    critDmg: Math.max(...allStats.map(st => st.critDmg || 0)),
    dodge: Math.max(...allStats.map(st => st.dodge || 0)),
    block: Math.max(...allStats.map(st => st.block || 0)),
    lifesteal: Math.max(...allStats.map(st => st.lifesteal || 0)),
    luck: Math.max(...allStats.map(st => st.luck || 0)),
    procs: allStats[0].procs,
  };
  team.name = 'Отряд: ' + members.map(m => m.name).join(', ');

  const bossMult = 2.0 + 0.5 * (members.length - 1);
  const waveCount = (dungeon.waves || 3) + (members.length - 1);
  const log = [];
  let hpLeft = team.hp;
  let win = true;
  let waveReached = 0;
  let boss = null;
  for (let wave = 1; wave <= waveCount; wave++) {
    const archetypeId = pick(dungeon.mobs || []);
    const level = randInt(dungeon.levelRange && dungeon.levelRange[0] || 1, dungeon.levelRange && dungeon.levelRange[1] || 10);
    const mob = generateWaveMob(archetypeId, level, (dungeon.rewardMult || 1) * (1 + 0.2 * members.length));
    if (!mob) continue;
    mob.name = `Волна ${wave}: ${mob.name}`;
    const battle = simulateBattle(team, mob.stats, { nameA: team.name, nameB: `${mob.emoji} ${mob.name}`, playerStartHp: hpLeft });
    hpLeft = battle.aHp;
    waveReached = wave;
    log.push(`Волна ${wave}/${waveCount}: ${battle.winnerIsA ? '✅' : '💀'} (HP ${battle.aHp}/${battle.aMaxHp})`);
    if (!battle.winnerIsA) { win = false; break; }
  }
  const bossLevel = dungeon.levelRange && dungeon.levelRange[1] || 10;
  boss = generateBoss(dungeon.boss, bossLevel, bossMult);
  const bossBattle = simulateBattle(team, boss.stats, { nameA: team.name, nameB: `${boss.emoji} ${boss.name}`, playerStartHp: hpLeft });
  hpLeft = bossBattle.aHp;
  log.push(`👑 Босс: ${bossBattle.winnerIsA ? '✅ повержен' : '💀 не осилен'}`);
  win = win && bossBattle.winnerIsA;

  const rewards = members.map(m => ({ profile: m, gold: 0, xp: 0, item: null, crystals: 0, invFull: false, levelUps: 0 }));
  const eventActiveNow = Boolean(eventCfg && eventCfg.active && eventCfg.endsAt && Date.now() < new Date(eventCfg.endsAt).getTime());
  if (win) {
    const baseGold = randInt(dungeon.gold && dungeon.gold[0] || 50, dungeon.gold && dungeon.gold[1] || 100);
    const baseXp = randInt(dungeon.xp && dungeon.xp[0] || 50, dungeon.xp && dungeon.xp[1] || 100);
    const bonus = 1 + 0.25 * (members.length - 1);
    for (let i = 0; i < members.length; i++) {
      const r = rewards[i];
      r.gold = Math.round(baseGold * bonus);
      r.xp = Math.round(baseXp * bonus);
      members[i].gold += r.gold;
      r.levelUps = players.addXp(members[i], r.xp);
      const rarityId = items.rollRarityFromWeights(dungeon.rarityWeights);
      const item = items.generateItem(randInt(dungeon.levelRange && dungeon.levelRange[0] || 1, dungeon.levelRange && dungeon.levelRange[1] || 10), { rarityId, luck: team.luck });
      if (item) {
        const added = players.addItem(members[i], item);
        if (added.sold) { r.gold += items.sellPrice(item, cfg.sellPricePerScore); }
        else r.item = item;
      }
      if (eventActiveNow) {
        r.crystals = randInt(eventCfg.dungeonBonus && eventCfg.dungeonBonus[0] || 5, eventCfg.dungeonBonus && eventCfg.dungeonBonus[1] || 10);
        members[i].eventCurrency = (members[i].eventCurrency || 0) + r.crystals;
      }
    }
  } else {
    for (const r of rewards) { r.xp = Math.round((dungeon.xp && dungeon.xp[0] || 30) * 0.3); r.levelUps = players.addXp(r.profile, r.xp); }
  }

  return { ok: true, win, waveReached, waves: waveCount, log, boss, rewards, hpLeft, maxHp: team.hp };
}


module.exports = { dungeonById, isOnCooldown, cooldownLeft, canEnter, run, runParty };
