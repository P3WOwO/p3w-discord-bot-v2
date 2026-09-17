// RPG-модуль: команды, кнопочное меню, роутинг взаимодействий.
const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const { stats: cfg, rarities, itemBases, chests: chestCfg } = require('./data');
const items = require('./items');
const players = require('./players');
const hunt = require('./hunt');
const inventory = require('./inventory');
const chests = require('./chests');
const dungeons = require('./dungeons');
const pvp = require('./pvp');
const pets = require('./pets');
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

function mainMenuRow2() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PREFIX + 'dungeons').setLabel('🐉 Данжи').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(PREFIX + 'pvp-menu').setLabel('🗡 PvP').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(PREFIX + 'pets').setLabel('🐾 Питомцы').setStyle(ButtonStyle.Success),
  );
}

function fullMenuComponents() {
  return [mainMenuRow(), mainMenuRow2()];
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
    console.error(`RPG hunt failed: reason=${result.reason}, zone=${zoneId}, playerLevel=${profile.level}`);
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
    new SlashCommandBuilder().setName('rpg').setDescription('Меню RPG: профиль, охота, сундуки, данжи, топ').toJSON(),
    new SlashCommandBuilder()
      .setName('hunt')
      .setDescription('Быстрая охота в выбранной зоне')
      .addStringOption(option => option.setName('zone').setDescription('Зона (см. /rpg → Охота)').setRequired(false))
      .toJSON(),
    new SlashCommandBuilder().setName('profile').setDescription('Показать свой RPG-профиль').toJSON(),
    new SlashCommandBuilder().setName('dungeon').setDescription('Меню данжей: волны мобов + босс').toJSON(),
    new SlashCommandBuilder()
      .setName('pvp')
      .setDescription('Вызвать игрока на дуэль (PvP с рейтингом)')
      .addUserOption(option => option.setName('opponent').setDescription('Противник').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('give')
      .setDescription('[Админ] Выдать/забрать опыт, монеты и т.д.')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addUserOption(option => option.setName('user').setDescription('Кому').setRequired(true))
      .addStringOption(option =>
        option.setName('type')
          .setDescription('Что выдать')
          .setRequired(true)
          .addChoices(
            { name: '🪙 Монеты', value: 'coins' },
            { name: '🗝 Ключи', value: 'keys' },
            { name: '📗 Опыт', value: 'xp' },
            { name: '⬆️ Уровни', value: 'levels' },
            { name: '🗡 Рейтинг', value: 'rating' },
          ))
      .addIntegerOption(option => option.setName('amount').setDescription('Количество (отрицательное = забрать)').setRequired(true))
      .toJSON(),
  ];
}

// ===== Админ-выдача =====

async function handleGive(interaction, bot) {
  try {
    // Права: только админы + только домашний сервер (если задан GUILD_ID).
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.editReply({ content: '❌ Только для админов.' }).catch(() => {});
    }
    if (bot?.config?.GUILD_ID && interaction.guildId !== bot.config.GUILD_ID) {
      return interaction.editReply({ content: '❌ Команда работает только на домашнем сервере.' }).catch(() => {});
    }

    const target = interaction.options.getUser('user', true);
    const type = interaction.options.getString('type', true);
    const amount = interaction.options.getInteger('amount', true);
    if (amount === 0) return interaction.editReply({ content: '❌ amount = 0 — и что я должен сделать?' }).catch(() => {});
    if (Math.abs(amount) > 1_000_000) return interaction.editReply({ content: '❌ Слишком жирно, максимум ±1 000 000.' }).catch(() => {});

    console.log(`🎲 /give: ${interaction.user.username} → ${target.username}, ${type} ${amount}`);

    const targetProfile = await players.getProfile({
      id: target.id,
      username: target.username,
      displayName: interaction.options.getMember('user')?.displayName || target.username,
    }, interaction.guildId);

  const before = { gold: targetProfile.gold, keys: targetProfile.keys, level: targetProfile.level, rating: targetProfile.rating };
  const names = { coins: '🪙 монеты', keys: '🗝 ключи', xp: '📗 опыт', levels: '⬆️ уровни', rating: '🗡 рейтинг' };

  let levelUps = 0;

  if (type === 'coins') {
    targetProfile.gold = Math.max(0, targetProfile.gold + amount);
  } else if (type === 'keys') {
    targetProfile.keys = Math.max(0, (targetProfile.keys || 0) + amount);
  } else if (type === 'xp') {
    if (amount > 0) levelUps = players.addXp(targetProfile, amount);
    else targetProfile.xp = Math.max(0, targetProfile.xp + amount);
  } else if (type === 'levels') {
    const maxLevel = cfg.levelCurve?.maxLevel || 50;
    if (amount > 0) {
      // Выдаём уровни через XP — чтобы статы росли честно по кривой.
      let cumXp = 0;
      for (let lvl = targetProfile.level; lvl < Math.min(maxLevel, targetProfile.level + amount); lvl++) {
        cumXp += players.xpForLevel(lvl);
      }
      levelUps = players.addXp(targetProfile, cumXp);
    } else {
      const newLevel = Math.max(1, targetProfile.level + amount);
      const delta = newLevel - targetProfile.level;
      targetProfile.level = newLevel;
      targetProfile.xp = 0;
      const growth = cfg.levelStats || { hp: 14, atk: 1.4, def: 0.8, spd: 0.35 };
      for (const [stat, value] of Object.entries(growth)) {
        targetProfile.stats[stat] = Math.round(((targetProfile.stats[stat] || 0) + value * delta) * 10) / 10;
      }
    }
  } else if (type === 'rating') {
    targetProfile.rating = Math.max(100, (targetProfile.rating || 1000) + amount);
  } else {
    return interaction.editReply({ content: '❌ Неизвестный тип.' }).catch(() => {});
  }

  await players.saveProfile(targetProfile);

  const changes = [];
  if (type === 'coins') changes.push(`🪙 ${before.gold} → ${targetProfile.gold}`);
  if (type === 'keys') changes.push(`🗝 ${before.keys} → ${targetProfile.keys}`);
  if (type === 'xp') changes.push(`📗 +${amount} XP${levelUps ? ` (уровней поднято: ${levelUps}, теперь ${targetProfile.level})` : ''}`);
  if (type === 'levels') changes.push(`⬆️ ${before.level} → ${targetProfile.level}`);
  if (type === 'rating') changes.push(`🗡 ${before.rating} → ${targetProfile.rating}`);

  const sign = amount > 0 ? 'выдал' : 'забрал';
  const embed = new EmbedBuilder()
    .setColor(amount > 0 ? 0x57f287 : 0xed4245)
    .setTitle(`⚖️ ${sign} ${names[type]} (${amount > 0 ? '+' : ''}${amount})`)
    .setDescription(`Для **${targetProfile.name}**`)
    .addFields({ name: 'Изменения', value: changes.join('\n') })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] }).catch(() => {});
  } catch (err) {
    console.error('RPG /give error:', err);
    await interaction.editReply({ content: `❌ /give сломался: ${String(err?.message || err).slice(0, 300)}` }).catch(() => {});
  }
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
    await interaction.editReply({ embeds: [embed], components: fullMenuComponents() }).catch(() => {});
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
  if (interaction.commandName === 'give') {
    return handleGive(interaction, bot);
  }

  if (interaction.commandName === 'dungeon') {
    await interaction.editReply({ content: 'Выбери данж через кнопки ниже 👇' }).catch(() => {});
    // Показываем меню данжей: reply уже есть, эмулируем через отдельное ephemeral-сообщение.
    const dungeonInteraction = {
      user: interaction.user,
      member: interaction.member,
      guildId: interaction.guildId,
      customId: PREFIX + 'dungeons',
      update: async (payload) => {
        await interaction.followUp({ ...payload, ephemeral: true }).catch(() => {});
      },
      reply: async (payload) => {
        await interaction.followUp({ ...payload, ephemeral: true }).catch(() => {});
      },
    };
    await showDungeons(dungeonInteraction, profile);
    return;
  }

  if (interaction.commandName === 'pvp') {
    const opponent = interaction.options.getUser('opponent', true);
    if (opponent.id === interaction.user.id) {
      await interaction.editReply({ content: '❌ С собой драться нечестно. Используй /rpg → 🗡 PvP → спарринг.' }).catch(() => {});
      return;
    }
    if (opponent.bot) {
      await interaction.editReply({ content: '❌ Боты не дерутся, у них нет прокачки.' }).catch(() => {});
      return;
    }

    const defenderProfile = await players.getProfile({
      id: opponent.id,
      username: opponent.username,
      displayName: interaction.options.getMember('opponent')?.displayName || opponent.username,
    }, interaction.guildId);

    await pvpDuel(interaction, profile, opponent, defenderProfile);
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

// ===== Данжи =====

async function showDungeons(interaction, profile) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(PREFIX + 'dungeon')
    .setPlaceholder('Выбери данж для зачистки')
    .addOptions((require('./data').dungeons.dungeons || []).map(d => ({
      label: d.name,
      description: `ур.${d.minLevel}+ • волн ${d.waves}+босс • ${d.currency === 'gold' ? d.entryCost + '🪙' : d.entryCost + '🗝'}`,
      value: d.id,
      emoji: d.emoji,
    })));
  const rows = [
    new ActionRowBuilder().addComponents(select),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(PREFIX + 'menu').setLabel('🏠 Меню').setStyle(ButtonStyle.Primary),
    ),
  ];
  const embed = view.dungeonsListEmbed(profile);
  if (dungeons.isOnCooldown(profile)) {
    embed.setFooter({ text: `⏳ Перезарядка данжей: ещё ${dungeons.cooldownLeft(profile)} с` });
  }
  await interaction.update({ embeds: [embed], components: rows }).catch(() => {});
}

async function runDungeon(interaction, profile, dungeonId) {
  const dungeon = dungeons.dungeonById(dungeonId);
  if (!dungeon) return interaction.reply({ content: '❌ Данж не найден.', ephemeral: true }).catch(() => {});

  if (profile.level < (dungeon.minLevel || 1)) {
    return interaction.reply({ content: `❌ Нужен уровень ${dungeon.minLevel}.`, ephemeral: true }).catch(() => {});
  }
  if (dungeons.isOnCooldown(profile)) {
    return interaction.reply({ content: `⏳ Данжи на перезарядке, подожди ${dungeons.cooldownLeft(profile)} с.`, ephemeral: true }).catch(() => {});
  }

  const result = dungeons.run(profile, dungeonId);
  if (!result.ok) {
    const messages = {
      no_gold: `Не хватает монет на вход: нужно ${result.cost} 🪙`,
      no_keys: `Не хватает ключей на вход: нужно ${result.cost} 🗝`,
      gen: 'Ошибка генерации данжа.',
    };
    console.error(`RPG dungeon failed: reason=${result.reason}, dungeon=${dungeonId}`);
    return interaction.reply({ content: `❌ ${messages[result.reason] || 'Ошибка данжа, попробуй ещё раз.'}`, ephemeral: true }).catch(() => {});
  }

  await players.saveProfile(profile);
  const again = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PREFIX + `dungeon-run:${dungeonId}`).setLabel('🔁 Ещё раз').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(PREFIX + 'dungeons').setLabel('🐉 К данжам').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(PREFIX + 'menu').setLabel('🏠 Меню').setStyle(ButtonStyle.Primary),
  );
  await interaction.update({ embeds: [view.dungeonResultEmbed(result, profile)], components: [again] }).catch(() => {});
}

// ===== PvP =====

async function showPvpMenu(interaction, profile) {
  const pcfg = require('./data').stats.pvp || {};
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🗡 PvP Арена')
    .setDescription(
      `Вызывай игроков на дуэль командой \`/pvp @игрок\` — бой ваших билдов с логом.\n` +
      `Победа даёт монеты и очки рейтинга (Эло), поражение — немного утешительных.\n\n` +
      `Твой рейтинг: **${profile.rating || 1000}** (${profile.pvpWins || 0}П / ${profile.pvpLosses || 0}Пр)\n` +
      `Минимальный уровень для PvP: ${pcfg.minLevel || 5}\n` +
      `Или потренируйся в спарринге с копией себя — без рейтинга.`
    );
  const rows = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PREFIX + 'spar').setLabel('🥊 Спарринг с тенью себя').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(PREFIX + 'menu').setLabel('🏠 Меню').setStyle(ButtonStyle.Primary),
  )];
  await interaction.update({ embeds: [embed], components: rows }).catch(() => {});
}

async function spar(interaction, profile) {
  if (pvp.isOnCooldown(profile)) {
    return interaction.reply({ content: `⏳ Перезарядка PvP: ещё ${pvp.cooldownLeft(profile)} с.`, ephemeral: true }).catch(() => {});
  }
  if ((profile.level || 1) < 3) {
    return interaction.reply({ content: '❌ Спарринг с 3 уровня.', ephemeral: true }).catch(() => {});
  }
  const shadow = { ...profile, name: `🥊 Тень ${profile.name}`, rating: profile.rating };
  const result = pvp.duel(profile, shadow, { sparring: true });
  await players.saveProfile(profile);
  await interaction.update({ embeds: [view.pvpResultEmbed(result, profile, shadow)], components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PREFIX + 'spar').setLabel('🥊 Ещё спарринг').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(PREFIX + 'menu').setLabel('🏠 Меню').setStyle(ButtonStyle.Primary),
  )] }).catch(() => {});
}

async function pvpDuel(interaction, attacker, defenderUser, defenderProfile) {
  const pcfg = require('./data').stats.pvp || {};
  if ((attacker.level || 1) < (pcfg.minLevel || 5) || (defenderProfile.level || 1) < (pcfg.minLevel || 5)) {
    return interaction.editReply({ content: `❌ PvP доступен с ${pcfg.minLevel || 5} уровня у обоих бойцов.` }).catch(() => {});
  }
  if (pvp.isOnCooldown(attacker)) {
    return interaction.editReply({ content: `⏳ Перезарядка PvP: ещё ${pvp.cooldownLeft(attacker)} с.` }).catch(() => {});
  }

  const result = pvp.duel(attacker, defenderProfile);
  await players.saveProfile(attacker);
  await players.saveProfile(defenderProfile);
  await interaction.editReply({
    content: `<@${defenderUser.id}>, тебя вызвали на дуэль!`,
    embeds: [view.pvpResultEmbed(result, attacker, defenderProfile)],
  }).catch(() => {});
}

// ===== Питомцы =====

async function showPets(interaction, profile) {
  const rows = [];
  if ((profile.pets || []).length) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(PREFIX + 'pet')
      .setPlaceholder('Выбери питомца: сделать активным / отпустить')
      .addOptions((profile.pets || []).slice(0, 25).map(p => ({
        label: `${p.name} ур.${p.level}`,
        description: p.uid === profile.activePetId ? 'Сейчас активен' : 'Нажми, чтобы управлять',
        value: p.uid,
        emoji: p.emoji,
      })));
    rows.push(new ActionRowBuilder().addComponents(select));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PREFIX + 'menu').setLabel('🏠 Меню').setStyle(ButtonStyle.Primary),
  ));
  await interaction.update({ embeds: [view.petsEmbed(profile)], components: rows }).catch(() => {});
}

async function showPet(interaction, profile, petUid) {
  const pet = (profile.pets || []).find(p => p.uid === petUid);
  if (!pet) return interaction.reply({ content: '❌ Питомец не найден.', ephemeral: true }).catch(() => {});
  const isActive = pet.uid === profile.activePetId;
  const price = pets.releasePrice(pet);
  const rows = [new ActionRowBuilder().addComponents(
    isActive
      ? new ButtonBuilder().setCustomId(PREFIX + 'pet-unset').setLabel('🔽 Убрать из активных').setStyle(ButtonStyle.Secondary)
      : new ButtonBuilder().setCustomId(PREFIX + `pet-set:${petUid}`).setLabel('✅ Сделать активным').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(PREFIX + `pet-release:${petUid}`).setLabel(`🎁 Отпустить (+${price}🪙)`).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(PREFIX + 'pets').setLabel('🐾 К питомцам').setStyle(ButtonStyle.Secondary),
  )];
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`${pet.emoji} ${pet.name} (ур.${pet.level})${isActive ? ' — активен' : ''}`)
    .setDescription(`Бонус активного питомца: **+${pets.bonusPct(pet).toFixed(1)}%** к HP/атаке/защите/скорости.`)
    .setTimestamp();
  await interaction.reply({ embeds: [embed], components: rows, ephemeral: true }).catch(() => {});
}

async function petAction(interaction, profile, action, petUid) {
  let message = '';
  if (action === 'set') {
    const pet = (profile.pets || []).find(p => p.uid === petUid);
    if (pet) { profile.activePetId = pet.uid; message = `🐾 ${pet.name} теперь твой активный питомец!`; }
    else message = '❌ Питомец не найден.';
  } else if (action === 'unset') {
    profile.activePetId = null;
    message = '🔽 Активный питомец убран.';
  } else if (action === 'release') {
    const pet = (profile.pets || []).find(p => p.uid === petUid);
    if (!pet) message = '❌ Питомец не найден.';
    else {
      const wasActive = profile.activePetId === petUid;
      profile.pets = profile.pets.filter(p => p.uid !== petUid);
      if (wasActive) profile.activePetId = null;
      const price = pets.releasePrice(pet);
      profile.gold += price;
      message = `🎁 Отпустил ${pet.name}. Получил ${price} 🪙.`;
    }
  }
  await players.saveProfile(profile);
  await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
}

// ===== Кнопки =====



// Значение селект-меню (у select'ов выбор лежит в interaction.values, не в customId).
function selectValue(interaction) {
  return Array.isArray(interaction.values) && interaction.values.length ? interaction.values[0] : null;
}

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
      await interaction.update({ embeds: [view.profileEmbed(profile)], components: fullMenuComponents() }).catch(() => {});
      return;
    case 'bag': {
      const page = Number.isInteger(parseInt(arg1, 10)) ? parseInt(arg1, 10) : 0;
      menuState.set(profile.userId, { view: 'bag', page });
      await showBag(interaction, profile, page);
      return;
    }
    case 'item': {
      // rpg:item:<uid>:<action> — кнопки; rpg:item + values[0] — селект-меню сумки.
      if (arg1 && arg2) return handleItemAction(interaction, profile, arg1, arg2);
      const uid = arg1 || selectValue(interaction);
      if (!uid) {
        console.error('RPG item: no uid, customId:', interaction.customId, 'values:', interaction.values);
        return interaction.reply({ content: '❌ Предмет не найден.', ephemeral: true }).catch(() => {});
      }
      return showItem(interaction, profile, uid);
    }
    case 'selljunk':
      return handleItemAction(interaction, profile, null, 'selljunk');
    case 'hunt':
      // rpg:hunt (кнопка в меню) — показать выбор зоны; rpg:hunt:<zone> — бой сразу.
      if (!arg1) return showHunt(interaction, profile);
      return doHunt(interaction, profile, arg1);
    case 'hunt-menu':
      return showHunt(interaction, profile);
    case 'zone': {
      // rpg:zone — селект-меню выбора зоны.
      const zoneId = arg1 || selectValue(interaction);
      if (!zoneId) return showHunt(interaction, profile);
      if (hunt.isOnCooldown(profile)) {
        return interaction.reply({ content: `⏳ Перезарядка: ещё ${hunt.cooldownLeft(profile)} с.`, ephemeral: true }).catch(() => {});
      }
      return doHunt(interaction, profile, zoneId);
    }
    case 'chests':
      return showChests(interaction, profile);
    case 'open':
      return openChest(interaction, profile, arg1);
    case 'dungeons':
      return showDungeons(interaction, profile);
    case 'dungeon': {
      const dungeonId = arg1 || selectValue(interaction);
      if (!dungeonId) return showDungeons(interaction, profile);
      return runDungeon(interaction, profile, dungeonId);
    }
    case 'dungeon-run':
      return runDungeon(interaction, profile, arg1);
    case 'pvp-menu':
      return showPvpMenu(interaction, profile);
    case 'spar':
      return spar(interaction, profile);
    case 'pets':
      return showPets(interaction, profile);
    case 'pet': {
      const petUid = arg1 || selectValue(interaction);
      if (!petUid) return showPets(interaction, profile);
      return showPet(interaction, profile, petUid);
    }
    case 'pet-set':
      return petAction(interaction, profile, 'set', arg1);
    case 'pet-release':
      return petAction(interaction, profile, 'release', arg1);
    case 'pet-unset':
      return petAction(interaction, profile, 'unset', null);
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

  // Награда за время в войсе (вызывается из checkpointVoiceSessions).
  async awardVoiceTime(userId, seconds) {
    try {
      const voice = require('./voice');
      await voice.award(userId, seconds);
    } catch (err) {
      console.error('RPG voice award error:', err?.message || err);
    }
  }

  async handleCommand(interaction) {
    try {
      await handleCommand(interaction, this);
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







