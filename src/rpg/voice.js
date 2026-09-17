// Награды за войс: минуты в голосовом канале капают монеты, редко ключи.
const { stats: cfg } = require('./data');
const players = require('./players');

// Начисляет только кэшированным профилям (активным игрокам) — без спама по БД.
async function award(userId, seconds) {
  const profile = players.getCached(userId);
  if (!profile || seconds <= 0) return null;

  const pcfg = cfg.voice || {};
  const minutes = seconds / 60;
  const coins = Math.floor(minutes * (pcfg.coinsPerMinute || 1));
  if (coins <= 0 && Math.random() * 100 > minutes * (pcfg.keyChancePerMinute || 0)) return null;

  profile.gold += coins;
  let key = false;
  if (Math.random() * 100 < minutes * (pcfg.keyChancePerMinute || 0)) {
    profile.keys += 1;
    key = true;
  }
  if (coins > 0 || key) await players.saveProfile(profile);
  return { coins, key };
}

module.exports = { award };
