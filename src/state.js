const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { DEFAULT_LIFE_STATE } = require('./constants');
const {
  createEmptyMemory,
  normalizeMemory,
  appendChannelTurn,
  getChannelMemory,
  setChannelMemory,
  buildMemoryContext,
  extractJsonPayload,
  compactMemoryFallback,
} = require('./memory');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
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
      this.state.aiMemory = normalizeMemory(data.ai_memory);
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
      if (raw?.aiMemory && typeof raw.aiMemory === 'object') this.state.aiMemory = normalizeMemory(raw.aiMemory);
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

  getVoiceTimeSeconds(guildId, userId) {
    const key = `${guildId}:${userId}`;
    return Number(this.state.voiceTimes[key] || 0);
  }

  addVoiceSeconds(guildId, userId, seconds) {
    const key = `${guildId}:${userId}`;
    if (seconds <= 0) return;
    this.state.voiceTimes[key] = (Number(this.state.voiceTimes[key] || 0) || 0) + seconds;
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
    this.state.aiMemory = normalizeMemory(this.state.aiMemory);
    return this.state.aiMemory;
  }

  getChannelMemory(channelId) {
    return getChannelMemory(this.getAiMemory(), channelId);
  }

  setChannelMemory(channelId, nextMemory) {
    this.state.aiMemory = setChannelMemory(this.getAiMemory(), channelId, nextMemory);
  }

  appendChannelTurn(channelId, turn) {
    this.state.aiMemory = appendChannelTurn(this.getAiMemory(), channelId, turn);
  }

  updateChannelCompaction(channelId, { summary, digest }) {
    const memory = this.getAiMemory();
    const channel = memory.channels[channelId] || {};
    memory.channels[channelId] = {
      ...channel,
      summary: String(summary || '').trim(),
      digest: String(digest || '').trim(),
      turns: Array.isArray(channel.turns) ? channel.turns.slice(-20) : [],
      turnsSinceCompact: 0,
      lastCompactedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    };
    this.state.aiMemory = normalizeMemory(memory);
  }

  shouldCompactChannelMemory(channelId, threshold = 8) {
    const channel = this.getChannelMemory(channelId);
    return (Number(channel.turnsSinceCompact || 0) || 0) >= threshold;
  }

  buildMemoryContext({ channelId, channelName = '', queryText = '', recentMessages = [] }) {
    return buildMemoryContext(this.getAiMemory(), {
      channelId,
      channelName,
      queryText,
      recentMessages,
    });
  }

  compactFallback(channelId) {
    const channel = this.getChannelMemory(channelId);
    return compactMemoryFallback(channel);
  }

  getSnapshot() {
    return clone(this.state);
  }
}

module.exports = { StateStore };
