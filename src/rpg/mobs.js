// Генерация мобов: архетип + случайный модификатор + уровень зоны.
const { mobs, randInt, pick, clamp, weightedPick } = require('./data');

function generateMob(zone, playerLevel = 1) {
  const pool = (mobs.archetypes || []).filter(a => (a.zones || []).includes(zone.id));
  const archetype = pool.length ? pick(pool) : pick(mobs.archetypes || []);
  if (!archetype) return null;

  const level = clamp(randInt(zone.minLevel, zone.maxLevel), 1, 99);

  const plain = { id: null, weight: mobs.plainWeight || 70 };
  const mod = weightedPick([plain, ...(mobs.modifiers || [])], e => e.weight);

  const statMult = (1 + (level - 1) * 0.13) * (mod?.statMult || 1);
  const stats = {};
  for (const [stat, range] of Object.entries(archetype.stats || {})) {
    stats[stat] = Math.max(1, Math.round(randInt(range[0], range[1]) * statMult));
  }

  const rewardScale = (zone.rewardMult || 1) * (1 + (level - 1) * 0.15);
  const xp = Math.max(1, Math.round(randInt(archetype.xp?.[0] || 10, archetype.xp?.[1] || 20) * rewardScale * (mod?.lootMult || 1)));
  const gold = Math.max(1, Math.round(randInt(archetype.gold?.[0] || 5, archetype.gold?.[1] || 15) * rewardScale * (mod?.goldMult || 1)));

  return {
    archetypeId: archetype.id,
    name: `${mod && mod.name ? `${mod.name} ` : ''}${archetype.name} (ур. ${level})`,
    emoji: (mod && mod.emoji) || archetype.emoji || '👾',
    level,
    stats,
    xp,
    gold,
    lootMult: (mod?.lootMult || 1),
  };
}

module.exports = { generateMob };
