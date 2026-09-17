// Данжи: волны мобов + босс, вход за монеты/ключи, жирный лут.
const { stats: cfg, dungeons: dungeonCfg, randInt, pick } = require('./data');
const { generateMob, generateWaveMob, generateBoss } = require('./mobs');
const { simulateBattle } = require('./combat');
const items = require('./items');
const players = require('./players');
const pets = require('./pets');

function dungeonById(id) {
  return (dungeonCfg.dungeons || []).find(d => d.id === id) || null;
}

function isOnCooldown(profile) {
  const cd = (dungeonCfg.cooldownMinutes || 3) * 60 * 1000;
  return Date.now() - (profile.lastDungeon || 0) < cd;
}

function cooldownLeft(profile) {
  const cd = (dungeonCfg.cooldownMinutes || 3) * 60 * 1000;
  return Math.max(0, Math.ceil(((profile.lastDungeon || 0) + cd - Date.now()) / 1000));
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
  const boss = generateBoss(dungeon.boss, bossLevel);
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

  const pet = pets.tryCapture(
    { archetypeId: boss.archetypeId, shortName: boss.shortName, emoji: '🐾', level: boss.level, modifierId: null },
    profile,
    playerStats.luck || 0
  );
  result.pet = pet;

  result.log = log;
  return result;
}

module.exports = { dungeonById, isOnCooldown, cooldownLeft, canEnter, run };
