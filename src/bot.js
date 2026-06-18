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
} = require('discord.js');
const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');
const http = require('http');

const {
  ActivityType: ACTIVITY_TYPE_FROM_CONST,
  CHECKPOINT_MS,
  PRESENCE_REFRESH_MS,
  PRESENCE_ROTATE_MS,
  TOP_LIMIT,
  HOME_GUILD_ONLY_REPLY,
  PRESENCE_VERBS,
  PRESENCE_NOUNS,
} = require('./constants');

const { pickRandom, formatTime, formatShortTime, formatTopTime, clampText } = require('./utils');
const { askGemini, buildPrompt, buildMemoryPrompt, parseMemoryUpdate, MEMORY_EXTRACTION_MODEL_TEMPERATURE, MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS } = require('./ai');

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

  addTime(guildId, userId, seconds) {
    if (seconds <= 0) return;
    const key = this.getKey(guildId, userId);
    const voiceTimes = this.stateStore.getVoiceTimes();
    voiceTimes[key] = (voiceTimes[key] || 0) + seconds;
  }

  getCurrentSessionSeconds(key) {
    const startedAt = this.activeSessions.get(key);
    return startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
  }

  getTotalSeconds(guildId, userId) {
    const key = this.getKey(guildId, userId);
    const voiceTimes = this.stateStore.getVoiceTimes();
    return (voiceTimes[key] || 0) + this.getCurrentSessionSeconds(key);
  }

  startSession(guildId, userId) {
    const key = this.getKey(guildId, userId);
    if (!this.activeSessions.has(key)) this.activeSessions.set(key, Date.now());
  }

  endSession(guildId, userId) {
    const key = this.getKey(guildId, userId);
    const startedAt = this.activeSessions.get(key);
    if (!startedAt) return;
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    if (secs > 0) this.addTime(guildId, userId, secs);
    this.activeSessions.delete(key);
  }

  checkpointSessions(force = false) {
    const now = Date.now();
    let changed = false;
    for (const [key, startedAt] of this.activeSessions.entries()) {
      const elapsed = Math.floor((now - startedAt) / 1000);
      if (elapsed > 0 && (force || elapsed >= 60)) {
        const [guildId, userId] = key.split(':');
        const voiceTimes = this.stateStore.getVoiceTimes();
        voiceTimes[key] = (voiceTimes[key] || 0) + elapsed;
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
      if (voiceState.channelId && userId !== this.client.user.id) this.startSession(this.config.GUILD_ID, userId);
    }
  }

  getRandomPresencePhrase() {
    return `${pickRandom(PRESENCE_VERBS)} ${pickRandom(PRESENCE_NOUNS)}`;
  }

  ensureLifeState() {
    const lifeState = this.stateStore.getLifeState();
    if (!lifeState.startedAt) lifeState.startedAt = Date.now();
    if (!lifeState.phrase) {
      lifeState.phrase = this.getRandomPresencePhrase();
      this.stateStore.setLifeState(lifeState);
    }
    return lifeState;
  }

  buildLifeSeconds() {
    const lifeState = this.ensureLifeState();
    return lifeState.startedAt ? Math.max(0, Math.floor((Date.now() - lifeState.startedAt) / 1000)) : 0;
  }

  buildPresenceActivity() {
    const lifeState = this.ensureLifeState();
    return {
      name: `Слушает ${lifeState.phrase} • ${formatShortTime(this.buildLifeSeconds())}`,
      type: ActivityType.Listening,
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
    await this.stateStore.save();
    await this.refreshPresence();
  }

  async getRecentMessages(channel, limit = 6) {
    const fetched = await channel.messages.fetch({ limit }).catch(() => null);
    if (!fetched) return [];
    return [...fetched.values()]
      .filter(m => !m.author.bot)
      .reverse()
      .map(m => ({
        name: m.member?.displayName || m.author.username,
        text: m.content?.trim() || '[без текста]',
      }));
  }

  async getMemberName(guild, userId) {
    const cached = guild.members.cache.get(userId);
    if (cached) return cached.displayName || cached.user.username;
    const fetched = await guild.members.fetch(userId).catch(() => null);
    if (fetched) return fetched.displayName || fetched.user.username;
    const user = await this.client.users.fetch(userId).catch(() => null);
    return user?.username || userId;
  }

  getLeaderboard(guildId) {
    const totals = new Map();
    const voiceTimes = this.stateStore.getVoiceTimes();

    for (const [key, seconds] of Object.entries(voiceTimes)) {
      const [gId, userId] = key.split(':');
      if (gId !== guildId) continue;
      totals.set(userId, (totals.get(userId) || 0) + seconds);
    }

    for (const [key, startedAt] of this.activeSessions.entries()) {
      const [gId, userId] = key.split(':');
      if (gId !== guildId) continue;
      const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      totals.set(userId, (totals.get(userId) || 0) + elapsed);
    }

    return [...totals.entries()]
      .map(([userId, seconds]) => ({ userId, seconds }))
      .sort((a, b) => b.seconds - a.seconds || a.userId.localeCompare(b.userId));
  }

  async buildTopEmbed(guild, targetUser) {
    const leaderboard = this.getLeaderboard(guild.id);
    const top = leaderboard.slice(0, TOP_LIMIT);
    const targetIndex = leaderboard.findIndex(entry => entry.userId === targetUser.id);
    const targetRank = targetIndex >= 0 ? targetIndex + 1 : null;
    const targetTotal = this.getTotalSeconds(guild.id, targetUser.id);

    const topRows = await Promise.all(top.map(async (item, i) => {
      const name = await this.getMemberName(guild, item.userId);
      const shortName = name.length > 26 ? `${name.slice(0, 25)}…` : name;
      return `${String(i + 1).padEnd(2)} ${shortName.padEnd(28)} ${formatTopTime(item.seconds)}`;
    }));

    const description = leaderboard.length === 0
      ? 'Пока никто не провёл время в войсе.'
      : ['```', '# Пользователь          Дни/часы', '-----------------------------------------', ...topRows, '```'].join('\n');

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('🏆 Топ по времени в войсе')
      .setDescription(description)
      .setFooter({ text: `Всего людей в таблице: ${leaderboard.length}` })
      .setTimestamp();

    if (targetRank !== null) {
      const targetName = await this.getMemberName(guild, targetUser.id);
      embed.addFields({
        name: 'Твоё место',
        value: `**#${targetRank}** — **${targetName}**\n**Время:** ${formatTopTime(targetTotal)}`,
        inline: false,
      });
    } else {
      embed.addFields({ name: 'Твоё место', value: `Пока нет данных по **${targetUser.username}**`, inline: false });
    }

    return embed;
  }

  buildLifeEmbed() {
    const lifeState = this.ensureLifeState();
    const lifeSeconds = this.buildLifeSeconds();
    return new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('💚 /life')
      .setDescription(`**Бот работает уже:** ${formatTime(lifeSeconds)}\n**Текущая фраза:** ${lifeState.phrase}`)
      .setTimestamp();
  }

  async registerCommands() {
    const adminOnly = PermissionFlagsBits.Administrator;

    const commands = [
      new SlashCommandBuilder()
        .setName('time')
        .setDescription('Показать время, проведённое в голосовых каналах')
        .addUserOption(option => option.setName('user').setDescription('Пользователь (если не указать — покажет твоё время)').setRequired(false))
        .toJSON(),
      new SlashCommandBuilder()
        .setName('top')
        .setDescription('Показать топ по времени в голосовых каналах')
        .addUserOption(option => option.setName('user').setDescription('Пользователь, которого тоже надо показать внизу, если он не в топе').setRequired(false))
        .toJSON(),
      new SlashCommandBuilder()
        .setName('life')
        .setDescription('Показать, сколько живёт бот')
        .toJSON(),
      new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Проверить отклик бота')
        .toJSON(),
      new SlashCommandBuilder()
        .setName('say')
        .setDescription('Попросить бота ответить на сообщение через Gemini')
        .addStringOption(option => option.setName('text').setDescription('Текст сообщения').setRequired(true))
        .toJSON(),
      new SlashCommandBuilder()
        .setName('msg')
        .setDescription('Отправить сообщение от имени бота в выбранный канал')
        .setDefaultMemberPermissions(adminOnly)
        .addChannelOption(option => option.setName('channel').setDescription('Канал, куда отправить сообщение').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
        .addStringOption(option => option.setName('message').setDescription('Текст сообщения').setRequired(true))
        .toJSON(),
      new SlashCommandBuilder()
        .setName('purge')
        .setDescription('Удалить последние N сообщений')
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

  async generateAiReply({ channel, guildId, userId, userName, text }) {
    const recent = await this.getRecentMessages(channel, 6);
    const channelName = channel?.name || channel?.threadMetadata?.name || '';
    const memoryContext = this.stateStore.getMemoryContext({
      guildId,
      channelId: channel.id,
      userId,
      userName,
      channelName,
      queryText: text,
      recentMessages: recent,
    });

    const prompt = buildPrompt({
      memoryContext,
      recentMessages: recent,
      userName,
      text,
      channelName,
    });

    const answer = await askGemini({
      apiKey: this.config.GEMINI_API_KEY,
      model: this.config.GEMINI_MODEL,
      prompt,
    });

    return { answer, recent, memoryContext, channelName };
  }

  async storeConversationTurn({ guildId, channel, userId, userName, userText, botReply, recentMessages, memoryContext, channelName }) {
    this.stateStore.pushChannelMessage(channel.id, 'user', userName, userText);
    this.stateStore.pushChannelMessage(channel.id, 'model', 'Bot', botReply);

    if (this.config.GEMINI_API_KEY) {
      try {
        const memoryPrompt = buildMemoryPrompt({
          userName,
          channelName,
          userText,
          botReply,
          recentMessages,
          existingContext: memoryContext,
        });

        const rawUpdate = await askGemini({
          apiKey: this.config.GEMINI_API_KEY,
          model: this.config.GEMINI_MODEL,
          prompt: memoryPrompt,
          temperature: MEMORY_EXTRACTION_MODEL_TEMPERATURE,
          maxOutputTokens: MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS,
          retries: 1,
        });

        const update = parseMemoryUpdate(rawUpdate);
        if (update) {
          this.stateStore.applyMemoryExtraction({
            guildId,
            channelId: channel.id,
            userId,
            userName,
            update,
          });
        }
      } catch (e) {
        console.error('Memory extraction error:', e?.message || e);
      }
    }

    await this.stateStore.save();
  }

  async handleAiMessage({ message, text }) {
    if (!this.config.GEMINI_API_KEY) {
      return message.reply('⚠️ Gemini пока не подключён.');
    }

    const userName = message.member?.displayName || message.author.username;
    const thinkingMsg = await message.reply('Думаю...');

    try {
      const { answer, recent, memoryContext, channelName } = await this.generateAiReply({
        channel: message.channel,
        guildId: message.guild.id,
        userId: message.author.id,
        userName,
        text,
      });

      await thinkingMsg.edit(clampText(answer, 2000));

      await this.storeConversationTurn({
        guildId: message.guild.id,
        channel: message.channel,
        userId: message.author.id,
        userName,
        userText: text,
        botReply: answer,
        recentMessages: recent,
        memoryContext,
        channelName,
      });
    } catch (e) {
      console.error('Gemini error:', e);
      await thinkingMsg.edit('⚠️ Я сейчас сильно загружен.');
    }
  }

  async handleMentionOrReply(message) {
    const authorName = message.member?.displayName || message.author.username;
    const cleanText = message.content.replace(new RegExp(`<@!?${this.client.user.id}>`, 'g'), '').trim();
    if (!cleanText) return;
    if (!this.config.GEMINI_API_KEY) return message.reply('⚠️ Gemini пока не подключён.');

    const thinkingMsg = await message.reply('Думаю...');
    try {
      const { answer, recent, memoryContext, channelName } = await this.generateAiReply({
        channel: message.channel,
        guildId: message.guild.id,
        userId: message.author.id,
        userName: authorName,
        text: cleanText,
      });

      await thinkingMsg.edit(clampText(answer, 2000));
      await this.storeConversationTurn({
        guildId: message.guild.id,
        channel: message.channel,
        userId: message.author.id,
        userName: authorName,
        userText: cleanText,
        botReply: answer,
        recentMessages: recent,
        memoryContext,
        channelName,
      });
    } catch (e) {
      console.error('Gemini error:', e);
      await thinkingMsg.edit('⚠️ Я сейчас сильно загружен.');
    }
  }

  async start() {
    this.client.once('ready', async () => {
      console.log(`✅ Бот онлайн: ${this.client.user.tag} | Gemini: ${this.config.GEMINI_MODEL}`);
      await this.stateStore.init();
      this.ensureLifeState();
      await this.stateStore.save();
      await this.registerCommands().catch(console.error);
      await this.restoreCurrentVoiceSessions();
      await this.refreshPresence();

      this.checkpointTimer = setInterval(() => this.checkpointSessions(false), CHECKPOINT_MS);
      this.presenceRefreshTimer = setInterval(() => this.refreshPresence().catch(console.error), PRESENCE_REFRESH_MS);
      this.presenceRotateTimer = setInterval(() => this.rotatePresencePhrase().catch(console.error), PRESENCE_ROTATE_MS);

      console.log(`🌿 Статус: "Слушает ${this.ensureLifeState().phrase}"`);
    });

    this.client.on('voiceStateUpdate', (oldState, newState) => {
      if (!newState.guild || newState.guild.id !== this.config.GUILD_ID || newState.id === this.client.user?.id) return;

      const oldChannel = oldState.channelId;
      const newChannel = newState.channelId;

      if (!oldChannel && newChannel) this.startSession(newState.guild.id, newState.id);
      else if (oldChannel && !newChannel) this.endSession(newState.guild.id, newState.id);
      else if (oldChannel && newChannel && oldChannel !== newChannel) {
        this.endSession(newState.guild.id, newState.id);
        this.startSession(newState.guild.id, newState.id);
      }
    });

    this.client.on('messageCreate', async (message) => {
      if (message.author.bot || !message.guild || !message.content) return;

      if (!this.isHomeGuild(message.guild.id)) {
        const isCommandLike = message.content.startsWith(this.config.PREFIX) || message.mentions.has(this.client.user);
        if (isCommandLike) return message.reply(HOME_GUILD_ONLY_REPLY).catch(() => {});
        return;
      }

      const authorName = message.member?.displayName || message.author.username;

      if (message.content.startsWith(this.config.PREFIX)) {
        const args = message.content.slice(1).trim().split(/\s+/);
        const cmd = args[0]?.toLowerCase();

        if (cmd === 'say') {
          const promptText = args.slice(1).join(' ').trim();
          if (!promptText) return message.reply(`Напиши текст после \`${this.config.PREFIX}say\`.`);
          return this.handleAiMessage({ message, text: promptText });
        }
      }

      const isMentioned = message.mentions.has(this.client.user);
      let isReplyToBot = false;
      if (message.reference?.messageId) {
        const replied = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
        if (replied?.author.id === this.client.user.id) isReplyToBot = true;
      }
      if (!isMentioned && !isReplyToBot) return;

      const cleanText = message.content.replace(new RegExp(`<@!?${this.client.user.id}>`, 'g'), '').trim();
      if (!cleanText) return;
      return this.handleMentionOrReply(message);
    });

    this.client.on('interactionCreate', async (interaction) => {
      if (!interaction.isChatInputCommand()) return;

      if (!interaction.guildId || !this.isHomeGuild(interaction.guildId)) {
        return interaction.reply({ content: HOME_GUILD_ONLY_REPLY, ephemeral: true }).catch(() => {});
      }

      if (['msg', 'purge', 'jtm'].includes(interaction.commandName) && !this.isAdmin(interaction.memberPermissions)) {
        return interaction.reply({ content: '❌ Эта команда только для админов сервера.', ephemeral: true }).catch(() => {});
      }

      if (interaction.commandName === 'ping') {
        return interaction.reply({ content: `🏓 Pong! \`${this.client.ws.ping}ms\``, ephemeral: true });
      }

      if (interaction.commandName === 'say') {
        const text = interaction.options.getString('text', true);
        await interaction.deferReply();
        try {
          if (!this.config.GEMINI_API_KEY) {
            return interaction.editReply({ content: '⚠️ Gemini пока не подключён.' });
          }
          const userName = interaction.member?.displayName || interaction.user.username;
          const { answer, recent, memoryContext, channelName } = await this.generateAiReply({
            channel: interaction.channel,
            guildId: interaction.guild.id,
            userId: interaction.user.id,
            userName,
            text,
          });
          await interaction.editReply({ content: clampText(answer, 2000) });
          await this.storeConversationTurn({
            guildId: interaction.guild.id,
            channel: interaction.channel,
            userId: interaction.user.id,
            userName,
            userText: text,
            botReply: answer,
            recentMessages: recent,
            memoryContext,
            channelName,
          });
        } catch (e) {
          console.error('Gemini error:', e);
          return interaction.editReply({ content: '❌ Gemini сейчас перегружен.' });
        }
        return;
      }

      if (interaction.commandName === 'msg') {
        await interaction.deferReply({ ephemeral: true });
        const channel = interaction.options.getChannel('channel', true);
        const msgText = interaction.options.getString('message', true);
        if (!channel.isTextBased()) return interaction.editReply({ content: '❌ Это не текстовый канал.' });
        try {
          await channel.send({ content: msgText });
          await interaction.editReply({ content: `✅ Сообщение отправлено в ${channel}.` });
        } catch (e) {
          await interaction.editReply({ content: '❌ Не удалось отправить сообщение.' });
        }
        return;
      }

      if (interaction.commandName === 'time') {
        await interaction.deferReply();
        const target = interaction.options.getUser('user') || interaction.user;
        const total = this.getTotalSeconds(interaction.guild.id, target.id);
        const member = await interaction.guild.members.fetch(target.id).catch(() => null);
        const name = member?.displayName || target.username;
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setAuthor({ name, iconURL: target.displayAvatarURL({ size: 256 }) })
          .setTitle('⏱ Время в войсе')
          .setDescription(`**Всего:** ${formatTime(total)}`)
          .setThumbnail(target.displayAvatarURL({ size: 256 }))
          .setFooter({ text: `ID: ${target.id}` })
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      }

      if (interaction.commandName === 'top') {
        await interaction.deferReply();
        const target = interaction.options.getUser('user') || interaction.user;
        const embed = await this.buildTopEmbed(interaction.guild, target);
        return interaction.editReply({ embeds: [embed] });
      }

      if (interaction.commandName === 'life') {
        await interaction.deferReply();
        return interaction.editReply({ embeds: [this.buildLifeEmbed()] });
      }

      if (interaction.commandName === 'purge') {
        await interaction.deferReply({ ephemeral: true });
        const amount = interaction.options.getInteger('amount', true);
        if (!interaction.channel?.isTextBased()) return interaction.editReply({ content: '❌ Это не текстовый канал.' });
        try {
          const deleted = await interaction.channel.bulkDelete(amount, true);
          await interaction.editReply({ content: `✅ Удалено сообщений: **${deleted.size}**` });
        } catch (e) {
          await interaction.editReply({ content: '❌ Не удалось удалить сообщения.' });
        }
        return;
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
        } catch (e) {
          await interaction.editReply({ content: '❌ Не удалось подключиться к войсу.' });
        }
      }
    });

    this.client.on('error', console.error);
    this.client.on('shardError', console.error);

    this.httpServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bot is alive');
    }).listen(process.env.PORT || 8080);

    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));

    await this.client.login(this.config.TOKEN);
  }

  async shutdown(signal) {
    try {
      console.log(`Получен ${signal}, сохраняю данные...`);
      await this.checkpointSessions(true);
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
