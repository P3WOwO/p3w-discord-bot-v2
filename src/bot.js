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
const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');
const http = require('http');

const {
  CHECKPOINT_MS,
  PRESENCE_REFRESH_MS,
  STATUS_ROTATE_MS,
  TOP_LIMIT,
  HOME_GUILD_ONLY_REPLY,
  STATUS_VERBS,
  STATUS_NOUNS,
} = require('./constants');

const { pickRandom, formatTime, formatShortTime, formatTopTime, clampText, normalizeText } = require('./utils');
const {
  askGemini,
  askGeminiWithFallback,
  buildChatPrompt,
  buildSummaryPrompt,
  generateImageWithFallback,
} = require('./ai');
const { RpgGame, commandData: rpgCommands } = require('./rpg');

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

function escapeRegExp(value) {
  return String(value || '').replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
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

const ADMIN_COMMANDS = new Set(['msg', 'clear', 'jtm', 'forget']);

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
    this.rpg = new RpgGame(this.config);
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
        .setName('clear')
        .setDescription('Удалить последние сообщения')
        .setDefaultMemberPermissions(adminOnly)
        .addIntegerOption(option => option.setName('amount').setDescription('Сколько удалить').setRequired(true).setMinValue(1).setMaxValue(100))
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
      ...rpgCommands(),
    ];

    const rest = new REST({ version: '10' }).setToken(this.config.TOKEN);

    if (this.config.GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(this.config.CLIENT_ID, this.config.GUILD_ID), { body: commands });
    } else {
      await rest.put(Routes.applicationCommands(this.config.CLIENT_ID), { body: commands });
    }
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
    const channelId = channel.id;
    const channelName = channel?.name || '';
    const ctx = this.stateStore.getChannelContext(channelId);

    let chatContext = buildChatContext(ctx);

    // Страховка: если в памяти ещё пусто, берём свежие сообщения из Discord.
    if (!chatContext) {
      const recent = await this.getRecentMessages(channel, 10);
      chatContext = recent.map(turn => `${turn.role === 'assistant' ? 'Бот' : turn.name}: ${turn.text}`).join('\n');
    }

    const prompt = buildChatPrompt({
      basePrompt: this.config.BASE_PROMPT,
      chatContext,
      userName,
      channelName,
      text,
    });

    const answer = await askGeminiWithFallback({
      apiKey: this.config.GEMINI_API_KEY,
      models: this.config.GEMINI_CHAT_MODELS,
      prompt,
    });

    return { answer, channelName };
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
      const raw = await askGemini({
        apiKey: this.config.GEMINI_API_KEY,
        model: this.config.GEMINI_CHAT_MODELS[0] || this.config.GEMINI_MODEL,
        prompt: buildSummaryPrompt({ existingSummary: ctx.summary, oldMessages }),
        temperature: 0.25,
        maxOutputTokens: 300,
        retries: 1,
      });

      const summary = clampText(String(raw || '').trim(), 800);
      this.stateStore.applyChannelSummary(channelId, summary || ctx.summary);
    } catch (err) {
      console.error('Context summary failed:', err?.message || err);
    }
  }

  async handleAiMessage({ message, text }) {
    if (!this.config.GEMINI_API_KEY) {
      return message.reply('⚠️ Gemini пока не подключён.');
    }

    const userName = message.member?.displayName || message.author.username;
    const status = await message.reply('💭 Думаю...');
    await message.channel.sendTyping().catch(() => {});

    try {
      const { answer } = await this.generateChatReply({
        channel: message.channel,
        userName,
        text,
      });

      const finalAnswer = clampText(String(answer || ''), 1900);
      await status.edit(finalAnswer).catch(() => {});

      this.stateStore.appendChannelTurn(message.channel.id, { role: 'user', name: userName, text });
      this.stateStore.appendChannelTurn(message.channel.id, {
        role: 'assistant',
        name: this.client.user?.username || 'Bot',
        text: finalAnswer,
      });

      await this.maybeSummarizeChannel(message.channel.id, message.channel?.name || '');
      await this.stateStore.save();
    } catch (err) {
      console.error('Gemini error:', err);
      await status.edit('❌ Gemini сейчас перегружен или ответ не прошёл.').catch(() => {});
    }
  }

  async handleSlashAi(interaction, text) {
    if (!this.config.GEMINI_API_KEY) {
      return interaction.reply({ content: '⚠️ Gemini пока не подключён.', ephemeral: true });
    }

    await interaction.deferReply();
    const userName = interaction.member?.displayName || interaction.user.username;

    try {
      const { answer } = await this.generateChatReply({
        channel: interaction.channel,
        userName,
        text,
      });

      const finalAnswer = clampText(String(answer || ''), 1900);
      await interaction.editReply({ content: finalAnswer });

      this.stateStore.appendChannelTurn(interaction.channel.id, { role: 'user', name: userName, text });
      this.stateStore.appendChannelTurn(interaction.channel.id, {
        role: 'assistant',
        name: this.client.user?.username || 'Bot',
        text: finalAnswer,
      });

      await this.maybeSummarizeChannel(interaction.channel.id, interaction.channel?.name || '');
      await this.stateStore.save();
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

  async handleInteraction(interaction) {
    // RPG: slash-команды и кнопки со своим префиксом.
    if (interaction.isChatInputCommand() && interaction.commandName === 'rpg') {
      return this.rpg.handleCommand(interaction);
    }
    if ((interaction.isButton() || interaction.isAnySelectMenu()) && String(interaction.customId || '').startsWith('rpg:')) {
      return this.rpg.handleComponent(interaction);
    }

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

    if (interaction.commandName === 'clear') {
      await interaction.deferReply({ ephemeral: true });
      const amount = interaction.options.getInteger('amount', true);
      const deleted = await interaction.channel.bulkDelete(amount, true).catch(() => null);
      const count = deleted ? (typeof deleted === 'number' ? deleted : deleted.size) : 0;
      return interaction.editReply({ content: `🧹 Удалено сообщений: ${count}.` });
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
        joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: interaction.guild.id,
          adapterCreator: interaction.guild.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: false,
        });
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
          content: `Команды: \`${prefix}ping\`, \`${prefix}say текст\`, \`${prefix}image текст\`, slash-команды: /ping, /say, /image, /time, /user, /top, /life, /msg, /clear, /forget, /jtm`,
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
      await this.registerCommands().catch(err => console.error('Command registration error:', err));
      if (!this.config.GUILD_ID) console.warn('⚠️ GUILD_ID is empty; slash commands will be registered globally.');
      await this.rpg.init().catch(err => console.error('RPG init error:', err));
      await this.refreshPresence();
      await this.restoreCurrentVoiceSessions();

      this.addTimer(CHECKPOINT_MS, () => this.checkpointVoiceSessions(false), 'Checkpoint error');
      // Ротация статуса: новая случайная пара раз в час.
      this.addTimer(STATUS_ROTATE_MS, () => this.rotateStatus(), 'Status rotate error');
      // Периодически подтверждаем presence той же парой (Discord иногда сбрасывает).
      this.addTimer(PRESENCE_REFRESH_MS, () => this.refreshPresence(), 'Presence refresh error');
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

    this.httpServer = http.createServer((req, res) => {
      const url = String(req.url || '/');
      if (url === '/' || url === '/health' || url === '/healthz' || url === '/healt') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('ok');
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
