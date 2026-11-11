const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  REST,
  Routes,
  ActivityType,
  ChannelType,
  PermissionFlagsBits,
  AttachmentBuilder,
  Events,
} = require('discord.js');
const { createMusic } = require('./music');
const http = require('http');
const crypto = require('crypto');

const {
  CHECKPOINT_MS,
  PRESENCE_REFRESH_MS,
  STATUS_ROTATE_MS,
  TOP_LIMIT,
  HOME_GUILD_ONLY_REPLY,
  STATUS_VERBS,
  STATUS_NOUNS,
} = require('./constants');

const { pickRandom, formatTime, formatTopTime, clampText, normalizeText, escapeRegExp, splitMessage } = require('./utils');
const {
  askGemini,
  askGeminiWithFallback,
  buildSystemInstruction,
  buildContents,
  buildSummaryPrompt,
  generateImageWithFallback,
} = require('./ai');
const { Moderation, commandData: modCommands } = require('./moderation');
const { buildGameNewsMessage, validateGameNewsPayload } = require('./game-news');

function stripMention(text, botId) {
  return String(text || '').replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
}

function isImageRequest(text) {
  const q = normalizeText(text).toLowerCase();
  return /^(?:сгенерируй|нарисуй|создай|сделай)\b/.test(q) || /^(?:generate|create|draw)\b/.test(q) || /(?:\bарт\b|\bimage\b|\bpicture\b)/.test(q);
}

function normalizeAspectRatio(value) {
  const allowed = new Set(['1:1', '16:9', '9:16', '3:2', '2:3', '4:5', '5:4']);
  const q = normalizeText(value);
  return allowed.has(q) ? q : '16:9';
}

function formatImageError(err) {
  const raw = String(err?.message || err);
  if (raw.includes('429') && /quota/i.test(raw)) {
    return '🖼 Лимит генерации картинок на ключе Gemini исчерпан (429). На бесплатном тарифе он очень маленький и сбрасывается примерно раз в сутки. Варианты: попробовать позже или подключить биллинг / другой ключ (GEMINI_API_KEY).';
  }
  return `❌ Ошибка генерации: ${clampText(raw, 1800)}`;
}

function buildRandomStatus() {
  return `${pickRandom(STATUS_VERBS)} ${pickRandom(STATUS_NOUNS)}`;
}

const { buildChatContext, buildSummarySource } = require('./context');

const ADMIN_COMMANDS = new Set(['msg', 'jtm', 'forget', 'news']);

class DiscordBot {
  constructor(config, stateStore) {
    this.config = config;
    this.stateStore = stateStore;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers,
      ],
    });

    this.activeSessions = new Map();
    this.timers = [];
    this.statusPair = null;
    this.httpServer = null;
    this.mod = new Moderation();
    this.music = createMusic(this.client, this.config);
    this.cooldowns = new Map(); // `\${kind}:\${userId}` -> timestamp
    this.busyChannels = new Set();
  }

  // Возвращает 0, если можно, иначе сколько секунд ждать.
  checkCooldown(kind, userId, ms) {
    const key = `${kind}:${userId}`;
    const now = Date.now();
    const until = this.cooldowns.get(key) || 0;
    if (until > now) return Math.ceil((until - now) / 1000);
    this.cooldowns.set(key, now + ms);
    return 0;
  }

  sweepCooldowns() {
    const now = Date.now();
    for (const [key, until] of this.cooldowns) if (until <= now) this.cooldowns.delete(key);
  }

  isHomeGuild(guildId) {
    if (!this.config.GUILD_ID) return true;
    return guildId === this.config.GUILD_ID;
  }

  isAdmin(memberPermissions) {
    return memberPermissions?.has(PermissionFlagsBits.Administrator);
  }

  getKey(guildId, userId) {
    return `${guildId}:${userId}`;
  }

  // ===== Статусы (случайный глагол + существительное, смена раз в час) =====

  ensureStatusPair() {
    if (!this.statusPair) this.statusPair = buildRandomStatus();
    return this.statusPair;
  }

  buildPresenceActivity() {
    return {
      name: 'p3w',
      type: ActivityType.Custom,
      state: this.ensureStatusPair(),
    };
  }

  async applyPresence() {
    if (!this.client.user) return;
    this.client.user.setPresence({
      status: 'dnd',
      activities: [this.buildPresenceActivity()],
    });
  }

  async refreshPresence() {
    try {
      await this.applyPresence();
    } catch (e) {
      console.error('Presence error:', e);
    }
  }

  async rotateStatus() {
    this.statusPair = buildRandomStatus();
    await this.refreshPresence();
  }

  // ===== Войс-сессии =====

  startVoiceSession(guildId, userId) {
    const key = this.getKey(guildId, userId);
    if (!this.activeSessions.has(key)) this.activeSessions.set(key, Date.now());
  }

  endVoiceSession(guildId, userId) {
    const key = this.getKey(guildId, userId);
    const startedAt = this.activeSessions.get(key);
    if (!startedAt) return;
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    if (secs > 0) this.stateStore.addVoiceSeconds(guildId, userId, secs);
    this.activeSessions.delete(key);
  }

  async checkpointVoiceSessions(force = false) {
    const now = Date.now();
    let changed = false;

    for (const [key, startedAt] of this.activeSessions.entries()) {
      const elapsed = Math.floor((now - startedAt) / 1000);
      if (elapsed > 0 && (force || elapsed >= 60)) {
        const [guildId, userId] = key.split(':');
        this.stateStore.addVoiceSeconds(guildId, userId, elapsed);
        this.activeSessions.set(key, now);
        changed = true;
      }
    }

    if (changed || force) {
      return this.stateStore.save();
    }
    return Promise.resolve();
  }

  async restoreCurrentVoiceSessions() {
    if (!this.config.GUILD_ID) return;
    const guild = this.client.guilds.cache.get(this.config.GUILD_ID) || await this.client.guilds.fetch(this.config.GUILD_ID).catch(() => null);
    if (!guild) return;

    this.activeSessions.clear();
    for (const [userId, voiceState] of guild.voiceStates.cache) {
      if (voiceState.channelId && userId !== this.client.user?.id) {
        this.startVoiceSession(this.config.GUILD_ID, userId);
      }
    }
  }

  // ===== Утилиты чата =====

  async getRecentMessages(channel, limit = 8) {
    const messages = await channel.messages.fetch({ limit }).catch(() => null);
    if (!messages) return [];
    return [...messages.values()]
      .reverse()
      .filter(msg => msg.content && !msg.author?.bot)
      .map(msg => ({
        role: msg.author?.bot ? 'assistant' : 'user',
        name: msg.member?.displayName || msg.author?.username || 'user',
        text: msg.content,
      }))
      .slice(-limit);
  }

  async registerCommands() {
    const adminOnly = PermissionFlagsBits.Administrator;

    const commands = [
      new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Проверить задержку бота')
        .toJSON(),
      new SlashCommandBuilder()
        .setName('say')
        .setDescription('Попросить бота ответить через Gemini')
        .addStringOption(option => option.setName('text').setDescription('Текст сообщения').setRequired(true))
        .toJSON(),
      new SlashCommandBuilder()
        .setName('image')
        .setDescription('Сгенерировать картинку через Gemini')
        .addStringOption(option => option.setName('text').setDescription('Что нарисовать').setRequired(true))
        .addStringOption(option => option.setName('ratio').setDescription('Соотношение сторон').setRequired(false))
        .toJSON(),
      ...this.music.commandsJSON,
      new SlashCommandBuilder()
        .setName('time')
        .setDescription('Показать время в войсе')
        .addUserOption(option => option.setName('user').setDescription('Кого проверить'))
        .toJSON(),
      new SlashCommandBuilder()
        .setName('user')
        .setDescription('Показать время в войсе')
        .addUserOption(option => option.setName('user').setDescription('Кого проверить'))
        .toJSON(),
      new SlashCommandBuilder()
        .setName('top')
        .setDescription('Топ по времени в войсе')
        .toJSON(),
      new SlashCommandBuilder()
        .setName('life')
        .setDescription('Показать жизнь бота')
        .toJSON(),
      new SlashCommandBuilder()
        .setName('msg')
        .setDescription('Отправить сообщение от имени бота')
        .setDefaultMemberPermissions(adminOnly)
        .addChannelOption(option => option.setName('channel').setDescription('Канал').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
        .addStringOption(option => option.setName('message').setDescription('Текст').setRequired(true))
        .toJSON(),
      new SlashCommandBuilder()
        .setName('jtm')
        .setDescription('Зайти в твой войс')
        .setDefaultMemberPermissions(adminOnly)
        .toJSON(),
      new SlashCommandBuilder()
        .setName('forget')
        .setDescription('Очистить чат-память бота в этом канале')
        .setDefaultMemberPermissions(adminOnly)
        .toJSON(),
      new SlashCommandBuilder()
        .setName('news')
        .setDescription('Настроить игровые новости P3W')
        .setDefaultMemberPermissions(adminOnly)
        .addSubcommand(subcommand => subcommand
          .setName('channel')
          .setDescription('Выбрать канал для игровых новостей')
          .addChannelOption(option => option
            .setName('target')
            .setDescription('Канал, куда публиковать новости')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true)))
        .addSubcommand(subcommand => subcommand
          .setName('status')
          .setDescription('Показать текущую настройку'))
        .addSubcommand(subcommand => subcommand
          .setName('test')
          .setDescription('Отправить тестовое уведомление'))
        .addSubcommand(subcommand => subcommand
          .setName('disable')
          .setDescription('Отключить игровые новости'))
        .toJSON(),
      ...modCommands(),
    ];

    const rest = new REST({ version: '10' }).setToken(this.config.TOKEN);
    let guildRegistered = 0;
    let globalRegistered = 0;

    // Guild commands become available immediately; global registration is synced too.
    if (this.config.GUILD_ID) {
      const guildResult = await rest.put(
        Routes.applicationGuildCommands(this.config.CLIENT_ID, this.config.GUILD_ID),
        { body: commands },
      );
      guildRegistered = Array.isArray(guildResult) ? guildResult.length : commands.length;
      console.log(`✅ Registered ${guildRegistered} guild slash commands for ${this.config.GUILD_ID}`);

      try {
        const globalResult = await rest.put(
          Routes.applicationCommands(this.config.CLIENT_ID),
          { body: commands },
        );
        globalRegistered = Array.isArray(globalResult) ? globalResult.length : commands.length;
        console.log(`✅ Registered ${globalRegistered} global slash commands`);
      } catch (err) {
        console.error('Global slash command sync failed (guild sync succeeded):', err);
      }
    } else {
      const globalResult = await rest.put(
        Routes.applicationCommands(this.config.CLIENT_ID),
        { body: commands },
      );
      globalRegistered = Array.isArray(globalResult) ? globalResult.length : commands.length;
      console.log(`✅ Registered ${globalRegistered} global slash commands`);
    }

    return { count: commands.length, guildRegistered, globalRegistered };
  }

  async buildTopEmbed(guild) {
    const allEntries = Object.entries(this.stateStore.getVoiceTimes());
    const items = allEntries
      .filter(([key]) => key.startsWith(`${guild.id}:`))
      .map(([key, seconds]) => ({ key, seconds: Number(seconds || 0) }))
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, TOP_LIMIT);

    const lines = [];
    for (const [index, item] of items.entries()) {
      const userId = item.key.split(':')[1];
      const member = await guild.members.fetch(userId).catch(() => null);
      const name = member?.displayName || member?.user?.username || userId;
      lines.push(`**${index + 1}.** ${name} — ${formatTopTime(item.seconds)}`);
    }

    const emptyDescription = allEntries.length
      ? `На этом сервере записей нет (всего в базе: ${allEntries.length})`
      : 'База пустая — бот не загрузил данные из Supabase, глянь логи Render (строка с Supabase)';

    return new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🏆 Топ по войсу')
      .setDescription(lines.join('\n') || emptyDescription)
      .setTimestamp();
  }

  buildLifeEmbed() {
    const lifeState = this.stateStore.getLifeState();
    const seconds = lifeState.startedAt
      ? Math.max(0, Math.floor((Date.now() - lifeState.startedAt) / 1000))
      : 0;

    return new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('🫧 Жизнь бота')
      .addFields(
        { name: 'Аптайм', value: formatTime(seconds), inline: true },
        { name: 'Старт', value: lifeState.startedAt ? `<t:${Math.floor(lifeState.startedAt / 1000)}:F>` : '—', inline: true },
        { name: 'Чем занят', value: this.buildPresenceActivity().state, inline: false },
      )
      .setTimestamp();
  }

  // ===== Чат с ИИ =====

  async generateChatReply({ channel, userName, text }) {
    const channelName = channel?.name || '';
    const ctx = this.stateStore.getChannelContext(channel.id);

    // Страховка: если память канала пуста, берём свежие сообщения из Discord.
    let turns = ctx.turns;
    if (!turns.length) {
      turns = (await this.getRecentMessages(channel, 10)).map(t => ({ role: t.role, name: t.name, text: clampText(t.text, 500) }));
    }

    const answer = await askGeminiWithFallback({
      apiKey: this.config.GEMINI_API_KEY,
      models: this.config.GEMINI_CHAT_MODELS,
      systemInstruction: buildSystemInstruction({ basePrompt: this.config.BASE_PROMPT, summary: ctx.summary, channelName }),
      prompt: buildContents({ turns, userName, text }),
    });

    return { answer, channelName };
  }

  // Общая часть для текстовых и slash-запросов: ответ + запись в память + выжимка.
  async rememberExchange(channel, userName, text, answer) {
    this.stateStore.appendChannelTurn(channel.id, { role: 'user', name: userName, text });
    this.stateStore.appendChannelTurn(channel.id, { role: 'assistant', name: this.client.user?.username || 'Bot', text: answer });
    await this.maybeSummarizeChannel(channel.id, channel?.name || '');
    await this.stateStore.save();
  }

  // Авто-выжимка старых сообщений: дешёвый вызов Gemini раз в N сообщений.
  async maybeSummarizeChannel(channelId, channelName = '') {
    if (!this.config.GEMINI_API_KEY) return;
    if (!this.stateStore.shouldSummarizeChannel(channelId, this.config.CONTEXT_SUMMARY_EVERY)) return;

    const ctx = this.stateStore.getChannelContext(channelId);
    const oldMessages = buildSummarySource(ctx);
    if (!oldMessages) {
      ctx.turnsSinceSummary = 0;
      this.stateStore.setChannelContext(channelId, ctx);
      return;
    }

    try {
      const raw = await askGeminiWithFallback({
        apiKey: this.config.GEMINI_API_KEY,
        models: this.config.GEMINI_CHAT_MODELS,
        prompt: buildSummaryPrompt({ existingSummary: ctx.summary, oldMessages }),
        temperature: 0.2,
        maxOutputTokens: 500,
        retries: 1,
      });
      const summary = clampText(String(raw || '').trim(), 1800);
      this.stateStore.applyChannelSummary(channelId, summary || ctx.summary);
    } catch (err) {
      console.error('Context summary failed:', err?.message || err);
    }
  }
  async handleAiMessage({ message, text }) {
    if (!this.config.GEMINI_API_KEY) {
      return message.reply('⚠️ Gemini пока не подключён.');
    }

    const wait = this.checkCooldown('ai', message.author.id, this.config.AI_USER_COOLDOWN_MS);
    if (wait) return message.react('⏳').catch(() => {});

    const userName = message.member?.displayName || message.author.username;
    const status = await message.reply({ content: '💭 Думаю...', allowedMentions: { repliedUser: false } });
    await message.channel.sendTyping().catch(() => {});

    try {
      const { answer } = await this.generateChatReply({ channel: message.channel, userName, text });
      const parts = splitMessage(String(answer || ''), 1900);
      await status.edit({ content: parts[0] || '…', allowedMentions: { parse: [] } }).catch(() => {});
      for (const extra of parts.slice(1, 3)) {
        await message.channel.send({ content: extra, allowedMentions: { parse: [] } }).catch(() => {});
      }
      await this.rememberExchange(message.channel, userName, text, clampText(parts.join('\n'), 1900));
    } catch (err) {
      console.error('Gemini error:', err);
      await status.edit('❌ Gemini сейчас перегружен или ответ не прошёл.').catch(() => {});
    }
  }

  async handleSlashAi(interaction, text) {
    if (!this.config.GEMINI_API_KEY) {
      return interaction.reply({ content: '⚠️ Gemini пока не подключён.', ephemeral: true });
    }
    const wait = this.checkCooldown('ai', interaction.user.id, this.config.AI_USER_COOLDOWN_MS);
    if (wait) return interaction.reply({ content: `⏳ Подожди ${wait}с.`, ephemeral: true });

    await interaction.deferReply();
    const userName = interaction.member?.displayName || interaction.user.username;

    try {
      const { answer } = await this.generateChatReply({ channel: interaction.channel, userName, text });
      const parts = splitMessage(String(answer || ''), 1900);
      await interaction.editReply({ content: parts[0] || '…', allowedMentions: { parse: [] } });
      for (const extra of parts.slice(1, 3)) {
        await interaction.followUp({ content: extra, allowedMentions: { parse: [] } }).catch(() => {});
      }
      await this.rememberExchange(interaction.channel, userName, text, clampText(parts.join('\n'), 1900));
    } catch (err) {
      console.error('Gemini slash error:', err);
      await interaction.editReply({ content: '❌ Gemini сейчас перегружен или ответ не прошёл.' });
    }
  }

  async handleImageRequest({ message, text, ratio }) {
    if (!this.config.GEMINI_API_KEY) {
      return message.reply('⚠️ Gemini пока не подключён.');
    }

    const prompt = String(text || '').trim();
    if (!prompt) return message.reply('Напиши, что именно рисовать.');
    const wait = this.checkCooldown('image', message.author.id, this.config.IMAGE_USER_COOLDOWN_MS);
    if (wait) return message.reply({ content: `⏳ Картинки не чаще раза в ${Math.round(this.config.IMAGE_USER_COOLDOWN_MS / 1000)}с, подожди ${wait}с.`, allowedMentions: { repliedUser: false } });

    const status = await message.reply('🖼 Генерирую изображение...');
    await message.channel.sendTyping().catch(() => {});

    try {
      const result = await generateImageWithFallback({
        apiKey: this.config.GEMINI_API_KEY,
        models: this.config.GEMINI_IMAGE_MODELS,
        prompt,
        aspectRatio: normalizeAspectRatio(ratio),
      });

      const attachment = new AttachmentBuilder(result.buffer, { name: 'image.png' });
      await status.delete().catch(() => {});
      return message.reply({
        content: `✅ Готово${result.model ? ` • ${result.model}` : ''}`,
        files: [attachment],
        allowedMentions: { repliedUser: false },
      });
    } catch (err) {
      console.error('Image generation error:', err);
      await status.edit(formatImageError(err)).catch(() => {});
    }
  }

  async handleVoiceTime(interaction, targetUser) {
    const target = targetUser || interaction.user;
    const total = this.stateStore.getVoiceTimeSeconds(interaction.guild.id, target.id);
    const member = await interaction.guild.members.fetch(target.id).catch(() => null);
    const name = member?.displayName || target.username;

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setAuthor({ name, iconURL: target.displayAvatarURL({ size: 256 }) })
      .setTitle('⏱ Время в войсе')
      .setDescription(`**Всего:** ${formatTime(total)}`)
      .setFooter({ text: `ID: ${target.id}` })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }


  async handleNewsCommand(interaction) {
    const guildId = interaction.guildId;
    const action = interaction.options.getSubcommand();
    const settings = this.stateStore.getGameNewsSettings(guildId);
    const fallbackChannelId = this.config.GAME_NEWS_CHANNEL_ID || '';
    const selectedChannelId = settings.channelId || fallbackChannelId;
    const newsEnabled = settings.channelId ? settings.enabled : Boolean(fallbackChannelId);

    if (action === 'channel') {
      const channel = interaction.options.getChannel('target', true);
      if (channel.guildId !== guildId) {
        return interaction.reply({ content: '❌ Можно выбрать только канал этого сервера.', ephemeral: true });
      }

      const permissions = channel.permissionsFor(this.client.user);
      const required = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
      ];
      if (!permissions?.has(required)) {
        return interaction.reply({
          content: '❌ У P3W нет прав просматривать канал, отправлять сообщения или встраивать ссылки.',
          ephemeral: true,
        });
      }

      this.stateStore.setGameNewsChannel(guildId, channel.id);
      await this.stateStore.save();
      return interaction.reply({
        content: '✅ Игровые новости будут публиковаться в ' + channel + '. Настройка сохранена.',
        ephemeral: true,
      });
    }

    if (action === 'status') {
      if (!selectedChannelId) {
        return interaction.reply({ content: 'ℹ️ Канал для игровых новостей ещё не выбран. Используй /news channel.', ephemeral: true });
      }
      const channel = await interaction.guild.channels.fetch(selectedChannelId).catch(() => null);
      const destination = channel ? String(channel) : 'канал удалён или недоступен (' + selectedChannelId + ')';
      return interaction.reply({
        content: '**Игровые новости:** ' + (newsEnabled ? 'включены' : 'отключены') + '\n**Канал:** ' + destination,
        ephemeral: true,
      });
    }

    if (action === 'disable') {
      if (!settings.channelId && fallbackChannelId) this.stateStore.setGameNewsChannel(guildId, fallbackChannelId);
      this.stateStore.disableGameNews(guildId);
      await this.stateStore.save();
      return interaction.reply({ content: '⏸️ Публикация игровых новостей отключена. Канал сохранён — включить снова можно через /news channel.', ephemeral: true });
    }

    if (action === 'test') {
      if (!newsEnabled || !selectedChannelId) {
        return interaction.reply({ content: '❌ Сначала выбери канал через /news channel.', ephemeral: true });
      }
      const channel = await interaction.guild.channels.fetch(selectedChannelId).catch(() => null);
      if (!channel || typeof channel.send !== 'function') {
        return interaction.reply({ content: '❌ Сохранённый канал недоступен. Выбери его заново через /news channel.', ephemeral: true });
      }
      try {
        const newsMessage = await buildGameNewsMessage({
          title: 'Тестовое уведомление P3W',
          description: 'Настройка работает. Здесь будут появляться игровые скидки и бесплатные раздачи.',
          url: 'https://store.steampowered.com/',
          source: 'P3W · Проверка',
        });
        await channel.send(newsMessage);
        return interaction.reply({ content: '✅ Тестовое сообщение отправлено в ' + channel + '.', ephemeral: true });
      } catch (err) {
        console.error('Game news test failed:', err);
        return interaction.reply({ content: '❌ Не удалось отправить тест. Проверь права P3W в выбранном канале.', ephemeral: true });
      }
    }
  }

  async publishGameNews(guildId, rawPayload) {
    const payload = validateGameNewsPayload(rawPayload);
    const settings = this.stateStore.getGameNewsSettings(guildId);
    const selectedChannelId = settings.channelId || this.config.GAME_NEWS_CHANNEL_ID || '';
    const newsEnabled = settings.channelId ? settings.enabled : Boolean(this.config.GAME_NEWS_CHANNEL_ID);
    if (!newsEnabled || !selectedChannelId) {
      throw Object.assign(new Error('Для этого сервера не выбран активный канал новостей.'), { statusCode: 409 });
    }
    if (this.stateStore.hasGameNewsSent(guildId, payload.id)) {
      return { duplicate: true, message: 'Это уведомление уже отправлялось.' };
    }

    const guild = this.client.guilds.cache.get(guildId)
      || await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) throw Object.assign(new Error('Сервер не найден или бот не имеет к нему доступа.'), { statusCode: 404 });

    const channel = await guild.channels.fetch(selectedChannelId).catch(() => null);
    if (!channel || typeof channel.send !== 'function') {
      throw Object.assign(new Error('Выбранный канал недоступен. Настрой его заново командой /news channel.'), { statusCode: 404 });
    }

    const roleNameByCategory = {
      news: 'News',
      sales: 'Sales',
      free: 'Free',
    };
    const targetRoleName = roleNameByCategory[payload.category];
    const guildRoles = await guild.roles.fetch().catch(() => null);
    if (!guildRoles) {
      throw Object.assign(new Error('Не удалось получить список ролей сервера для игровых уведомлений.'), { statusCode: 502 });
    }
    const targetRole = guildRoles.find(role => role.name.trim().toLowerCase() === targetRoleName.toLowerCase());
    if (!targetRole) {
      throw Object.assign(new Error('На сервере не найдена роль @' + targetRoleName + '. Проверь точное название роли.'), { statusCode: 409 });
    }

    const permissions = channel.permissionsFor(this.client.user);
    const required = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ];
    if (!permissions?.has(required)) {
      throw Object.assign(new Error('У P3W недостаточно прав в выбранном канале.'), { statusCode: 403 });
    }
    if (!targetRole.mentionable && !permissions.has(PermissionFlagsBits.MentionEveryone)) {
      throw Object.assign(
        new Error('Роль @' + targetRoleName + ' нельзя упоминать. Включи для неё «Разрешить упоминать эту роль» или выдай P3W право Mention Everyone.'),
        { statusCode: 403 },
      );
    }

    const messageOptions = await buildGameNewsMessage(payload);
    // Explicitly allow only this one role mention. Everyone, users and all other roles stay suppressed.
    messageOptions.content = targetRole.toString();
    messageOptions.allowedMentions = {
      parse: [],
      roles: [targetRole.id],
      repliedUser: false,
    };

    const sentMessage = await channel.send(messageOptions);
    const message = await sentMessage.fetch();
    const rolePinged = message.mentions.roles.has(targetRole.id);
    const imageEmbed = message.embeds.some(embed =>
      /^https:\/\//i.test(String(embed.image?.url || '')),
    );

    console.info('Game news delivery verification:', JSON.stringify({
      messageId: message.id,
      category: payload.category,
      roleName: targetRole.name,
      roleId: targetRole.id,
      rolePinged,
      requestedImage: Boolean(payload.imageUrl),
      imageEmbedUrls: message.embeds.map(embed => embed.image?.url || null).filter(Boolean),
      imageEmbed,
    }));

    if (!rolePinged) {
      throw Object.assign(
        new Error('Сообщение отправлено, но Discord не подтвердил упоминание роли @' + targetRoleName + '.'),
        { statusCode: 502 },
      );
    }
    if (payload.imageUrl && !imageEmbed) {
      throw Object.assign(
        new Error('Discord did not confirm an HTTPS image embed.'),
        { statusCode: 502 },
      );
    }

    this.stateStore.markGameNewsSent(guildId, payload.id);
    await this.stateStore.save();
    return {
      sent: true,
      category: payload.category,
      role_pinged: rolePinged,
      role_name: targetRole.name,
      role_id: targetRole.id,
      image_embed: imageEmbed,
      channel_id: channel.id,
      message_id: message.id,
    };
  }

  async handleGameNewsRequest(req, res) {
    const sendJson = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };

    if (req.method !== 'POST') {
      return sendJson(405, { ok: false, error: 'method_not_allowed' });
    }
    if (!this.config.GAME_NEWS_API_KEY) {
      return sendJson(503, { ok: false, error: 'game_news_api_not_configured' });
    }

    const auth = String(req.headers.authorization || '');
    const provided = Buffer.from(auth.startsWith('Bearer ') ? auth.slice(7) : '');
    const expected = Buffer.from(this.config.GAME_NEWS_API_KEY);
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      return sendJson(401, { ok: false, error: 'unauthorized' });
    }

    let raw;
    try {
      raw = await new Promise((resolve, reject) => {
        let size = 0;
        let tooLarge = false;
        const chunks = [];
        req.on('data', chunk => {
          size += chunk.length;
          if (size > 32768) {
            tooLarge = true;
            chunks.length = 0;
          } else if (!tooLarge) {
            chunks.push(chunk);
          }
        });
        req.on('end', () => {
          if (tooLarge) return reject(Object.assign(new Error('payload_too_large'), { statusCode: 413 }));
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(Object.assign(new Error('invalid_json'), { statusCode: 400 }));
          }
        });
        req.on('error', reject);
      });
    } catch (err) {
      return sendJson(err.statusCode || 400, { ok: false, error: err.message || 'invalid_request' });
    }

    const guildId = String(raw?.guild_id || this.config.GUILD_ID || '').trim();
    if (!guildId) return sendJson(400, { ok: false, error: 'guild_id_required' });

    try {
      const result = await this.publishGameNews(guildId, raw);
      return sendJson(200, { ok: true, ...result });
    } catch (err) {
      console.error('Game news publish error:', err?.message || err);
      return sendJson(err.statusCode || 500, {
        ok: false,
        error: err.statusCode ? err.message : 'publish_failed',
      });
    }
  }

  async handleInteraction(interaction) {
    // Модерация: /clear
    if (interaction.isChatInputCommand() && this.mod.handles(interaction.commandName)) {
      if (!interaction.guildId) {
        return interaction.reply({ content: '❌ Эта команда работает только на сервере.', ephemeral: true }).catch(() => {});
      }
      if (!this.isHomeGuild(interaction.guildId)) {
        return interaction.reply({ content: HOME_GUILD_ONLY_REPLY, ephemeral: true }).catch(() => {});
      }
      return this.mod.handleCommand(interaction);
    }

    // Музыка: слэш-команды, кнопки панели и выпадающие списки обрабатывает модуль music.js.
    if (this.music.handles(interaction)) return this.music.handleInteraction(interaction);

    if (!interaction.isChatInputCommand()) return;

    if (!interaction.guildId) {
      return interaction.reply({ content: '❌ Эта команда работает только на сервере.', ephemeral: true }).catch(() => {});
    }

    if (ADMIN_COMMANDS.has(interaction.commandName)) {
      if (!this.isHomeGuild(interaction.guildId)) {
        return interaction.reply({ content: HOME_GUILD_ONLY_REPLY, ephemeral: true }).catch(() => {});
      }
      if (!this.isAdmin(interaction.memberPermissions)) {
        return interaction.reply({ content: '❌ Эта команда только для админов.', ephemeral: true }).catch(() => {});
      }
    }

    if (interaction.commandName === 'ping') {
      return interaction.reply({ content: `🏓 Pong! \`${this.client.ws.ping}ms\``, ephemeral: true });
    }

    if (interaction.commandName === 'say') {
      return this.handleSlashAi(interaction, interaction.options.getString('text', true));
    }

    if (interaction.commandName === 'image') {
      const text = interaction.options.getString('text', true);
      const ratio = interaction.options.getString('ratio') || '16:9';
      if (!this.config.GEMINI_API_KEY) {
        return interaction.reply({ content: '⚠️ Gemini пока не подключён.', ephemeral: true });
      }
      const wait = this.checkCooldown('image', interaction.user.id, this.config.IMAGE_USER_COOLDOWN_MS);
      if (wait) return interaction.reply({ content: `⏳ Подожди ${wait}с.`, ephemeral: true });
      await interaction.deferReply();
      await interaction.editReply('🖼 Генерирую изображение...');
      try {
        const result = await generateImageWithFallback({
          apiKey: this.config.GEMINI_API_KEY,
          models: this.config.GEMINI_IMAGE_MODELS,
          prompt: text,
          aspectRatio: normalizeAspectRatio(ratio),
        });
        const attachment = new AttachmentBuilder(result.buffer, { name: 'image.png' });
        return interaction.editReply({
          content: `✅ Готово${result.model ? ` • ${result.model}` : ''}`,
          files: [attachment],
        });
      } catch (err) {
        console.error('Slash image error:', err);
        return interaction.editReply({ content: formatImageError(err) });
      }
    }

    if (interaction.commandName === 'time' || interaction.commandName === 'user') {
      const target = interaction.options.getUser('user') || interaction.user;
      return this.handleVoiceTime(interaction, target);
    }

    if (interaction.commandName === 'top') {
      const embed = await this.buildTopEmbed(interaction.guild);
      return interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === 'life') {
      return interaction.reply({ embeds: [this.buildLifeEmbed()] });
    }

    if (interaction.commandName === 'news') {
      return this.handleNewsCommand(interaction);
    }

    if (interaction.commandName === 'msg') {
      await interaction.deferReply({ ephemeral: true });
      const channel = interaction.options.getChannel('channel', true);
      const content = interaction.options.getString('message', true);
      try {
        await channel.send({ content, allowedMentions: { parse: ['users', 'roles'] } });
        return interaction.editReply({ content: `✅ Отправлено в ${channel}.` });
      } catch (err) {
        console.error('msg error:', err);
        return interaction.editReply({ content: '❌ Не удалось отправить сообщение. Проверь права бота в канале.' });
      }
    }

    if (interaction.commandName === 'forget') {
      this.stateStore.clearChannelContext(interaction.channel.id);
      await this.stateStore.save();
      return interaction.reply({ content: '🧽 Чат-память этого канала очищена, начинаем с чистого листа.', ephemeral: true });
    }

    if (interaction.commandName === 'jtm') {
      const voiceChannel = interaction.member?.voice?.channel;
      if (!voiceChannel) {
        return interaction.reply({ content: '❌ Ты не в войсе, некуда заходить.', ephemeral: true });
      }
      await interaction.deferReply();
      try {
        await this.music.ensureVoice(voiceChannel);
        return interaction.editReply({ content: `✅ Зашёл в ${voiceChannel}.` });
      } catch (err) {
        console.error('jtm error:', err);
        return interaction.editReply({ content: '❌ Не удалось подключиться к войсу.' });
      }
    }
  }

  async handleMessage(message) {
    if (message.author.bot || !message.guild) return;

    const botId = this.client.user?.id;
    const rawContent = String(message.content || '').trim();
    const prefix = String(this.config.PREFIX || '!').trim() || '!';
    const prefixUsed = rawContent.startsWith(prefix)
      ? prefix
      : (prefix !== '!' && rawContent.startsWith('!') ? '!' : null);

    const directMention = botId
      ? new RegExp(`<@!?${escapeRegExp(botId)}>`, 'i').test(rawContent)
    : false;

    const repliedMessage = message.reference?.messageId
      ? await message.channel.messages.fetch(message.reference.messageId).catch(() => null)
      : null;
    const isReplyToBot = Boolean(botId && repliedMessage?.author?.id === botId);

    const cleanMentionText = stripMention(rawContent, botId);
    const isCommandLike = Boolean(prefixUsed || directMention || isReplyToBot);

    if (!isCommandLike && !rawContent) return;

    if (prefixUsed) {
      const args = rawContent.slice(prefixUsed.length).trim().split(/\s+/);
      const cmd = (args.shift() || '').toLowerCase();

      if (cmd === 'synccommands' || cmd === 'sync') {
        if (!this.isHomeGuild(message.guild.id) || !message.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
          return message.reply('❌ Эта команда доступна только администратору основного сервера.');
        }
        const status = await message.reply('🔄 Принудительно обновляю slash-команды Discord...');
        try {
          const result = await this.registerCommands();
          return status.edit(`✅ Синхронизация завершена: ${result.count} команд; сервер: ${result.guildRegistered}; глобально: ${result.globalRegistered}.`);
        } catch (err) {
          console.error('Manual slash command sync failed:', err);
          return status.edit(`❌ Discord отклонил регистрацию: ${clampText(err?.message || err, 500)}`);
        }
      }

      if (cmd === 'ping') {
        return message.reply({ content: `🏓 Pong! \`${this.client.ws.ping}ms\``, allowedMentions: { repliedUser: false } });
      }

      if (cmd === 'say') {
        const promptText = args.join(' ').trim();
        if (!promptText) return message.reply(`Напиши текст после \`${prefix}say\`.`);
        return this.handleAiMessage({ message, text: promptText });
      }

      if (cmd === 'image' || cmd === 'img') {
        const promptText = args.join(' ').trim();
        if (!promptText) return message.reply(`Напиши текст после \`${prefix}image\`.`);
        return this.handleImageRequest({ message, text: promptText, ratio: '16:9' });
      }

      if (cmd === 'help' || cmd === 'h') {
        return message.reply({
          content: `Команды: \`${prefix}ping\`, \`${prefix}say текст\`, \`${prefix}image текст\`, slash: /ping /say /image /time /user /top /life /news, админ: /clear /msg /forget /jtm /news`,
          allowedMentions: { repliedUser: false },
        });
      }
    }

    if (directMention || isReplyToBot) {
      const text = cleanMentionText.replace(/^[\s,:\-]+/, '').trim();
      if (!text) {
        return message.reply({ content: 'Да, я тут. Напиши, что нужно.', allowedMentions: { repliedUser: false } }).catch(() => {});
      }
      if (isImageRequest(text)) return this.handleImageRequest({ message, text, ratio: '16:9' });
      return this.handleAiMessage({ message, text });
    }
  }

  registerEventHandlers() {
    this.client.once(Events.ClientReady, async () => {
      console.log(`✅ Logged in as ${this.client.user.tag}`);
      try {
        const registration = await this.registerCommands();
        console.log('✅ Slash command sync completed:', registration);
      } catch (err) {
        console.error('❌ Slash command registration failed:', {
          message: err?.message,
          code: err?.code,
          status: err?.status,
          rawError: err?.rawError,
        });
      }
      if (!this.config.GUILD_ID) console.warn('⚠️ GUILD_ID is empty; global commands may take time to appear.');
      await this.refreshPresence();
      await this.restoreCurrentVoiceSessions();

      this.addTimer(CHECKPOINT_MS, () => this.checkpointVoiceSessions(false), 'Checkpoint error');
      // Ротация статуса: новая случайная пара раз в час.
      this.addTimer(STATUS_ROTATE_MS, () => this.rotateStatus(), 'Status rotate error');
      // Периодически подтверждаем presence той же парой (Discord иногда сбрасывает).
      this.addTimer(PRESENCE_REFRESH_MS, () => this.refreshPresence(), 'Presence refresh error');
      this.addTimer(5 * 60 * 1000, () => { this.sweepCooldowns(); }, 'Sweep error');
    });

    this.client.on('messageCreate', async message => {
      try {
        await this.handleMessage(message);
      } catch (err) {
        console.error('messageCreate error:', err);
      }
    });

    this.client.on('interactionCreate', async interaction => {
      try {
        await this.handleInteraction(interaction);
      } catch (err) {
        console.error('interactionCreate error:', err);
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: '❌ Что-то пошло не так.' }).catch(() => {});
        } else {
          await interaction.reply({ content: '✖ Что-то пошло не так.', ephemeral: true }).catch(() => {});
        }
      }
    });

    this.client.on('voiceStateUpdate', (oldState, newState) => {
      if (!oldState.guild || (this.config.GUILD_ID && oldState.guild.id !== this.config.GUILD_ID)) return;

      // Музыкальный модуль следит за состоянием самого бота (mute/deaf) и за пустым каналом.
      if (this.music.onVoiceStateUpdate(oldState, newState)) return;
      if (oldState.member?.user?.bot) return;

      const userId = oldState.id;
      const oldChannel = oldState.channelId;
      const newChannel = newState.channelId;

      if (!oldChannel && newChannel) this.startVoiceSession(oldState.guild.id, userId);
      if (oldChannel && !newChannel) this.endVoiceSession(oldState.guild.id, userId);
      if (!oldChannel && !newChannel) return;
      if (oldChannel && newChannel && oldChannel !== newChannel) this.startVoiceSession(oldState.guild.id, userId);
    });

    this.client.on('error', console.error);
    this.client.on('shardError', console.error);

    this.httpServer = http.createServer(async (req, res) => {
      const pathname = String(req.url || '/').split('?')[0];
      if (pathname === '/' || pathname === '/health' || pathname === '/healthz' || pathname === '/healt') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('ok');
        return;
      }
      if (pathname === '/api/game-news') {
        await this.handleGameNewsRequest(req, res).catch(err => {
          console.error('Game news HTTP error:', err?.message || err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'internal_error' }));
          }
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }).listen(process.env.PORT || 8080);

    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
  }

  addTimer(interval, fn, errorLabel) {
    const timer = setInterval(() => {
      void Promise.resolve(fn()).catch(err => console.error(`${errorLabel}:`, err));
    }, interval);
    this.timers.push(timer);
  }

  async start() {
    this.registerEventHandlers();
    await this.client.login(this.config.TOKEN);
  }

  async shutdown(signal) {
    try {
      console.log(`Получен ${signal}, сохраняю данные...`);
      this.timers.forEach(timer => clearInterval(timer));
      await this.checkpointVoiceSessions(true);
      await this.stateStore.save();
      await this.music.shutdown();
      if (this.httpServer) this.httpServer.close(() => {});
      if (this.client?.destroy) await this.client.destroy();
    } catch (e) {
      console.error('Shutdown error:', e);
    } finally {
      process.exit(0);
    }
  }
}

module.exports = { DiscordBot };
