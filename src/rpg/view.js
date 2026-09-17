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
    )
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
    if (item) equipped.push(`${itemBases.slotNames?.[slot] || slot}: ${itemShort(item)}`);
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
  const { mob, battle } = huntResult;
  const color = huntResult.win ? 0x57f287 : 0xed4245;
  const e = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${huntResult.win ? '✅ Победа' : '💀 Поражение'}: ${mob.emoji} ${mob.name}`)
    .addFields(
      { name: 'Твоё HP', value: `${battle.aHp}/${battle.aMaxHp}`, inline: true },
      { name: 'HP моба', value: `${battle.bHp}/${battle.bMaxHp}`, inline: true },
      { name: 'Раунды', value: String(battle.rounds), inline: true },
    );

  const rewards = [];
  if (huntResult.win) {
    rewards.push(`🪙 +${huntResult.gold}`, `📗 +${huntResult.xp} XP`);
    if (huntResult.item) rewards.push(`🎁 ${itemShort(huntResult.item)}`);
    if (huntResult.key) rewards.push('🗝 +1 ключ!');
    if (huntResult.invFull) rewards.push('⚠️ Сумка полна — предмет продан автоматически');
  } else {
    rewards.push(`📗 +${huntResult.xp} XP (утешительные)`);
  }
  if (huntResult.levelUps) rewards.push(`🎉 **УРОВЕНЬ ВЫРОС! Теперь ${profile.level}**`);
  e.addFields({ name: 'Награды', value: rewards.join('\n') || '—' });

  if (battle.log && battle.log.length) {
    e.addFields({ name: 'Лог боя', value: battle.log.join('\n').slice(0, 1020) });
  }
  return e;
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
};
