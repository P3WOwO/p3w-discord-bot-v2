const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { DEFAULT_LIFE_STATE, MAX_HISTORY } = require('./constants');
const {
  normalizeMemory,
  createEmptyMemory,
  createEmptyUser,
  createEmptyChannel,
  buildMemoryContext,
  applyMemoryUpdate,
  deriveHeuristicMemoryUpdate,
  truncate,
  normalizeScopeKey,
  rebalanceMemory,
} = require('./memory');
const { queryWantsKnowledge, buildKnowledgeSearchTerms, pickRelevantKnowledgeEntries } = require('./knowledge');

const DATA_DIR = '/data';
const LOCAL_FALLBACK_FILE = path.join(DATA_DIR, 'bot_state.json');

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

class StateStore {
  constructor(config) {
    this.config = config;
    this.supabase = null;
    this.enabled = false;
    this.state = {
      voiceTimes: {},
      lifeState: clone(DEFAULT_LIFE_STATE),
      aiMemory: createEmptyMemory(),
    };
  }

  async init() {
    this.loadLocalFallback();
    if (this.config.SUPABASE_URL && this.config.SUPABASE_SERVICE_ROLE_KEY) {
      this.supabase = createClient(this.config.SUPABASE_URL, this.config.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      try {
        await this.loadFromSupabase();
        this.enabled = true;
        console.log('✅ Supabase storage is enabled');
        return;
      } catch (err) {
        console.error('⚠️ Supabase init/load failed, using local fallback only:', err.message || err);
      }
    } else {
      console.log('⚠️ Supabase env vars not found, using local fallback only');
    }
    this.enabled = false;
  }

  async loadFromSupabase() {
    const { SUPABASE_TABLE, SUPABASE_ROW_ID } = this.config;
    const { data, error } = await this.supabase
      .from(SUPABASE_TABLE)
      .select('voice_times, life_state, ai_memory')
      .eq('row_id', SUPABASE_ROW_ID)
      .maybeSingle();

    if (error) throw error;

    if (data) {
      this.state.voiceTimes = data.voice_times && typeof data.voice_times === 'object' ? data.voice_times : {};
      this.state.lifeState = data.life_state && typeof data.life_state === 'object'
        ? { ...clone(DEFAULT_LIFE_STATE), ...data.life_state }
        : clone(DEFAULT_LIFE_STATE);
      this.state.aiMemory = rebalanceMemory(normalizeMemory(data.ai_memory));
      return;
    }

    const payload = this.buildPayload();
    const { error: insertError } = await this.supabase.from(SUPABASE_TABLE).insert(payload);
    if (insertError) throw insertError;
  }

  buildPayload() {
    return {
      row_id: this.config.SUPABASE_ROW_ID,
      voice_times: this.state.voiceTimes,
      life_state: this.state.lifeState,
      ai_memory: this.state.aiMemory,
      updated_at: new Date().toISOString(),
    };
  }

  async save() {
    if (!this.enabled) {
      this.saveLocalFallback();
      return;
    }

    const payload = this.buildPayload();
    const { error } = await this.supabase
      .from(this.config.SUPABASE_TABLE)
      .upsert(payload, { onConflict: 'row_id' });

    if (error) {
      console.error('❌ Supabase save failed, writing local fallback:', error.message || error);
      this.saveLocalFallback();
      return;
    }

    this.saveLocalFallback();
  }

  loadLocalFallback() {
    ensureDataDir();
    if (!fs.existsSync(LOCAL_FALLBACK_FILE)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(LOCAL_FALLBACK_FILE, 'utf8'));
      if (raw?.voiceTimes && typeof raw.voiceTimes === 'object') this.state.voiceTimes = raw.voiceTimes;
      if (raw?.lifeState && typeof raw.lifeState === 'object') {
        this.state.lifeState = { ...clone(DEFAULT_LIFE_STATE), ...raw.lifeState };
      }
      if (raw?.aiMemory && typeof raw.aiMemory === 'object') this.state.aiMemory = rebalanceMemory(normalizeMemory(raw.aiMemory));
    } catch (err) {
      console.error('⚠️ Local fallback load failed:', err.message || err);
    }
  }

  saveLocalFallback() {
    ensureDataDir();
    try {
      fs.writeFileSync(LOCAL_FALLBACK_FILE, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error('⚠️ Local fallback save failed:', err.message || err);
    }
  }

  getVoiceTimes() {
    return this.state.voiceTimes;
  }

  getLifeState() {
    if (!this.state.lifeState.startedAt) this.state.lifeState.startedAt = Date.now();
    if (!this.state.lifeState.phrase) this.state.lifeState.phrase = null;
    return this.state.lifeState;
  }

  setLifeState(next) {
    this.state.lifeState = { ...clone(DEFAULT_LIFE_STATE), ...next };
  }

  getAiMemory() {
    this.state.aiMemory = rebalanceMemory(normalizeMemory(this.state.aiMemory));
    return this.state.aiMemory;
  }

  async fetchKnowledgeEntries(queryText, limit = 6) {
    if (!this.supabase) return [];
    const table = this.config.SUPABASE_KNOWLEDGE_TABLE || 'bot_knowledge';
    const wants = queryWantsKnowledge(queryText);
    if (!wants) return [];

    try {
      const { data, error } = await this.supabase
        .from(table)
        .select('*')
        .limit(100);
      if (error) throw error;
      const normalized = Array.isArray(data) ? data.map(item => ({
        id: item.id || item.row_id || item.key || '',
        title: item.title || item.name || item.key || '',
        content: item.content || item.body || item.text || item.summary || '',
        scope: item.scope || 'global',
        source: item.source || table,
        tags: Array.isArray(item.tags) ? item.tags : typeof item.tags === 'string' ? item.tags.split(',').map(s => s.trim()) : [],
        aliases: Array.isArray(item.aliases) ? item.aliases : [],
        updatedAt: item.updated_at || item.updatedAt || item.created_at || item.createdAt || null,
        confidence: item.confidence ?? 0.7,
      })) : [];
      const localCached = this.state.aiMemory?.knowledgeVault?.entries || [];
      const combined = [...normalized, ...localCached];
      return pickRelevantKnowledgeEntries(combined, queryText, limit);
    } catch (err) {
      console.error('⚠️ Knowledge lookup failed:', err.message || err);
      const localCached = this.state.aiMemory?.knowledgeVault?.entries || [];
      return pickRelevantKnowledgeEntries(localCached, queryText, limit);
    }
  }


  getUserMemory(guildId, userId) {
    const memory = this.getAiMemory();
    return memory.users[normalizeScopeKey(guildId, userId)] || null;
  }

  getChannelMemory(channelId) {
    const memory = this.getAiMemory();
    return memory.channels[channelId] || null;
  }

  getPendingReviewsForUser(guildId, userId) {
    const memory = this.getAiMemory();
    const scopeKey = normalizeScopeKey(guildId, userId);
    return Array.isArray(memory.users[scopeKey]?.pendingReviews) ? memory.users[scopeKey].pendingReviews : [];
  }

  getPendingReviewCountForUser(guildId, userId) {
    return this.getPendingReviewsForUser(guildId, userId).length;
  }

  clearUserMemory(guildId, userId) {
    const memory = this.getAiMemory();
    const scopeKey = normalizeScopeKey(guildId, userId);
    memory.users[scopeKey] = createEmptyUser('');
    this.state.aiMemory = rebalanceMemory(memory);
  }

  clearChannelMemory(channelId) {
    const memory = this.getAiMemory();
    memory.channels[channelId] = createEmptyChannel('');
    this.state.aiMemory = rebalanceMemory(memory);
  }

  clearGlobalMemory() {
    const memory = this.getAiMemory();
    memory.globalSummary = '';
    memory.globalDigest = '';
    memory.globalNotes = [];
    memory.globalPendingReviews = [];
    this.state.aiMemory = rebalanceMemory(memory);
  }

  approvePendingReview({ guildId, userId, channelId, reviewId }) {
    const memory = this.getAiMemory();
    const scopeKey = normalizeScopeKey(guildId, userId);
    const user = memory.users[scopeKey];
    if (!user || !Array.isArray(user.pendingReviews) || !user.pendingReviews.length) return false;

    const idx = user.pendingReviews.findIndex(item => item.id === reviewId || item.text === reviewId);
    if (idx === -1) return false;
    const [pending] = user.pendingReviews.splice(idx, 1);
    const note = pending.suggestedNote || {
      text: pending.text,
      importance: Math.max(1, Math.min(5, pending.severity || 2)),
      category: pending.reason === 'possible_defamation' ? 'opinion' : 'fact',
      confidence: Math.max(0.5, pending.confidence || 0.5),
      source: 'pending-review-approved',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    user.notes = Array.isArray(user.notes) ? [...user.notes, note] : [note];
    user.lastUpdatedAt = new Date().toISOString();
    this.state.aiMemory = rebalanceMemory(memory);
    return true;
  }

  rejectPendingReview({ guildId, userId, reviewId }) {
    const memory = this.getAiMemory();
    const scopeKey = normalizeScopeKey(guildId, userId);
    const user = memory.users[scopeKey];
    if (!user || !Array.isArray(user.pendingReviews) || !user.pendingReviews.length) return false;
    const before = user.pendingReviews.length;
    user.pendingReviews = user.pendingReviews.filter(item => item.id !== reviewId && item.text !== reviewId);
    this.state.aiMemory = rebalanceMemory(memory);
    return user.pendingReviews.length !== before;
  }

  async getMemoryContext({ guildId, channelId, userId, userName, channelName = '', queryText = '', recentMessages = [] }) {
    const knowledgeEntries = await this.fetchKnowledgeEntries(queryText, 6);
    return buildMemoryContext(this.getAiMemory(), {
      guildId,
      channelId,
      userId,
      userName,
      channelName,
      queryText,
      recentMessages,
      knowledgeEntries,
    });
  }

  applyMemoryExtraction({ guildId, channelId, userId, userName, update }) {
    this.state.aiMemory = rebalanceMemory(applyMemoryUpdate(this.getAiMemory(), {
      guildId,
      channelId,
      userId,
      userName,
      update,
    }));
  }

  applyHeuristicMemoryExtraction({ guildId, channelId, userId, userName, channelName = '', userText = '', botReply = '', sourceMessageId = '' }) {
    const heuristicUpdate = deriveHeuristicMemoryUpdate({
      guildId,
      channelId,
      userId,
      userName,
      channelName,
      userText,
      botReply,
      sourceMessageId,
    });
    if (!heuristicUpdate || (!heuristicUpdate.should_store && !Array.isArray(heuristicUpdate.memory_actions))) return;
    this.state.aiMemory = rebalanceMemory(applyMemoryUpdate(this.getAiMemory(), {
      guildId,
      channelId,
      userId,
      userName,
      update: heuristicUpdate,
    }));
  }

  pushChannelMessage(channelId, role, name, text) {
    const clean = String(text || '').trim();
    if (!clean) return;
    const memory = this.getAiMemory();
    const channel = memory.channels[channelId] || {
      summary: '',
      notes: [],
      displayName: '',
      lastUpdatedAt: null,
      lastSeenAt: null,
      legacyHistory: [],
    };
    channel.legacyHistory = Array.isArray(channel.legacyHistory) ? channel.legacyHistory : [];
    channel.legacyHistory.push({
      role: String(role || 'user').slice(0, 20),
      name: String(name || '').slice(0, 80),
      text: truncate(clean, 300),
    });
    channel.legacyHistory = channel.legacyHistory.slice(-MAX_HISTORY);
    memory.channels[channelId] = channel;
    this.state.aiMemory = rebalanceMemory(memory);
  }

  setVoiceSeconds(key, seconds) {
    if (seconds <= 0) return;
    this.state.voiceTimes[key] = (this.state.voiceTimes[key] || 0) + seconds;
  }

  getSnapshot() {
    return clone(this.state);
  }
}

module.exports = { StateStore };
