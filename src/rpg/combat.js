// Авто-бой: один движок для PvE и PvP. Статы в процентах (5 = 5%).
const { stats: cfg } = require('./data');

function toCombatant(s, name) {
  const c = {
    name,
    maxHp: Math.max(1, Math.round(s.hp || 1)),
    atk: Math.max(1, s.atk || 1),
    def: Math.max(0, s.def || 0),
    spd: Math.max(1, s.spd || 1),
    critChance: Math.min(60, s.critChance || 0),
    critDmg: 150 + (s.critDmg || 0),
    dodge: Math.min(40, s.dodge || 0),
    lifesteal: s.lifesteal || 0,
    block: Math.min(50, s.block || 0),
    counterChance: Math.min(40, s.counterChance || 0),
    stunChance: Math.min(30, s.stunChance || 0),
    reflect: Math.min(50, s.reflect || 0),
    pierce: Math.min(60, s.pierce || 0),
    regen: s.regen || 0,
  };
  c.hp = c.maxHp;
  c.stun = 0;
  return c;
}

function strike(att, def, log, variance) {
  if (Math.random() * 100 < def.dodge) {
    log.push(`💨 ${def.name} уклоняется от ${att.name}`);
    return;
  }

  let dmg = att.atk * (1 + (Math.random() * 2 - 1) * variance);
  const effDef = Math.max(0, def.def * (1 - att.pierce / 100));
  dmg *= 1 - effDef / (effDef + 50);
  dmg = Math.max(1, dmg);

  let line = '';
  if (Math.random() * 100 < att.critChance) {
    dmg *= att.critDmg / 100;
    line = '💥';
  }
  if (Math.random() * 100 < def.block) {
    dmg *= 0.5;
    line += '🛡';
  }
  dmg = Math.max(1, Math.round(dmg));
  def.hp -= dmg;

  let extra = '';
  if (att.lifesteal > 0 && att.hp < att.maxHp) {
    const heal = Math.round(dmg * att.lifesteal / 100);
    att.hp = Math.min(att.maxHp, att.hp + heal);
    extra += ` | вампиризм +${heal}❤`;
  }
  log.push(`${line || '⚔️'} ${att.name} → ${def.name}: -${dmg}${line.includes('💥') ? ' КРИТ' : ''}${extra}`.trim());

  if (def.reflect > 0 && def.hp > 0) {
    const reflected = Math.max(1, Math.round(dmg * def.reflect / 100));
    att.hp -= reflected;
    log.push(`🪞 ${def.name} отражает ${reflected} урона`);
  }
  if (att.stunChance > 0 && def.hp > 0 && Math.random() * 100 < att.stunChance) {
    def.stun += 1;
    log.push(`🌀 ${def.name} оглушён и пропустит ход!`);
  }
}

function simulateBattle(statsA, statsB, opts = {}) {
  const A = toCombatant(statsA, opts.nameA || 'Игрок');
  const B = toCombatant(statsB, opts.nameB || 'Монстр');
  const log = [];
  const maxRounds = opts.maxRounds || (cfg.combat?.maxRounds || 30);
  const variance = cfg.combat?.variance || 0.1;

  let round = 0;
  while (A.hp > 0 && B.hp > 0 && round < maxRounds) {
    round++;
    const order = A.spd >= B.spd ? [[A, B], [B, A]] : [[B, A], [A, B]];
    for (const [att, def] of order) {
      if (att.hp <= 0 || def.hp <= 0) continue;
      if (att.stun > 0) {
        att.stun--;
        log.push(`😵 ${att.name} пропускает ход`);
        continue;
      }
      strike(att, def, log, variance);
      if (def.hp > 0 && att.hp > 0 && def.counterChance > 0 && Math.random() * 100 < def.counterChance) {
        const cDmg = Math.max(1, Math.round(def.atk * 0.4 * (1 + (Math.random() * 2 - 1) * variance)));
        att.hp -= cDmg;
        log.push(`↩️ ${def.name} контратакует: -${cDmg}`);
      }
    }
    for (const fighter of [A, B]) {
      if (fighter.regen > 0 && fighter.hp > 0 && fighter.hp < fighter.maxHp) {
        fighter.hp = Math.min(fighter.maxHp, fighter.hp + fighter.regen);
      }
    }
  }

  // Победитель: по выживанию, затем по проценту остатка HP.
  let winnerIsA;
  if (A.hp > 0 && B.hp <= 0) winnerIsA = true;
  else if (B.hp > 0 && A.hp <= 0) winnerIsA = false;
  else winnerIsA = (A.hp / A.maxHp) >= (B.hp / B.maxHp);

  return {
    winnerIsA,
    rounds: round,
    aHp: Math.max(0, Math.round(A.hp)),
    aMaxHp: A.maxHp,
    bHp: Math.max(0, Math.round(B.hp)),
    bMaxHp: B.maxHp,
    log: log.slice(-12),
  };
}

module.exports = { simulateBattle, toCombatant };
