// Профили игроков: Supabase (rpg_state) + локальный фолбэк + кэш в памяти.
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { stats: cfg, itemBases, pets: petsCfg } = require('./data');
const items = require('./items');
const petUtils = require('./pets');

const TABLE = 'rpg_state';
const DATA_DIR = process.env.DATA_DIR || path.join('/tmp', 'p3w-bot');
const LOCAL_FILE = path.join(DATA_DIR, 'rpg_players.json');

const cache = new Map();
let supabase = null;
let enabled = false;

function emptyEquipment() {
  const equipment = {};
  for (const slot of itemBases.slots || []) equipment[slot] = null;
  return equipment;
}

function createProfile(user) {
  return {
    userId: user.id,
    name: user.displayName || user.username || 'Безымянный',
    level: 1,
    xp: 0,
    gold: cfg.startingGold || 200,
    keys: 0,
    stats: { ...(cfg.baseStats || { hp: 120, atk: 12, def: 6, spd: 10 }) },
    equipment: emptyEquipment(),
    inventory: [],
    pets: [],
    activePetId: null,
    rating: cfg.pvp?.startRating || 1000,
    pvpWins: 0,
    pvpLosses: 0,
    lastHunt: 0,
    lastDungeon: 0,
    lastPvp: 0,
    createdAt: new Date().toISOString(),
    score: 0,
  };
}

function saveLocal() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LOCAL_FILE, JSON.stringify(Object.fromEntries(cache), null, 2));
  } catch (err) {
    console.error('⚠️ RPG local save failed:', err.message);
  }
}

function loadLocal() {
  try {
    if (!fs.existsSync(LOCAL_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8'));
    for (const [userId, profile] of Object.entries(raw || {})) {
      if (profile && profile.userId) cache.set(userId, profile);
    }
  } catch (err) {
    console.error('⚠️ RPG local load failed:', err.message);
  }
}

function init(config) {
  loadLocal();
  if (config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY) {
    supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    enabled = true;
    console.log('🎲 RPG storage: Supabase (rpg_state)');
  } else {
    console.log('🎲 RPG storage: local fallback only');
  }
}

async function getProfile(user, guildId) {
  let profile = cache.get(user.id);
  if (!profile && enabled) {
    try {
      const { data } = await supabase.from(TABLE).select('data').eq('user_id', user.id).maybeSingle();
      profile = data?.data || null;
    } catch (err) {
      console.error('⚠️ RPG profile load failed:', err.message);
    }
  }
  if (!profile) profile = createProfile(user);
  profile.userId = user.id;
  profile.name = user.displayName || profile.name || user.username;
  if (guildId) profile.guildId = guildId;
  // Нормализация старых профилей: новые поля, добавленные в апдейтах.
  profile.pets = Array.isArray(profile.pets) ? profile.pets : [];
  profile.rating = profile.rating || cfg.pvp?.startRating || 1000;
  profile.pvpWins = profile.pvpWins || 0;
  profile.pvpLosses = profile.pvpLosses || 0;
  profile.lastDungeon = profile.lastDungeon || 0;
  profile.lastPvp = profile.lastPvp || 0;
  cache.set(user.id, profile);
  return profile;
}

async function saveProfile(profile) {
  profile.score = calcScore(profile);
  cache.set(profile.userId, profile);
  saveLocal();
  if (!enabled) return;
  try {
    await supabase.from(TABLE).upsert({
      user_id: profile.userId,
      guild_id: profile.guildId || null,
      data: profile,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
  } catch (err) {
    console.error('⚠️ RPG profile save failed:', err.message);
  }
}

async function getAllProfiles() {
  let remote = [];
  if (enabled) {
    try {
      const { data } = await supabase.from(TABLE).select('data').limit(500);
      remote = (data || []).map(row => row?.data).filter(Boolean);
    } catch (err) {
      console.error('⚠️ RPG all-profiles load failed:', err.message);
    }
  }
  const merged = new Map();
  for (const profile of remote) merged.set(profile.userId, profile);
  for (const [userId, profile] of cache) merged.set(userId, profile);
  return [...merged.values()];
}

function xpForLevel(level) {
  return Math.round((cfg.levelCurve?.baseXp || 80) * Math.pow(cfg.levelCurve?.growth || 1.3, level - 1));
}

// Возвращает количество полученных уровней.
function addXp(profile, amount) {
  let levelUps = 0;
  profile.xp += Math.max(0, Math.round(amount));
  const maxLevel = cfg.levelCurve?.maxLevel || 50;
  const growth = cfg.levelStats || { hp: 14, atk: 1.4, def: 0.8, spd: 0.35 };
  while (profile.level < maxLevel && profile.xp >= xpForLevel(profile.level)) {
    profile.xp -= xpForLevel(profile.level);
    profile.level += 1;
    levelUps += 1;
    for (const [stat, value] of Object.entries(growth)) {
      profile.stats[stat] = Math.round(((profile.stats[stat] || 0) + value) * 10) / 10;
    }
  }
  return levelUps;
}

// Суммарные боевые статы: база уровня + вся экипировка (с заточкой).
function totalStats(profile) {
  const s = {
    hp: profile.stats?.hp || 0,
    atk: profile.stats?.atk || 0,
    def: profile.stats?.def || 0,
    spd: profile.stats?.spd || 0,
    critChance: cfg.critBase || 5,
    critDmg: 0, dodge: 0, lifesteal: 0, block: 0, counterChance: 0,
    stunChance: 0, reflect: 0, pierce: 0, regen: 0,
    goldFind: 0, xpBonus: 0, luck: 0,
  };
  for (const slot of itemBases.slots || []) {
    const item = profile.equipment?.[slot];
    if (!item) continue;
    for (const [stat, value] of Object.entries(items.effectiveItemStats(item))) {
      s[stat] = Math.round(((s[stat] || 0) + value) * 10) / 10;
    }
  }
  for (const key of ['hp', 'atk', 'def', 'spd']) s[key] = Math.round(s[key]);

  // Активный питомец: % ко всем главным статам.
  const pet = getActivePet(profile);
  if (pet) {
    const pct = petUtils.bonusPct(pet);
    for (const key of ['hp', 'atk', 'def', 'spd']) {
      s[key] = Math.round(s[key] * (1 + pct / 100));
    }
    s.petBonus = pct;
  }
  return s;
}

function getActivePet(profile) {
  return (profile.pets || []).find(p => p.uid === profile.activePetId) || null;
}

function getCached(userId) {
  return cache.get(userId) || null;
}

function calcScore(profile) {
  const weights = items.SCORE_WEIGHTS;
  const s = totalStats(profile);
  let score = (profile.level || 1) * 15;
  for (const [stat, value] of Object.entries(s)) {
    score += (weights[stat] || 0.5) * value;
  }
  return Math.max(1, Math.round(score));
}

function addItem(profile, item) {
  const cap = cfg.inventoryCap || 60;
  profile.inventory = profile.inventory || [];
  if (profile.inventory.length >= cap) {
    profile.gold += items.sellPrice(item, cfg.sellPricePerScore);
    return { sold: true };
  }
  profile.inventory.push(item);
  return { sold: false };
}

function findItem(profile, uid) {
  return (profile.inventory || []).find(item => item.uid === uid) || null;
}

function equippedItem(profile, uid) {
  for (const slot of itemBases.slots || []) {
    if (profile.equipment?.[slot]?.uid === uid) return { slot, item: profile.equipment[slot] };
  }
  return null;
}

module.exports = {
  init,
  getProfile,
  saveProfile,
  getAllProfiles,
  saveLocal,
  xpForLevel,
  addXp,
  totalStats,
  calcScore,
  addItem,
  findItem,
  equippedItem,
  emptyEquipment,
  getActivePet,
  getCached,
};


