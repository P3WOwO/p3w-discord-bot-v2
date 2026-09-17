// PvP: дуэли билдов + рейтинг Эло. Спарринг — бой с копией себя без рейтинга.
const { stats: cfg } = require('./data');
const { simulateBattle } = require('./combat');
const players = require('./players');

function isOnCooldown(profile) {
  const cd = (cfg.pvp?.cooldown || 120) * 1000;
  return Date.now() - (profile.lastPvp || 0) < cd;
}

function cooldownLeft(profile) {
  const cd = (cfg.pvp?.cooldown || 120) * 1000;
  return Math.max(0, Math.ceil(((profile.lastPvp || 0) + cd - Date.now()) / 1000));
}

function expectedScore(ra, rb) {
  return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}

function updateRatings(winner, loser) {
  const K = cfg.pvp?.kFactor || 32;
  const ew = expectedScore(winner.rating || 1000, loser.rating || 1000);
  const delta = Math.max(5, Math.round(K * (1 - ew)));
  winner.rating = (winner.rating || 1000) + delta;
  loser.rating = Math.max(100, (loser.rating || 1000) - delta);
  winner.pvpWins = (winner.pvpWins || 0) + 1;
  loser.pvpLosses = (loser.pvpLosses || 0) + 1;
  return { delta, winnerRating: winner.rating, loserRating: loser.rating };
}

// Полная дуэль. a атакует b. Меняет рейтинги, монеты, счёт. Сохранение — снаружи.
function duel(profileA, profileB, { sparring = false } = {}) {
  const battle = simulateBattle(players.totalStats(profileA), players.totalStats(profileB), {
    nameA: profileA.name,
    nameB: profileB.name,
  });

  profileA.lastPvp = Date.now();

  const result = {
    ok: true,
    battle,
    win: battle.winnerIsA,
    sparring,
    ratingBefore: profileA.rating || 1000,
    ratingAfter: profileA.rating || 1000,
    opponentRating: profileB.rating || 1000,
    coins: 0,
  };

  if (sparring) {
    // Спарринг: бьёмся с копией себя (статы соперника ×1.05), награда маленькая, рейтинг не трогаем.
    if (result.win) {
      result.coins = cfg.pvp?.sparCoins || 10;
      profileA.gold += result.coins;
      players.addXp(profileA, 20);
    }
    return result;
  }

  const pcfg = cfg.pvp || {};
  if (result.win) {
    const { delta } = updateRatings(profileA, profileB);
    result.ratingDelta = delta;
    result.coins = Math.round((pcfg.winCoinsBase || 50) + Math.max(0, (profileB.rating || 1000) - (profileA.rating || 0)) * (pcfg.winCoinsPerRating || 0.5));
    profileA.gold += result.coins;
    players.addXp(profileA, 30);
  } else {
    // Проигравший атакующий теряет рейтинг, получает утешительные монеты.
    const { delta } = updateRatings(profileB, profileA);
    result.ratingDelta = -delta;
    result.coins = pcfg.loseCoins || 15;
    profileA.gold += result.coins;
    players.addXp(profileA, 10);
  }
  result.ratingAfter = profileA.rating;

  return result;
}

module.exports = { duel, isOnCooldown, cooldownLeft, updateRatings, expectedScore };
