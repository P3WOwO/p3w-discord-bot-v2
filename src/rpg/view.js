// Отображение: embed'ы профиля, инвентаря, боя, дропа.
const { EmbedBuilder } = require('discord.js');
const { stats: cfg, itemBases, rarities, mobs: mobData } = require('./data');
const items = require('./items');
const players = require('./players');

function rarityEmoji(rarityId) {
  const map = { common: '⚪', uncommon: '🟢', rare: '🔵', epic: '🟣', legendary: '🟠' };
  return map[rarityId] || '▫️';
}

function statLine(stats, keys) {
  return (keys || Object.keys(stats))
    .filter(k => stats[k])
    .map(k => `**${STAT_NAMES[k] || k}:** ${stats[k]}`)
    .join(' • ');
}

const STAT_NAMES = {
  hp: '❤️', atk: '🗡', def: '🛡', spd: '👟',
  critChance: '🎯', critDmg: '💥', dodge: '💨', lifesteal: '🩸',
  block: '🧱', counterChance: '↩️', stunChance: '🌀', reflect: '🪞',
  pierce: '🔩', regen: '♻️', goldFind: '🪙', xpBonus: '📗', luck: '🍀',
};

function itemShort(item) {
  const rarity = rarities[item.rarity] || {};
  const upg = item.upg ? ` +${item.upg}` : '';
  return `${rarityEmoji(item.rarity)} **${item.name}**${upg} (ур.${item.level}, score ${item.score})`;
}

function itemDetails(item) {
  const lines = [itemShort(item)];
  const eff = items.effectiveItemStats(item);
  const flat = statLine(eff, ['hp', 'atk', 'def', 'spd']);
  const perc = statLine(eff, ['critChance', 'critDmg', 'dodge', 'lifesteal', 'block', 'counterChance', 'stunChance', 'reflect', 'pierce', 'regen', 'goldFind', 'xpBonus', 'luck']);
  if (flat) lines.push(flat);
  if (perc) lines.push(perc);
  return lines.join('\n');
}

function xpBar(profile) {
  const need = players.xpForLevel(profile.level);
  const filled = Math.min(10, Math.round((profile.xp / need) * 10));
  return `${'🟩'.repeat(filled)}${'⬜'.repeat(10 - filled)} ${profile.xp}/${need}`;
}

function equipmentLine(profile) {
  const parts = [];
  for (const slot of itemBases.slots || []) {
    const item = profile.equipment?.[slot];
    if (!item) continue;
    const upg = item.upg ? `+${item.upg}` : '';
    parts.push(`${rarityEmoji(item.rarity)} ${item.name}${upg}`);
  }
  return parts.join('\n') || 'Пусто, надень что-нибудь в 🎒';
}

function petsLine(profile) {
  const pet = players.getActivePet(profile);
  if (!pet) return 'Нет активного питомца';
  return `${pet.emoji} **${pet.name}** (ур.${pet.level}) — +${players.totalStats(profile).petBonus || 0}% к статам`;
}

function profileEmbed(profile) {
  const s = players.totalStats(profile);
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`⚔️ ${profile.name} — ур. ${profile.level}`)
    .setDescription(xpBar(profile))
    .addFields(
      { name: 'Статы', value: statLine(s, ['hp', 'atk', 'def', 'spd', 'critChance', 'critDmg', 'dodge', 'lifesteal']) || '—', inline: false },
      { name: 'Бонусы', value: statLine(s, ['block', 'counterChance', 'stunChance', 'reflect', 'pierce', 'regen', 'goldFind', 'xpBonus', 'luck']) || '—', inline: false },
      { name: `🪙 Монеты: ${profile.gold}`, value: `🗝 Ключи: ${profile.keys || 0}`, inline: true },
      { name: 'Score', value: String(profile.score || players.calcScore(profile)), inline: true },
      { name: 'Экипировка', value: equipmentLine(profile), inline: false },
      { name: '🐾 Отряд', value: petsLine(profile), inline: false },
      { name: '⚡ Энергия', value: `${players.getEnergy(profile)}/${(cfg.energy && cfg.energy.max) || 100}`, inline: true },
      { name: '💎 Кристаллы', value: String(profile.eventCurrency || 0), inline: true },
      { name: '🗡 PvP', value: `Рейтинг: ${profile.rating || 1000} (${profile.pvpWins || 0}П / ${profile.pvpLosses || 0}Пр)`, inline: true },
    )
    .setFooter({ text: 'RPG v1.2' })
    .setTimestamp();
}

function itemLine(item, idx) {
  const rarity = rarities[item.rarity] || {};
  const upg = item.upg ? ` +${item.upg}` : '';
  return `${rarity.emoji || '▫️'} **[${idx}]** ${item.name}${upg} (ур.${item.level}) — ${item.score}(score)`;
}

function inventoryEmbed(profile) {
  const equipped = [];
  for (const slot of itemBases.slots || []) {
    const item = profile.equipment?.[slot];
    equipped.push(`${itemBases.slotNames?.[slot] || slot}: ${item ? itemShort(item) : '— пусто'}`);
  }
  const inv = (profile.inventory || []).map((item, idx) => itemLine(item, idx));
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`🎒 Инвентарь ${profile.name}`)
    .addFields(
      { name: 'Надето', value: equipped.join('\n') || 'Ничего' },
      { name: `Сумка (${(profile.inventory || []).length}/${cfg.inventoryCap || 60})`, value: inv.slice(0, 25).join('\n') || 'Пусто' },
    )
    .setTimestamp();
}

function battleResultEmbed(huntResult, profile) {
  const lines = [];
  for (const en of huntResult.enemies || []) {
    lines.push(`${en.defeated ? '✅' : '💀'} ${en.mob.emoji} ${en.mob.name}`);
  }
  const title = huntResult.win ? '✅ Победа' : (huntResult.kills > 0 ? '⚔️ Убито ' + huntResult.kills + '/' + huntResult.total + ', но ты пал' : '💀 Поражение');
  const embed = new EmbedBuilder()
    .setColor(huntResult.win ? 0x57f287 : 0xed4245)
    .setTitle(title)
    .addFields(
      { name: 'Твоё HP', value: `${huntResult.hpLeft}/${huntResult.maxHp}`, inline: true },
      { name: 'Враги', value: lines.join('\n').slice(0, 1020) || '—' },
    );

  const rewards = [];
  if (huntResult.gold) rewards.push(`🪹 +${huntResult.gold}`);
  if (huntResult.xp) rewards.push(`📗 +${huntResult.xp} XP`);
  if (huntResult.item) rewards.push(`🎁 ${itemShort(huntResult.item)}`);
  if (huntResult.key) rewards.push('🗝 +1 ключ!');
  if (huntResult.crystals) rewards.push(`💎 +${huntResult.crystals} кристалла!`);
  if (huntResult.pet) rewards.push(`🐾 Пойман питомец: **${huntResult.pet.name}** (ур.${huntResult.pet.level})!`);
  if (huntResult.invFull) rewards.push('⚠️ Сумка полна — предмет продан автоматически');
  if (huntResult.levelUps) rewards.push(`🎉 **УРОВЕНЬ! Теперь ${profile.level}**`);
  embed.addFields({ name: 'Награды', value: rewards.join('\n') || '—' });

  const logs = (huntResult.enemies || []).flatMap(x => (x.battle && x.battle.log) || []);
  if (logs.length) {
    embed.addFields({ name: 'Лог боя', value: logs.slice(-12).join('\n').slice(0, 1020) });
  }
  return embed;
}

function chestResultEmbed(result) {
  const rarity = rarities[result.item.rarity] || {};
  return new EmbedBuilder()
    .setColor(rarity.color || 0x5865f2)
    .setTitle(`${result.chest.emoji} ${result.chest.name} открыт!`)
    .setDescription(itemDetails(result.item))
    .addFields({ name: 'Продать?', value: `Цена: ~${items.sellPrice(result.item, cfg.sellPricePerScore)} 🪙` })
    .setTimestamp();
}

function zonesListEmbed(profile) {
  const zones = (mobData.zones || []).map(z => {
    const locked = profile.level < (z.minLevel || 1);
    return `${z.emoji} **${z.name}** (ур. ${z.minLevel}–${z.maxLevel})${locked ? ' 🔒' : ''}`;
  });
  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('🌍 Зоны охоты')
    .setDescription(zones.join('\n') || 'Пусто')
    .setFooter({ text: 'Охота приносит XP, монеты, лут и ключи' });
}

function dungeonResultEmbed(result, profile) {
  const d = result.dungeon;
  const e = new EmbedBuilder()
    .setColor(result.win ? 0x57f287 : 0xed4245)
    .setTitle(`${d.emoji} ${d.name}: ${result.win ? 'зачищен!' : 'провал'}`)
    .addFields(
      { name: 'Волны', value: `${result.win ? 'Все пройдены' : `Дошёл до ${result.waveReached}/${d.waves}`} + босс`, inline: true },
      { name: '👑 Босс', value: result.boss ? (result.win ? `${result.boss.name} — повержен` : `${result.boss.name} оказался сильнее`) : '—', inline: true },
    );

  const rewards = [];
  if (result.win) {
    rewards.push(`🪙 +${result.gold}`, `📗 +${result.xp} XP`);
    for (const item of result.items || []) rewards.push(`🎁 ${itemShort(item)}`);
    if (result.keys) rewards.push('🗝 +1 ключ!');
    if (result.crystals) rewards.push(`💎 +${result.crystals} кристалла!`);
    if (result.pet) rewards.push(`🐾 Пойман питомец: **${result.pet.name}** (ур.${result.pet.level})!`);
    if (result.invFull) rewards.push('⚠️ Сумка полна — часть лута продана');
  } else {
    rewards.push(`📗 +${result.xp} XP (за смелость)`);
  }
  if (result.levelUps) rewards.push(`🎉 **УРОВЕНЬ! Теперь ${profile.level}**`);
  e.addFields({ name: 'Награды', value: rewards.join('\n') || '—' });

  if (result.log && result.log.length) {
    e.addFields({ name: 'Ход забега', value: result.log.join('\n').slice(0, 1020) });
  }
  return e;
}

function dungeonsListEmbed(profile) {
  const list = (require('./data').dungeons.dungeons || []).map(d => {
    const locked = profile.level < (d.minLevel || 1);
    const cost = d.currency === 'gold' ? `${d.entryCost} 🪙` : `${d.entryCost} 🗝`;
    return `${d.emoji} **${d.name}** — ур.${d.minLevel}+, вход ${cost}, волн: ${d.waves} + босс${locked ? ' 🔒' : ''}`;
  });
  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('🐉 Данжи')
    .setDescription(list.join('\n') || 'Пусто')
    .setFooter({ text: 'Данж = волны мобов + босс. Лут жирнее охоты, шанс поймать питомца выше' });
}

function pvpResultEmbed(result, attacker, defender) {
  const { battle } = result;
  const e = new EmbedBuilder()
    .setColor(result.win ? 0x57f287 : 0xed4245)
    .setTitle(`🗡 ${result.sparring ? '🥊 Спарринг' : 'PvP'}: ${result.win ? `${attacker.name} победил` : `${defender.name} победил`}`)
    .addFields(
      { name: attacker.name, value: `HP ${battle.aHp}/${battle.aMaxHp}${result.sparring ? '' : `\nРейтинг: ${result.ratingBefore} → ${result.ratingAfter}`}`, inline: true },
      { name: defender.name, value: `HP ${battle.bHp}/${battle.bMaxHp}${result.sparring ? '' : `\nРейтинг: ${result.opponentRating} → ${defender.rating}`}`, inline: true },
      { name: 'Раунды', value: String(battle.rounds), inline: true },
      { name: 'Награды', value: `🪙 +${result.coins}` },
    );
  if (battle.log && battle.log.length) {
    e.addFields({ name: 'Лог боя', value: battle.log.join('\n').slice(0, 1020) });
  }
  return e;
}

function petsEmbed(profile) {
  const petsList = (profile.pets || []).map(p => {
    const active = (profile.activePets || []).includes(p.uid) ? ' ✅в отряде' : '';
    const pct = Math.min(require('./data').pets.bonusCap || 15, (require('./data').pets.bonusBase || 2) + p.level * (require('./data').pets.bonusPerLevel || 0.15));
    return `${p.emoji} **${p.name}** (ур.${p.level}) — +${pct}% к статам${active}`;
  });
  return new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`🐾 Питомцы (${(profile.pets || []).length})`)
    .setDescription(petsList.slice(0, 25).join('\n') || 'Питомцев нет — ловятся после побед на охоте и в данжах!')
    .setFooter({ text: 'Отряд: до 2 питомцев, бонусы суммируются. Отпустить = монеты' });
}

module.exports = {
  STAT_NAMES,
  rarityEmoji,
  itemShort,
  itemDetails,
  profileEmbed,
  inventoryEmbed,
  battleResultEmbed,
  chestResultEmbed,
  zonesListEmbed,
  dungeonResultEmbed,
  dungeonsListEmbed,
  pvpResultEmbed,
  petsEmbed,
};