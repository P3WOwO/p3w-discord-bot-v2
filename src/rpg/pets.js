// Питомцы: ловля мобов, активный питомец даёт % к статам.
const { pets: cfg, mobs: mobData } = require('./data');

function bonusPct(pet) {
  return Math.min(cfg.bonusCap || 15, (cfg.bonusBase || 2) + (pet?.level || 1) * (cfg.bonusPerLevel || 0.15));
}

function getActivePet(profile) {
  return (profile.pets || []).find(p => p.uid === profile.activePetId) || null;
}

// Шанс поймать моба после победы. Возвращает питомца или null.
function tryCapture(mob, profile, luck = 0) {
  if ((profile.pets || []).length >= (cfg.maxPets || 20)) return null;

  let chance = (cfg.captureChance || 8) + luck * (cfg.luckToCapture || 0.2);
  if (mob.modifierId) {
    chance += (cfg.modifierCaptureBonus || {})[mob.modifierId] || 0;
  }

  if (Math.random() * 100 >= chance) return null;

  const pet = {
    uid: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    archetypeId: mob.archetypeId,
    name: mob.shortName || 'Моб',
    emoji: mob.emoji || '🐾',
    level: mob.level,
    modifierId: mob.modifierId || null,
    capturedAt: new Date().toISOString(),
  };
  profile.pets = profile.pets || [];
  profile.pets.push(pet);
  return pet;
}

function releasePrice(pet) {
  return Math.max(10, Math.round((cfg.releasePricePerLevel || 15) * (pet?.level || 1)));
}

module.exports = { bonusPct, getActivePet, tryCapture, releasePrice };
