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
} = require('discord.js');
const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');
const http = require('http');

const {
  CHECKPOINT_MS,
  PRESENCE_REFRESH_MS,
  PRESENCE_ROTATE_MS,
  TOP_LIMIT,
  HOME_GUILD_ONLY_REPLY,
  PRESENCE_PHRASES,
} = require('./constants');

const { pickRandom, formatTime, formatShortTime, formatTopTime, clampText, normalizeText } = require('./utils');
const { askGemini, askGeminiWithFallback, buildChatPrompt, buildMemoryCompactionPrompt, generateImageWithFallback, extractJsonPayload } = require('./ai');

function isCommandLike(text, prefix) {
  const q = normalizeText(text);
  return q.startsWith(prefix);
}

function stripMention(text, botId) {
  return String(text || '').replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
}

function isImageRequest(text) {
  const q = normalizeText(text).toLowerCase();
  return /^(?:сгенерируй|нарисуй|создай|сделай)\b/.test(q) || /^(?:generate|create)\b/.test(q) || /(?:\bарт\b|\bimage\b|\bpicture\b)/.test(q);
}

function normalizeAspectRatio(value) {
  const allowed = new Set(['1:1', '16:9', '9:16', '3:2', '2:3', '4:5', '5:4']);
  const q = normalizeText(value);
  return allowed.has(q) ? q : '16:9';
}

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
    this.checkpointTimer = null;
    this.presenceRefreshTimer = null;
    this.presenceRotateTimer = null;
    this.httpServer = null;
  }

  isHomeGuild(guildId) {
    return guildId === this.config.GUILD_ID;
  }

  isAdmin(memberPermissions) {
    return memberPermissions?.has(PermissionFlagsBits.Administrator);
  }

  getKey(guildId, userId) {
    return `${guildId}:${userId}`;
  }

  getRandomPresencePhrase() {
    return pickRandom(PRESENCE_PHRASES);
  }

  ensureLifeState() {
    const lifeState = this.stateStore.getLifeState();
    if (!lifeState.startedAt) lifeState.startedAt = Date.now();
    if (!lifeState.phrase) lifeState.phrase = this.getRandomPresencePhrase();
    this.stateStore.setLifeState(lifeState);
    return lifeState;
  }

  buildLifeSeconds() {
    const lifeState = this.ensureLifeState();
    return lifeState.startedAt ? Math.max(0, Math.floor((Date.now() - lifeState.startedAt) / 1000)) : 0;
  }

  buildPresenceActivity() {
    const lifeState = this.ensureLifeState();
    return {
      name: `🫧 ${lifeState.phrase} • ${formatShortTime(this.buildLifeSeconds())}`,
      type: ActivityType.Watching,
      timestamps: { start: lifeState.startedAt },
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

  async rotatePresencePhrase() {
    const lifeState = this.ensureLifeState();
    lifeState.phrase = this.getRandomPresencePhrase();
    this.stateStore.setLifeState(lifeState);
    await this.refreshPresence();
  }

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

  checkpointVoiceSessions(force = false) {
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

    if (changed || force) return this.stateStore.save();
  }

  async restoreCurrentVoiceSessions() {
    const guild = this.client.guilds.cache.get(this.config.GUILD_ID) || await this.client.guilds.fetch(this.config.GUILD_ID).catch(() => null);
    if (!guild) return;

    this.activeSessions.clear();
    for (const [userId, voiceState] of guild.voiceStates.cache) {
      if (voiceState.channelId && userId !== this.client.user?.id) {
        this.startVoiceSession(this.config.GUILD_ID, userId);
      }
    }
  }

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
        .setName('purge')
        .setDescription('Удалить последние сообщения')
        .setDefaultMemberPermissions(adminOnly)
        .addIntegerOption(option => option.setName('amount').setDescription('Сколько удалить').setRequired(true).setMinValue(1).setMaxValue(100))
        .toJSON(),
      new SlashCommandBuilder()
        .setName('jtm')
        .setDescription('Зайти в твой войс')
        .setDefaultMemberPermissions(adminOnly)
        .toJSON(),
    ];

    const rest = new REST({ version: '10' }).setToken(this.config.TOKEN);
    await rest.put(Routes.applicationGuildCommands(this.config.CLIENT_ID, this.config.GUILD_ID), { body: commands });
    await rest.put(Routes.applicationCommands(this.config.CLIENT_ID), { body: [] });
  }

  async buildTopEmbed(guild) {
    const items = Object.entries(this.stateStore.getVoiceTimes())
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

    return new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🏆 Топ по войсу')
      .setDescription(lines.join('\n') || 'Пока пусто')
      .setTimestamp();
  }

  buildLifeEmbed() {
    const lifeState = this.ensureLifeState();
    return new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('🫧 Жизнь бота')
      .addFields(
        { name: 'Аптайм', value: formatTime(this.buildLifeSeconds()), inline: true },
        { name: 'Старт', value: lifeState.startedAt ? `<t:${Math.floor(lifeState.startedAt / 1000)}:F>` : '—', inline: true },
        { name: 'Режим', value: lifeState.phrase || '—', inline: false },
      )
      .setTimestamp();
  }

  async generateChatReply({ channel, guildId, userId, userName, text }) {
    const recent = await this.getRecentMessages(channel, 10);
    const channelName = channel?.name || channel?.threadMetadata?.name || '';
    const memoryContext = this.stateStore.buildMemoryContext({
      channelId: channel.id,
      channelName,
      queryText: text,
      recentMessages: recent,
    });

    const prompt = buildChatPrompt({
      basePrompt: this.config.BASE_PROMPT,
      memoryContext,
      userName,
      channelName,
      text,
    });

    const answer = await askGeminiWithFallback({
      apiKey: this.config.GEMINI_API_KEY,
      models: this.config.GEMINI_CHAT_MODELS,
      prompt,
    });

    return { answer, recent, channelName };
  }

  async compactChannelMemory({ channelId, channelName = '' }) {
    const channel = this.stateStore.getChannelMemory(channelId);
    const recentTurnsText = (channel.turns || [])
      .slice(-8)
      .map(turn => `${turn.role === 'assistant' ? 'Бот' : 'Чат'}: ${turn.text}`)
      .join('\n');

    if (!this.config.GEMINI_API_KEY) {
      const fallback = this.stateStore.compactFallback(channelId);
      this.stateStore.updateChannelCompaction(channelId, fallback);
      return;
    }

    try {
      const prompt = buildMemoryCompactionPrompt({
        existingSummary: channel.summary || '',
        channelName: channel.title || channelName || '',
        recentTurnsText,
      });

      const raw = await askGemini({
        apiKey: this.config.GEMINI_API_KEY,
        model: this.config.GEMINI_CHAT_MODELS[0] || this.config.GEMINI_MODEL,
        prompt,
        temperature: 0.25,
        maxOutputTokens: 700,
        retries: 1,
      });

      const parsed = extractJsonPayload(raw);
      if (parsed && (parsed.summary || parsed.digest)) {
        this.stateStore.updateChannelCompaction(channelId, {
          summary: String(parsed.summary || channel.summary || '').trim(),
          digest: String(parsed.digest || '').trim(),
        });
        return;
      }
    } catch (err) {
      console.error('Memory compaction failed:', err?.message || err);
    }

    const fallback = this.stateStore.compactFallback(channelId);
    this.stateStore.updateChannelCompaction(channelId, fallback);
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
      await message.reply({
        content: `✅ Готово${result.model ? ` • ${result.model}` : ''}`,
        files: [attachment],
        allowedMentions: { repliedUser: false },
      });
      return;
    } catch (err) {
      console.error('Image generation error:', err);
      await status.edit(`❌ Image generation error: ${clampText(String(err.message || err), 1800)}`).catch(() => {});
      return;
    }
  }

  async handleAiMessage({ message, text }) {
    if (!this.config.GEMINI_API_KEY) {
      return message.reply('⚠️ Gemini пока не подключён.');
    }

    const userName = message.member?.displayName || message.author.username;
    const status = await message.reply('🧠 Думаю...');
    await message.channel.sendTyping().catch(() => {});

    try {
      const { answer, recent, channelName } = await this.generateChatReply({
        channel: message.channel,
        guildId: message.guild.id,
        userId: message.author.id,
        userName,
        text,
      });

      const finalAnswer = clampText(answer, 1900);
      await status.edit(finalAnswer).catch(() => {});

      this.stateStore.appendChannelTurn(message.channel.id, {
        role: 'user',
        name: userName,
        text,
      });
      this.stateStore.appendChannelTurn(message.channel.id, {
        role: 'assistant',
        name: this.client.user?.username || 'Bot',
        text: finalAnswer,
      });

      if (this.stateStore.shouldCompactChannelMemory(message.channel.id, this.config.MEMORY_COMPACT_AFTER_TURNS)) {
        await status.edit('🗂 Сокращаю долгий контекст...').catch(() => {});
        await this.compactChannelMemory({
          channelId: message.channel.id,
          channelName,
        });
      }

      await this.stateStore.save();
      await status.edit(finalAnswer).catch(() => {});
      return;
    } catch (err) {
      console.error('Gemini error:', err);
      await status.edit('❌ Gemini сейчас перегружен или ответ не прошёл.').catch(() => {});
      return;
    }
  }

  async handleSlashAi(interaction, text) {
    if (!this.config.GEMINI_API_KEY) {
      return interaction.reply({ content: '⚠️ Gemini пока не подключён.', ephemeral: true });
    }

    await interaction.deferReply();
    const userName = interaction.member?.displayName || interaction.user.username;
    try {
      const { answer, recent, channelName } = await this.generateChatReply({
        channel: interaction.channel,
        guildId: interaction.guild.id,
        userId: interaction.user.id,
        userName,
        text,
      });

      await interaction.editReply({ content: clampText(answer, 1900) });
      this.stateStore.appendChannelTurn(interaction.channel.id, { role: 'user', name: userName, text });
      this.stateStore.appendChannelTurn(interaction.channel.id, { role: 'assistant', name: this.client.user?.username || 'Bot', text: clampText(answer, 1900) });

      if (this.stateStore.shouldCompactChannelMemory(interaction.channel.id, this.config.MEMORY_COMPACT_AFTER_TURNS)) {
        await this.compactChannelMemory({ channelId: interaction.channel.id, channelName });
      }

      await this.stateStore.save();
    } catch (err) {
      console.error('Gemini slash error:', err);
      await interaction.editReply({ content: '❌ Gemini сейчас перегружен или ответ не прошёл.' });
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
    if (!interaction.isChatInputCommand()) return;

    if (!interaction.guildId || !this.isHomeGuild(interaction.guildId)) {
      return interaction.reply({ content: HOME_GUILD_ONLY_REPLY, ephemeral: true }).catch(() => {});
    }

    if (['msg', 'purge', 'jtm'].includes(interaction.commandName) && !this.isAdmin(interaction.memberPermissions)) {
      return interaction.reply({ content: '❌ Эта команда только для админов.', ephemeral: true }).catch(() => {});
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
        return interaction.editReply({ content: `❌ Image generation error: ${clampText(String(err.message || err), 1800)}` });
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
      const msgText = interaction.options.getString('message', true);
      if (!channel.isTextBased()) return interaction.editReply({ content: '❌ Это не текстовый канал.' });
      try {
        await channel.send({ content: msgText });
        await interaction.editReply({ content: `✅ Сообщение отправлено в ${channel}.` });
      } catch {
        await interaction.editReply({ content: '❌ Не удалось отправить сообщение.' });
      }
      return;
    }

    if (interaction.commandName === 'purge') {
      await interaction.deferReply({ ephemeral: true });
      const amount = interaction.options.getInteger('amount', true);
      if (!interaction.channel?.isTextBased()) return interaction.editReply({ content: '❌ Это не текстовый канал.' });
      try {
        const deleted = await interaction.channel.bulkDelete(amount, true);
        return interaction.editReply({ content: `✅ Удалено сообщений: **${deleted.size}**` });
      } catch {
        return interaction.editReply({ content: '❌ Не удалось удалить сообщения.' });
      }
    }

    if (interaction.commandName === 'jtm') {
      await interaction.deferReply({ ephemeral: true });
      const voiceChannel = interaction.member?.voice?.channel;
      if (!voiceChannel) return interaction.editReply({ content: '❌ Ты не в войсе.' });
      const me = interaction.guild.members.me;
      const perms = voiceChannel.permissionsFor(me);
      if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])) {
        return interaction.editReply({ content: '❌ У меня нет прав зайти в этот войс.' });
      }
      try {
        const existing = getVoiceConnection(interaction.guild.id);
        if (existing) existing.destroy();
        joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: interaction.guild.id,
          adapterCreator: interaction.guild.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: false,
        });
        await interaction.editReply({ content: `✅ Зашёл в ${voiceChannel}.` });
      } catch {
        await interaction.editReply({ content: '❌ Не удалось подключиться к войсу.' });
      }
    }
  }

  async handleMessage(message) {
    if (message.author.bot || !message.guild || !message.content) return;

    if (!this.isHomeGuild(message.guild.id)) {
      const isCommandLike = message.content.startsWith(this.config.PREFIX) || message.mentions.has(this.client.user);
      if (isCommandLike) return message.reply(HOME_GUILD_ONLY_REPLY).catch(() => {});
      return;
    }

    const cleanMentionText = this.client.user ? stripMention(message.content, this.client.user.id) : message.content;
    const authorName = message.member?.displayName || message.author.username;

    if (message.content.startsWith(this.config.PREFIX)) {
      const args = message.content.slice(this.config.PREFIX.length).trim().split(/\s+/);
      const cmd = (args.shift() || '').toLowerCase();

      if (cmd === 'say') {
        const promptText = args.join(' ').trim();
        if (!promptText) return message.reply(`Напиши текст после \`${this.config.PREFIX}say\`.`);
        return this.handleAiMessage({ message, text: promptText });
      }

      if (cmd === 'image' || cmd === 'img') {
        const promptText = args.join(' ').trim();
        if (!promptText) return message.reply(`Напиши текст после \`${this.config.PREFIX}image\`.`);
        return this.handleImageRequest({ message, text: promptText, ratio: '16:9' });
      }
    }

    const isMentioned = message.mentions.has(this.client.user);
    let isReplyToBot = false;
    if (message.reference?.messageId) {
      const replied = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
      if (replied?.author?.id === this.client.user?.id) isReplyToBot = true;
    }

    if (isMentioned || isReplyToBot) {
      const text = cleanMentionText.trim();
      if (!text) return;
      if (isImageRequest(text)) return this.handleImageRequest({ message, text, ratio: '16:9' });
      return this.handleAiMessage({ message, text });
    }
  }

  async registerEventHandlers() {
    this.client.on('ready', async () => {
      console.log(`✅ Logged in as ${this.client.user.tag}`);
      await this.registerCommands().catch(err => console.error('Command registration error:', err));
      await this.refreshPresence();
      await this.restoreCurrentVoiceSessions();

      this.checkpointTimer = setInterval(() => {
        this.checkpointVoiceSessions(false).catch(err => console.error('Checkpoint error:', err));
      }, CHECKPOINT_MS);

      this.presenceRefreshTimer = setInterval(() => {
        this.refreshPresence().catch(err => console.error('Presence refresh error:', err));
      }, PRESENCE_REFRESH_MS);

      this.presenceRotateTimer = setInterval(() => {
        this.rotatePresencePhrase().catch(err => console.error('Presence rotate error:', err));
      }, PRESENCE_ROTATE_MS);
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
          await interaction.reply({ content: '❌ Что-то пошло не так.', ephemeral: true }).catch(() => {});
        }
      }
    });

    this.client.on('voiceStateUpdate', (oldState, newState) => {
      if (!oldState.guild || oldState.guild.id !== this.config.GUILD_ID) return;
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
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bot is alive');
    }).listen(process.env.PORT || 8080);

    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
  }

  async start() {
    await this.registerEventHandlers();
    await this.client.login(this.config.TOKEN);
  }

  async shutdown(signal) {
    try {
      console.log(`Получен ${signal}, сохраняю данные...`);
      if (this.checkpointTimer) clearInterval(this.checkpointTimer);
      if (this.presenceRefreshTimer) clearInterval(this.presenceRefreshTimer);
      if (this.presenceRotateTimer) clearInterval(this.presenceRotateTimer);
      await this.checkpointVoiceSessions(true);
      await this.stateStore.save();
      if (this.httpServer) this.httpServer.close(() => {});
      if (this.client?.destroy) this.client.destroy();
    } catch (e) {
      console.error('Shutdown error:', e);
    } finally {
      process.exit(0);
    }
  }
}

module.exports = { DiscordBot };
