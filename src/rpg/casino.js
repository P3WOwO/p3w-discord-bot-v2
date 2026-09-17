// Казино: монетка, кубики против дилера, слоты. Матожидание ~0.9 (казино в плюсе).
const { casino: cfg, randInt, pick } = require('./data');

function playCoinflip(bet) {
  const win = Math.random() < 0.5;
  return {
    game: '🪙 Монетка',
    win,
    push: false,
    payout: win ? Math.round(bet * (cfg.coinflipMultiplier || 1.95)) : 0,
    detail: win ? '🪙 Орёл — выигрыш!' : '🪙 Решка — не повезло',
  };
}

function playDice(bet) {
  const playerRoll = randInt(1, 6) + randInt(1, 6);
  const dealerRoll = randInt(1, 6) + randInt(1, 6);
  if (playerRoll > dealerRoll) {
    return { game: '🎲 Кубики', win: true, push: false, payout: Math.round(bet * (cfg.diceMultiplier || 1.9)), detail: `🎲 ${playerRoll} против ${dealerRoll} — победа!` };
  }
  if (playerRoll === dealerRoll) {
    return { game: '🎲 Кубики', win: false, push: true, payout: bet, detail: `🎲 ${playerRoll} против ${dealerRoll} — ничья, ставка возвращается` };
  }
  return { game: '🎲 Кубики', win: false, push: false, payout: 0, detail: `🎲 ${playerRoll} против ${dealerRoll} — дилер выиграл` };
}

function slotsTripleKey(reels) {
  return Object.keys(cfg.slotsTriple || {})[0];
}

function playSlots(bet) {
  const symbols = Object.keys(cfg.slotsTriple || { '💎': 25, '🍒': 4 });
  const reels = [pick(symbols), pick(symbols), pick(symbols)];

  let mult = 0;
  if (reels[0] === reels[1] && reels[1] === reels[2]) {
    mult = cfg.slotsTriple[reels[0]] || 4;
  } else if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) {
    mult = cfg.slotsTwoMultiplier || 1.5;
  }

  const win = mult > 0;
  return {
    game: '🎰 Слоты',
    win,
    push: false,
    payout: Math.round(bet * mult),
    detail: `[ ${reels.join(' ')} ]${win ? ` ×${mult}!` : ' — мимо'}`,
  };
}

const GAMES = {
  coinflip: playCoinflip,
  dice: playDice,
  slots: playSlots,
};

function play(gameId, bet) {
  const game = GAMES[gameId];
  if (!game) return null;
  return game(bet);
}

function limits() {
  return { minBet: cfg.minBet || 10, maxBet: cfg.maxBet || 10000, presets: cfg.betPresets || [10, 100, 500, 1000, 2500] };
}

module.exports = { play, limits };
