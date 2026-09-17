// RPG-модуль: команды, кнопочное меню, роутинг взаимодействий.
const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');
const { stats: cfg, rarities, itemBases, chests: chestCfg } = require('./data');
const items = require('./items');
const players = require('./players');
const hunt = require('./hunt');
const inventory = require('./inventory');
const chests = require('./chests');
const view = require('./view');

const PREFIX = 'rpg:';
const PAGE_SIZE = 8;

// Состояние меню в памяти: userId -> { view, page }
const menuState = new Map();

function mainMenuRow(state) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PREFIX + 'profile').setLabel('📜 Профиль').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(PREFIX + 'bag').setLabel('🎒 Сумка').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(PREFIX + 'hunt').setLabel('⚔️ Охота').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(PREFIX + 'chests').setLabel('🎁 Сундуки').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(PREFIX + 'top').setLabel('🏆 Топ').setStyle(ButtonStyle.Secondary),
  );
}

async function showMainMenu(interaction, profile, edit = false) {
  const embed = view.profileEmbed(profile);
  const payload = { embeds: [embed], components: [mainMenuRow()] };
  if (edit) await interaction.update(payload).catch(() => {});
  else await interaction.reply({ ...payload, ephemeral: true }).catch(() => {});
}

async function showBag(interaction, profile, page = 0) {
  const inv = profile.inventory || [];
  const totalPages = Math.max(1, Math.ceil(inv.length / PAGE_SIZE));
  page = Math.max(0, Math.min(page, totalPages - 1));
  const slice = inv.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const rows = [];
  if (slice.length) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(PREFIX + 'item')
      .setPlaceholder('Выбери предмет: надеть / продать / заточить')
      .addOptions(slice.map((item, i) => ({
        label: `${item.name}${item.upg ? ` +${item.upg}` : ''}`.slice(0, 100),
        description: `ур.${item.level} • score ${item.score} • продажа ~${items.sellPrice(item, cfg.sellPricePerScore)}🪙`.slice(0, 100),
        value: item.uid,
        emoji: view.rarityEmoji(item.rarity),
      })));
    rows.push(new ActionRowBuilder().addComponents(select));
  }

  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PREFIX + `bag:${page - 1}`).setLabel('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(PREFIX + 'selljunk').setLabel('💸 Продать шлак').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(PREFIX + `bag:${page + 1}`).setLabel('▶️').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
    new ButtonBuilder().setCustomId(PREFIX + 'menu').setLabel('🏠 Меню').setStyle(ButtonStyle.Primary),
  );
  rows.push(nav);

  await interaction.update({ embeds: [view.inventoryEmbed(profile)], components: rows }).catch(() => {});
}

async function showHunt(interaction, profile) {
  const zones = hunt.availableZones(profile);
  if (!zones.length) {
    return interaction.update({ embeds: [new EmbedBuilder().setColor(0xed4245).setDescription('Пока нет доступных зон.')], components: [] }).catch(() => {});
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(PREFIX + 'zone')
    .setPlaceholder('Куда идём?')
    .addOptions(zones.map(z => ({
      label: z.name,
      description: `ур. ${z.minLevel}–${z.maxLevel} • награды ×${z.rewardMult}`,
      value: z.id,
      emoji: z.emoji,
    })));

  const row = new ActionRowBuilder().addComponents(select);
  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PREFIX + 'menu').setLabel('🏠 Меню').setStyle(ButtonStyle.Primary),
  );

  const embed = view.zonesListEmbed(profile);
  if (hunt.isOnCooldown(profile)) {
    embed.setFooter({ text: `⏳ Перезарядка охоты: ещё ${hunt.cooldownLeft(profile)} с (можно тыкать — бой всё равно не начнётся)` });
  }
  await interaction.update({ embeds: [embed], components: [row, nav] }).catch(() => {});
}

async function doHunt(interaction, profile, zoneId) {
  if (hunt.isOnCooldown(profile)) {
    const left = hunt.cooldownLeft(profile);
    return interaction.reply({ content: `⏳ Охота на перезарядке, подожди ${left} с.`, ephemeral: true }).catch(() => {});
  }

  const result = hunt.hunt(profile, zoneId);
  if (!result.ok) {
    return interaction.reply({ content: '❌ Ошибка охоты, попробуй ещё раз.', ephemeral: true }).catch(() => {});
  }

  await players.saveProfile(profile);
  const state = menuState.get(profile.userId) || {};
  state.view = 'hunt-result';
  state.result = result;
  menuState.set(profile.userId, state);

  const again = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PREFIX + `hunt:${zoneId}`).setLabel('🔁 Ещё раз').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(PREFIX + 'hunt-menu').setLabel('🌍 Сменить зону').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(PREFIX + 'menu').setLabel('🏠 Меню').setStyle(ButtonStyle.Primary),
  );

  await interaction.update({ embeds: [view.battleResultEmbed(result, profile)], components: [again] }).catch(() => {});
}

async function showChests(interaction, profile) {
  const rows = [];
  const list = chestCfg.chests || [];
  for (let i = 0; i < list.length; i += 2) {
    const row = new ActionRowBuilder();
    for (const chest of list.slice(i, i + 2)) {
      const currency = chest.currency === 'gold' ? '🪙' : '🗝';
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(PREFIX + `open:${chest.id}`)
          .setLabel(`${chest.name} — ${chest.cost}${currency}`)
          .setStyle(ButtonStyle.Secondary),
      );
    }
    rows.push(row);
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PREFIX + 'menu').setLabel('🏠 Меню').setStyle(ButtonStyle.Primary),
  ));

  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle('🎁 Сундуки')
    .setDescription('Предмет генерируется случайно: тип, редкость (по весам сундука), аффиксы и уровень из диапазона сундука.')
    .addFields(
      { name: '🪙 Монеты', value: String(profile.gold), inline: true },
      { name: '🗝 Ключи', value: String(profile.keys || 0), inline: true },
      { name: 'Ключи', value: 'Падают с мобов (шанс выше с элиток) — открывают топовые сундуки' },
    );
  await interaction.update({ embeds: [embed], components: rows }).catch(() => {});
}

async function openChest(interaction, profile, chestId) {
  const result = chests.open(profile, chestId);
  if (!result.ok) {
    const messages = {
      no_gold: `Не хватает монет: нужно ${result.cost} 🪙`,
      no_keys: `Не хватает ключей: нужно ${result.cost} 🗝 (падают с мобов)`,
    };
    return interaction.reply({ content: `❌ ${messages[result.reason] || 'Не получилось открыть.'}`, ephemeral: true }).catch(() => {});
  }
  await players.saveProfile(profile);

  const again = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PREFIX + `open:${chestId}`).setLabel('🔁 Ещё раз').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(PREFIX + 'chests').setLabel('🎁 К сундукам').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(PREFIX + 'menu').setLabel('🏠 Меню').setStyle(ButtonStyle.Primary),
  );
  await interaction.update({ embeds: [view.chestResultEmbed(result)], components: [again] }).catch(() => {});
}

// Действия с предметом из сумки: надеть / снять / продать / заточить.
async function handleItemAction(interaction, profile, uid, action) {
  let message = '';
  if (action === 'sell') {
    const result = inventory.sell(profile, uid);
    message = result.ok ? `💸 Продал '${result.item.name}' за ${result.price} 🪙` : '❌ Предмет не найден.';
  } else if (action === 'selljunk') {
    const result = inventory.sellJunk(profile);
    message = result.count ? `💸 Продал ${result.count} шт. за ${result.total} 🪙` : 'Шлака не нашлось 🤷';
  } else if (action === 'equip') {
    const result = inventory.equip(profile, uid);
    message = result.ok
      ? `✅ Надел '${result.item.name}'${result.replaced ? ` (снял '${result.replaced.name}')` : ''}`
      : '❌ Предмет не найден.';
  } else if (action === 'unequip') {
    const result = inventory.unequip(profile, uid);
    message = result.ok ? `🔽 Снял '${result.item.name}'` : (result.reason === 'inv_full' ? '❌ Сумка полна' : '❌ Предмет не найден.');
  } else if (action === 'upgrade') {
    const result = inventory.upgrade(profile, uid);
    if (result.ok) {
      message = result.success
        ? `🔨 Заточка удалась! '${result.item.name}' теперь +${result.item.upg} (−${result.cost} 🪙)`
        : `💔 Заточка провалилась... −${result.cost} 🪙 (шанс был ${result.chance}%)`;
    } else {
      message = result.reason === 'max' ? '🔨 Максимальная заточка'
        : result.reason === 'no_gold' ? `Не хватает монет: нужно ${result.cost} 🪙`
        : '❌ Предмет не найден.';
    }
  }

  await players.saveProfile(profile);
  await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
}

// Экран предмета: детали + кнопки действий.
async function showItem(interaction, profile, uid) {
  const item = players.findItem(profile, uid) || players.equippedItem(profile, uid)?.item;
  if (!item) {
    return interaction.reply({ content: '❌ Предмет не найден.', ephemeral: true }).catch(() => {});
  }
  const isEquipped = Boolean(players.equippedItem(profile, uid));
  const rarity = rarities[item.rarity] || {};
  const upgradeCost = items.upgradeCost(item, cfg.upgrade || {});
  const chance = Math.round(items.upgradeSuccessChance(item, cfg.upgrade || {}) * 100);

  const rows = [new ActionRowBuilder().addComponents(
    isEquipped
      ? new ButtonBuilder().setCustomId(PREFIX + `item:${uid}:unequip`).setLabel('🔽 Снять').setStyle(ButtonStyle.Secondary)
      : new ButtonBuilder().setCustomId(PREFIX + `item:${uid}:equip`).setLabel('✅ Надеть').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(PREFIX + `item:${uid}:upgrade`).setLabel(`🔨 Заточить (${upgradeCost}🪙, ${chance}%)`).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(PREFIX + `item:${uid}:sell`).setLabel(`💸 Продать (${items.sellPrice(item, cfg.sellPricePerScore)}🪙)`).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(PREFIX + 'bag:0').setLabel('🎒 В сумку').setStyle(ButtonStyle.Secondary),
  )];

  const embed = new EmbedBuilder()
    .setColor(rarity.color || 0x5865f2)
    .setTitle(`${view.rarityEmoji(item.rarity)} ${item.name}${item.upg ? ` +${item.upg}` : ''}`)
    .setDescription(view.itemDetails(item))
    .addFields(
      { name: 'Уровень предмета', value: String(item.level), inline: true },
      { name: 'Score', value: String(item.score), inline: true },
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed], components: rows, ephemeral: true }).catch(() => {});
}

async function showTop(interaction, profile, guild) {
  const all = await players.getAllProfiles();
  const sorted = all
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 10);

  const lines = [];
  for (const [i, p] of sorted.entries()) {
    const medal = ['🥇', '🥈', '🥉'][i] || `**${i + 1}.**`;
    lines.push(`${medal} ${p.name} — ур.${p.level}, score ${p.score || 0}, 🪙 ${p.gold}`);
  }

  const embed = new EmbedBuilder()
    .setColor(0xfaa61a)
    .setTitle('🏆 Топ игроков РПГ')
    .setDescription(lines.join('\n') || 'Пока пусто — стань первым!')
    .setTimestamp();

  await interaction.update({ embeds: [embed], components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PREFIX + 'menu').setLabel('🏠 Меню').setStyle(ButtonStyle.Primary),
  )] }).catch(() => {});
}

// ===== Slash-команды =====

function commandData() {
  return [
    new SlashCommandBuilder().setName('rpg').setDescription('Меню RPG: профиль, охота, сундуки, топ').toJSON(),
    new SlashCommandBuilder()
      .setName('hunt')
      .setDescription('Быстрая охота в выбранной зоне')
      .addStringOption(option => option.setName('zone').setDescription('Зона (см. /rpg → Охота)').setRequired(false))
      .toJSON(),
    new SlashCommandBuilder().setName('profile').setDescription('Показать свой RPG-профиль').toJSON(),
  ];
}

async function handleCommand(interaction, bot) {
  await interaction.deferReply({ ephemeral: true });
  const user = {
    id: interaction.user.id,
    username: interaction.user.username,
    displayName: interaction.member?.displayName,
  };
  const profile = await players.getProfile(user, interaction.guildId);

  if (interaction.commandName === 'rpg') {
    menuState.set(profile.userId, { view: 'menu' });
    const embed = view.profileEmbed(profile);
    await interaction.editReply({ embeds: [embed], components: [mainMenuRow()] }).catch(() => {});
    return;
  }

  if (interaction.commandName === 'profile') {
    await interaction.editReply({ embeds: [view.profileEmbed(profile)] }).catch(() => {});
    return;
  }

  if (interaction.commandName === 'hunt') {
    const zones = hunt.availableZones(profile);
    if (!zones.length) {
      await interaction.editReply({ content: 'Пока нет доступных зон.' }).catch(() => {});
      return;
    }
    const requested = interaction.options.getString('zone');
    const zone = requested ? hunt.zoneById(requested) : null;
    if (zone) {
      await doHuntForCommand(interaction, profile, zone.id);
    } else {
      const zoneList = zones.map(z => `${z.emoji} **${z.id}** — ${z.name} (ур. ${z.minLevel}+)`).join('\n');
      await interaction.editReply({ content: `Укажи зону: \`/hunt зона\`\nДоступно:\n${zoneList}` }).catch(() => {});
    }
    return;
  }
}

async function doHuntForCommand(interaction, profile, zoneId) {
  if (hunt.isOnCooldown(profile)) {
    await interaction.editReply({ content: `⏳ Охота на перезарядке, подожди ${hunt.cooldownLeft(profile)} с.` }).catch(() => {});
    return;
  }
  const result = hunt.hunt(profile, zoneId);
  if (!result.ok) {
    await interaction.editReply({ content: '❌ Ошибка охоты, попробуй ещё раз.' }).catch(() => {});
    return;
  }
  await players.saveProfile(profile);
  await interaction.editReply({ embeds: [view.battleResultEmbed(result, profile)] }).catch(() => {});
}

// ===== Кнопки =====

async function handleComponent(interaction) {
  const raw = String(interaction.customId || '').slice(PREFIX.length);
  if (!raw) return;

  const [action, arg1, arg2] = raw.split(':');
  const user = {
    id: interaction.user.id,
    username: interaction.user.username,
    displayName: interaction.member?.displayName,
  };
  const profile = await players.getProfile(user, interaction.guildId);

  switch (action) {
    case 'menu': {
      menuState.set(profile.userId, { view: 'menu' });
      await showMainMenu(interaction, profile, true);
      return;
    }
    case 'profile':
      menuState.set(profile.userId, { view: 'profile' });
      await interaction.update({ embeds: [view.profileEmbed(profile)], components: [mainMenuRow()] }).catch(() => {});
      return;
    case 'bag': {
      const page = Number.isInteger(parseInt(arg1, 10)) ? parseInt(arg1, 10) : 0;
      menuState.set(profile.userId, { view: 'bag', page });
      await showBag(interaction, profile, page);
      return;
    }
    case 'item': {
      if (arg1 && arg2) return handleItemAction(interaction, profile, arg1, arg2);
      return showItem(interaction, profile, arg1);
    }
    case 'selljunk':
      return handleItemAction(interaction, profile, null, 'selljunk');
    case 'hunt':
      return doHunt(interaction, profile, arg1);
    case 'hunt-menu':
      return showHunt(interaction, profile);
    case 'zone': {
      if (!arg1) return showHunt(interaction, profile);
      if (hunt.isOnCooldown(profile)) {
        return interaction.reply({ content: `⏳ Перезарядка: ещё ${hunt.cooldownLeft(profile)} с.`, ephemeral: true }).catch(() => {});
      }
      return doHunt(interaction, profile, arg1);
    }
    case 'chests':
      return showChests(interaction, profile);
    case 'open':
      return openChest(interaction, profile, arg1);
    case 'top':
      return showTop(interaction, profile);
    default:
      return;
  }
}

class RpgGame {
  constructor(config) {
    this.config = config;
  }

  async init() {
    players.init(this.config);
    console.log('🎲 RPG module ready');
  }

  async handleCommand(interaction) {
    try {
      await handleCommand(interaction);
    } catch (err) {
      console.error('RPG command error:', err);
      const payload = { content: '❌ RPG: что-то сломалось, глянь логи.', ephemeral: true };
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }
  }

  async handleComponent(interaction) {
    try {
      await handleComponent(interaction);
    } catch (err) {
      console.error('RPG component error:', err);
      const payload = { content: '❌ RPG: что-то сломалось, глянь логи.', ephemeral: true };
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }
  }
}

module.exports = { RpgGame, commandData };







