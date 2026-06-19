const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  AttachmentBuilder,
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
  ACTION_STATUSES,
  DEFAULT_ASSISTANT_BASE_PROMPT,
} = require('./constants');

const { pickRandom, formatTime, formatShortTime, formatTopTime, clampText } = require('./utils');
const { askGemini, askGeminiWithFallback, buildPrompt, buildMemoryPrompt, parseMemoryUpdate, generateGeminiImage, buildImagePrompt, MEMORY_EXTRACTION_MODEL_TEMPERATURE, MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS } = require('./ai');

const FORGET_PATTERNS = [
  /(?:забудь|удали|очисти|стёр|стерли|стирай|erase|forget|delete|remove)/i,
];

function normalizeLooseText(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function clampStatusText(text, max = 2000) {
  return clampText(String(text ?? ''), max);
}

function buildProgressMessage(stages = [], body = '') {
  const lines = Array.isArray(stages) ? stages.filter(Boolean) : [];
  const header = lines.join('\n');
  const cleanBody = String(body ?? '').trim();
  if (!header) return clampStatusText(cleanBody);
  if (!cleanBody) return clampStatusText(header);

  const separator = '\n\n';
  const budget = Math.max(80, 2000 - header.length - separator.length);
  const safeBody = clampStatusText(cleanBody, budget);
  return `${header}${separator}${safeBody}`;
}

function isAffirmativeReply(text) {
  const q = normalizeLooseText(text);
  return /^(?:да|ага|угу|ок|окей|подтверждаю|верно|правда|согласен|согласна|yes|yep|yeah|confirm)(?:[.!?…]*)$/.test(q);
}

function isNegativeReply(text) {
  const q = normalizeLooseText(text);
  return /^(?:нет|неа|не надо|не нужно|неверно|ошибка|ложь|отмена|отклоняю|no|nope|deny)(?:[.!?…]*)$/.test(q);
}

function isForgetUserRequest(text) {
  const q = normalizeLooseText(text);
  return FORGET_PATTERNS.some(re => re.test(q)) && /(обо мне|меня|про меня|мою|мою инфу|мою информацию|всю инфу обо мне|всё обо мне|все обо мне|удали всё про меня)/i.test(q);
}

function isForgetChannelRequest(text) {
  const q = normalizeLooseText(text);
  return FORGET_PATTERNS.some(re => re.test(q)) && /(чат|канал|разговор|переписку|историю чата|историю канала|наш чат|этот канал|этот чат)/i.test(q);
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

  async handlePendingReviewReply(message, text) {
    const pendingItems = this.stateStore.getPendingReviewsForUser(message.guild.id, message.author.id);
    if (!pendingItems.length) return false;

    const item = pendingItems[0];
    if (isAffirmativeReply(text)) {
      const approved = this.stateStore.approvePendingReview({
        guildId: message.guild.id,
        userId: message.author.id,
        channelId: message.channel.id,
        reviewId: item.id,
      });
      if (approved) {
        await this.stateStore.save();
        await message.reply({
          content: `✅ Запомнил: ${item.suggestedNote?.text || item.text}`,
          allowedMentions: { repliedUser: false },
        });
        return true;
      }
    }

    if (isNegativeReply(text)) {
      const rejected = this.stateStore.rejectPendingReview({
        guildId: message.guild.id,
        userId: message.author.id,
        reviewId: item.id,
      });
      if (rejected) {
        await this.stateStore.save();
        await message.reply({
          content: '✅ Убрал из памяти.',
          allowedMentions: { repliedUser: false },
        });
        return true;
      }
    }

    return false;
  }

  async handleForgetRequest(message, text) {
    if (isForgetUserRequest(text)) {
      this.stateStore.clearUserMemory(message.guild.id, message.author.id);
      await this.stateStore.save();
      await message.reply({
        content: '✅ Хорошо, я удалил всё, что помнил о тебе.',
        allowedMentions: { repliedUser: false },
      });
      return true;
    }

    if (isForgetChannelRequest(text) && this.isAdmin(message.memberPermissions)) {
      this.stateStore.clearChannelMemory(message.channel.id);
      await this.stateStore.save();
      await message.reply({
        content: '✅ Память по этому каналу очищена.',
        allowedMentions: { repliedUser: false },
      });
      return true;
    }

    return false;
  }

  getAssistantPrompt() {
    const profile = this.stateStore.getAssistantProfile();
    const parts = [this.config.BOT_BASE_PROMPT, profile?.basePrompt, DEFAULT_ASSISTANT_BASE_PROMPT].filter(Boolean);
    return [...new Set(parts)].join('\n\n').trim();
  }

  async setActionStatus(key, detail = '') {
    const preset = ACTION_STATUSES[key] || {};
    this.stateStore.setActionState({
      key,
      label: detail || preset.label || String(key || 'working'),
      detail,
      startedAt: new Date().toISOString(),
    });
    await this.refreshPresence();
  }

  async clearActionStatus() {
    this.stateStore.clearActionState();
    await this.refreshPresence();
  }

  buildActionActivity() {
    const lifeState = this.ensureLifeState();
    const action = lifeState.action;
    const detail = action?.detail ? ` • ${action.detail}` : '';
    const actionLabel = action?.label || ACTION_STATUSES[action?.key]?.label || null;
    const basePhrase = actionLabel ? `${actionLabel}${detail}` : `Слушает ${lifeState.phrase}`;
    return {
      name: `${basePhrase} • ${formatShortTime(this.buildLifeSeconds())}`,
      type: action?.key === 'image' ? ActivityType.Playing : ActivityType.Listening,
      timestamps: { start: lifeState.startedAt },
    };
  }

  extractImageRequest(text) {
    const clean = normalizeLooseText(text);
    const m = clean.match(/^(?:сгенерируй|нарисуй|создай|сделай(?:\s+мне)?(?:\s+картинку|\s+изображение)?|generate|imagine)\s*(.*)$/i);
    if (!m) return null;
    const prompt = String(m[1] || '').trim();
    return prompt || null;
  }

  isVoiceTimeQuery(text) {
    const q = normalizeLooseText(text);
    return /(сколько|какое|какой|скок|time|время).*(войс|в\s*войсе|голос)/i.test(q) || /(?:мое|моё|мой).*(время).*(войс|в\s*войсе|голос)/i.test(q);
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
    return this.buildActionActivity();
  }

  async applyPresence() {
    if (!this.client.user) return;
    const lifeState = this.ensureLifeState();
    const action = lifeState.action;
    const status = action ? 'idle' : 'online';
    this.client.user.setPresence({
      status,
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

  async getRecentMessages(channel, limit = 5) {
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
      .setDescription(`**Бот работает уже:** ${formatTime(lifeSeconds)}\n**Текущая фраза:** ${lifeState.phrase}${lifeState.action?.label ? `\n**Действие:** ${lifeState.action.label}` : ''}`)
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
        .setName('image')
        .setDescription('Сгенерировать картинку по описанию')
        .addStringOption(option => option.setName('text').setDescription('Что нарисовать').setRequired(true))
        .toJSON(),
      new SlashCommandBuilder()
        .setName('persona')
        .setDescription('Показать или изменить базовый промпт общения')
        .setDefaultMemberPermissions(adminOnly)
        .addStringOption(option => option.setName('text').setDescription('Новый базовый промпт (если пусто — покажет текущий)').setRequired(false))
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
    const recent = await this.getRecentMessages(channel, 5);
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
      assistantPrompt: this.getAssistantPrompt(),
      memoryContext,
      recentMessages: recent,
      userName,
      text,
      channelName,
    });

    const answer = await askGeminiWithFallback({
      apiKey: this.config.GEMINI_API_KEY,
      model: this.config.GEMINI_MODEL,
      models: [this.config.GEMINI_MODEL, this.config.GEMINI_MODEL_FALLBACK],
      prompt,
    });

    return { answer, recent, memoryContext, channelName };
  }

  async storeConversationTurn({ guildId, channel, userId, userName, userText, botReply, recentMessages, memoryContext, channelName, sourceMessageId = '', statusMessage = null }) {
    await this.setActionStatus('memory', 'Обновляет память');
    this.stateStore.pushChannelMessage(channel.id, 'user', userName, userText);
    this.stateStore.pushChannelMessage(channel.id, 'model', 'Bot', botReply);

    if (statusMessage) {
      await statusMessage.edit(buildProgressMessage([
        '📝 Обновляю память...',
        '🔎 Проверяю факты и контекст...'
      ])).catch(() => {});
    }

    this.stateStore.applyHeuristicMemoryExtraction({
      guildId,
      channelId: channel.id,
      userId,
      userName,
      channelName,
      userText,
      botReply,
      sourceMessageId,
    });

    let extractedUpdate = null;
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

        const rawUpdate = await askGeminiWithFallback({
          apiKey: this.config.GEMINI_API_KEY,
          model: this.config.GEMINI_MODEL,
          models: [this.config.GEMINI_MODEL, this.config.GEMINI_MODEL_FALLBACK],
          prompt: memoryPrompt,
          temperature: MEMORY_EXTRACTION_MODEL_TEMPERATURE,
          maxOutputTokens: MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS,
          retries: 1,
        });

        extractedUpdate = parseMemoryUpdate(rawUpdate);
        if (extractedUpdate) {
          this.stateStore.applyMemoryExtraction({
            guildId,
            channelId: channel.id,
            userId,
            userName,
            update: extractedUpdate,
          });
        }
      } catch (e) {
        console.error('Memory extraction error:', e?.message || e);
      }
    }

    if (Array.isArray(extractedUpdate?.pending_reviews_add) && extractedUpdate.pending_reviews_add.length) {
      const pending = extractedUpdate.pending_reviews_add[0];
      const summary = pending?.suggested_note?.text || pending?.suggestedNote?.text || pending?.text;
      if (summary) {
        await channel.send({
          content: `⚠️ Я не уверен в этой информации и не хочу запоминать её как факт без подтверждения: **${summary}**
Ответь **да** чтобы сохранить или **нет** чтобы удалить.`,
        }).catch(() => {});
      }
    }

    await this.stateStore.save();

    if (statusMessage) {
      await statusMessage.edit(buildProgressMessage([
        '📝 Обновляю память...',
        '✅ Память обновлена.'
      ])).catch(() => {});
    }

    await this.clearActionStatus();
  }

  async handleAiMessage({ message, text }) {
    if (!this.config.GEMINI_API_KEY) {
      return message.reply('⚠️ Gemini пока не подключён.');
    }

    const userName = message.member?.displayName || message.author.username;
    await this.setActionStatus('thinking', 'Анализирует запрос');
    const thinkingMsg = await message.reply('🧠 Анализирую запрос...');

    try {
      const { answer, recent, memoryContext, channelName } = await this.generateAiReply({
        channel: message.channel,
        guildId: message.guild.id,
        userId: message.author.id,
        userName,
        text,
      });

      await thinkingMsg.edit('💬 Формирую ответ...');

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
        sourceMessageId: message.id,
        statusMessage: thinkingMsg,
      });

      await thinkingMsg.delete().catch(() => {});
      await message.reply({
        content: answer,
        allowedMentions: { repliedUser: false },
      });
    } catch (e) {
      console.error('Gemini error:', e);
      await thinkingMsg.edit('⚠️ Я сейчас сильно загружен.').catch(() => {});
    } finally {
      await this.clearActionStatus();
    }
  }

  async handleMentionOrReply(message) {
    const authorName = message.member?.displayName || message.author.username;
    const cleanText = message.content.replace(new RegExp(`<@!?${this.client.user.id}>`, 'g'), '').trim();
    if (!cleanText) return;
    if (!this.config.GEMINI_API_KEY) return message.reply('⚠️ Gemini пока не подключён.');

    await this.setActionStatus('thinking', 'Анализирует запрос');
    const thinkingMsg = await message.reply('🧠 Анализирую запрос...');
    try {
      const { answer, recent, memoryContext, channelName } = await this.generateAiReply({
        channel: message.channel,
        guildId: message.guild.id,
        userId: message.author.id,
        userName: authorName,
        text: cleanText,
      });

      await thinkingMsg.edit('💬 Формирую ответ...');
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
        sourceMessageId: message.id,
        statusMessage: thinkingMsg,
      });

      await thinkingMsg.delete().catch(() => {});
      await message.reply({
        content: answer,
        allowedMentions: { repliedUser: false },
      });
    } catch (e) {
      console.error('Gemini error:', e);
      await thinkingMsg.edit('⚠️ Я сейчас сильно загружен.').catch(() => {});
    } finally {
      await this.clearActionStatus();
    }
  }

  getImageFileExtension(mimeType) {
    const mime = String(mimeType || '').toLowerCase();
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
    if (mime.includes('webp')) return 'webp';
    return 'png';
  }

  async generateImageResult(text) {
    await this.setActionStatus('image', 'Генерирует картинку');
    const prompt = buildImagePrompt(text);
    try {
      return await generateGeminiImage({
        apiKey: this.config.GEMINI_API_KEY,
        models: [this.config.GEMINI_IMAGE_MODEL, this.config.GEMINI_IMAGE_MODEL_FALLBACK],
        prompt,
      });
    } finally {
      await this.clearActionStatus();
    }
  }

  async handleImageMessage(message, text) {
    if (!this.config.GEMINI_API_KEY) {
      return message.reply('⚠️ Gemini пока не подключён.');
    }

    try {
      await message.channel.sendTyping().catch(() => {});
      const result = await this.generateImageResult(text);
      if (result.buffer) {
        const ext = this.getImageFileExtension(result.mimeType);
        const file = new AttachmentBuilder(result.buffer, { name: `image.${ext}` });
        const content = result.text ? `🎨 Готово. ${result.text}` : '🎨 Готово.';
        return message.reply({ content, files: [file], allowedMentions: { repliedUser: false } });
      }
      return message.reply({
        content: `⚠️ Картинка не вернулась, но вот промпт, который я использовал:

${buildImagePrompt(text)}`,
        allowedMentions: { repliedUser: false },
      });
    } catch (e) {
      console.error('Image generation error:', e);
      return message.reply({
        content: `❌ Не вышло сгенерировать картинку. Вот промпт на всякий случай:

${buildImagePrompt(text)}`,
        allowedMentions: { repliedUser: false },
      });
    }
  }

  async handleImageInteraction(interaction, text) {
    if (!this.config.GEMINI_API_KEY) {
      return interaction.editReply({ content: '⚠️ Gemini пока не подключён.' });
    }

    try {
      const result = await this.generateImageResult(text);
      if (result.buffer) {
        const ext = this.getImageFileExtension(result.mimeType);
        const file = new AttachmentBuilder(result.buffer, { name: `image.${ext}` });
        return interaction.editReply({ content: result.text ? `🎨 Готово. ${result.text}` : '🎨 Готово.', files: [file] });
      }
      return interaction.editReply({ content: `⚠️ Картинка не вернулась, но вот промпт:

${buildImagePrompt(text)}` });
    } catch (e) {
      console.error('Image generation error:', e);
      return interaction.editReply({ content: `❌ Не вышло сгенерировать картинку. Вот промпт:

${buildImagePrompt(text)}` });
    }
  }

  async handlePersonaInteraction(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const text = interaction.options.getString('text', false);
    const profile = this.stateStore.getAssistantProfile();

    if (!text) {
      const current = profile?.basePrompt || this.getAssistantPrompt();
      return interaction.editReply({ content: `🧩 Текущий базовый промпт:

${clampText(current, 3500)}` });
    }

    this.stateStore.updateAssistantProfile({
      basePrompt: text,
      lastUpdatedAt: new Date().toISOString(),
    });
    await this.stateStore.save();
    return interaction.editReply({ content: '✅ Базовый промпт общения обновлён.' });
  }

  async handleVoiceTimeMessage(message, targetUser = null) {
    const user = targetUser || message.author;
    const total = this.getTotalSeconds(message.guild.id, user.id);
    const member = await message.guild.members.fetch(user.id).catch(() => null);
    const name = member?.displayName || user.username;
    return message.reply({
      content: `⏱ **${name}** провёл в войсе: **${formatTime(total)}**`,
      allowedMentions: { repliedUser: false },
    });
  }

  async start() {
    this.client.once('ready', async () => {
      console.log(`✅ Бот онлайн: ${this.client.user.tag} | Gemini: ${this.config.GEMINI_MODEL}`);
      await this.stateStore.init();
      this.ensureLifeState();
      const assistantProfile = this.stateStore.getAssistantProfile();
      if (!assistantProfile.basePrompt) {
        this.stateStore.updateAssistantProfile({
          basePrompt: this.config.BOT_BASE_PROMPT || DEFAULT_ASSISTANT_BASE_PROMPT,
          tone: 'friendly',
          mood: 'calm',
          style: 'adaptive',
          lastUpdatedAt: new Date().toISOString(),
        });
      }
      this.stateStore.clearActionState();
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
      const cleanMessageText = message.content.replace(new RegExp(`<@!?${this.client.user.id}>`, 'g'), '').trim();

      if (message.content.startsWith(this.config.PREFIX)) {
        const args = message.content.slice(1).trim().split(/\s+/);
        const cmd = args[0]?.toLowerCase();

        if (cmd === 'say') {
          const promptText = args.slice(1).join(' ').trim();
          if (!promptText) return message.reply(`Напиши текст после \`${this.config.PREFIX}say\`.`);
          return this.handleAiMessage({ message, text: promptText });
        }

        if (cmd === 'img' || cmd === 'image' || cmd === 'imagine') {
          const promptText = args.slice(1).join(' ').trim();
          if (!promptText) return message.reply(`Напиши описание после \`${this.config.PREFIX}${cmd}\`.`);
          return this.handleImageMessage(message, promptText);
        }

        if (cmd === 'persona' && this.isAdmin(message.memberPermissions)) {
          const promptText = args.slice(1).join(' ').trim();
          if (!promptText) {
            const current = this.stateStore.getAssistantProfile()?.basePrompt || this.getAssistantPrompt();
            return message.reply({ content: `🧩 Текущий базовый промпт:

${clampText(current, 1800)}` });
          }
          this.stateStore.updateAssistantProfile({ basePrompt: promptText, lastUpdatedAt: new Date().toISOString() });
          await this.stateStore.save();
          return message.reply({ content: '✅ Базовый промпт общения обновлён.', allowedMentions: { repliedUser: false } });
        }
      }

      if (cleanMessageText) {
        const handledForget = await this.handleForgetRequest(message, cleanMessageText);
        if (handledForget) return;

        const handledPending = await this.handlePendingReviewReply(message, cleanMessageText);
        if (handledPending) return;
      }

      const isMentioned = message.mentions.has(this.client.user);
      let isReplyToBot = false;
      if (message.reference?.messageId) {
        const replied = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
        if (replied?.author.id === this.client.user.id) isReplyToBot = true;
      }
      if (!isMentioned && !isReplyToBot) return;

      const imagePrompt = this.extractImageRequest(cleanMessageText);
      if (imagePrompt) return this.handleImageMessage(message, imagePrompt);

      if (this.isVoiceTimeQuery(cleanMessageText)) {
        return this.handleVoiceTimeMessage(message);
      }

      if (!cleanMessageText) return;
      return this.handleMentionOrReply(message);
    });

    this.client.on('interactionCreate', async (interaction) => {
      if (!interaction.isChatInputCommand()) return;

      if (!interaction.guildId || !this.isHomeGuild(interaction.guildId)) {
        return interaction.reply({ content: HOME_GUILD_ONLY_REPLY, ephemeral: true }).catch(() => {});
      }

      if (['msg', 'purge', 'jtm', 'persona'].includes(interaction.commandName) && !this.isAdmin(interaction.memberPermissions)) {
        return interaction.reply({ content: '❌ Эта команда только для админов сервера.', ephemeral: true }).catch(() => {});
      }

      if (interaction.commandName === 'ping') {
        return interaction.reply({ content: `🏓 Pong! \`${this.client.ws.ping}ms\``, ephemeral: true });
      }

      if (interaction.commandName === 'say') {
        const text = interaction.options.getString('text', true);
        await interaction.deferReply();
        await this.setActionStatus('thinking', 'Анализирует запрос');
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
            sourceMessageId: interaction.id,
          });
        } catch (e) {
          console.error('Gemini error:', e);
          return interaction.editReply({ content: '❌ Gemini сейчас перегружен.' });
        } finally {
          await this.clearActionStatus();
        }
        return;
      }

      if (interaction.commandName === 'image') {
        const text = interaction.options.getString('text', true);
        await interaction.deferReply();
        return this.handleImageInteraction(interaction, text);
      }

      if (interaction.commandName === 'persona') {
        return this.handlePersonaInteraction(interaction);
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
