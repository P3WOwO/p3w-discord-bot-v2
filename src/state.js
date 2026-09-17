const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { DEFAULT_LIFE_STATE } = require('./constants');
const {
  createChannelContext,
  normalizeChannelContext,
  addTurnToContext,
} = require('./context');
const { clampText } = require('./utils');

const DATA_DIR = process.env.DATA_DIR || path.join('/tmp', 'p3w-bot');
const LOCAL_FALLBACK_FILE = path.join(DATA_DIR, 'bot_state.json');
const SUPABASE_RECONNECT_MS = Number(process.env.SUPABASE_RECONNECT_MS || 3 * 60 * 1000) || 3 * 60 * 1000;

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
    this.reconnectTimer = null;
    this.state = {
      voiceTimes: {},
      lifeState: clone(DEFAULT_LIFE_STATE),
      aiMemory: { channels: {} },
    };
  }

  async init() {
    this.loadLocalFallback();
    await this.connectSupabase();

    if (!this.enabled) {
      this.startReconnectTimer();
    }
  }

  async connectSupabase() {
    if (!this.config.SUPABASE_URL || !this.config.SUPABASE_SERVICE_ROLE_KEY) {
      console.log('⚠️ Supabase env vars not found, using local fallback only');
      return;
    }

    if (!this.supabase) {
      this.supabase = createClient(this.config.SUPABASE_URL, this.config.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }

    // Снимок локального состояния до загрузки: при переподключении смержим, ничего не потеряем.
    const localSnapshot = clone(this.state);

    try {
      await this.loadFromSupabase();
      this.mergeLocalState(localSnapshot);
      this.enabled = true;
      console.log(`✅ Supabase storage is enabled (table=${this.config.SUPABASE_TABLE}, row=${this.config.SUPABASE_ROW_ID})`);
      console.log(`✅ Loaded from Supabase: voice entries=${Object.keys(this.state.voiceTimes).length}, channels=${Object.keys(this.state.aiMemory.channels).length}`);
    } catch (err) {
      this.enabled = false;
      const cause = err?.cause?.code || err?.cause?.message || '';
      let host = 'INVALID URL';
      try { host = new URL(this.config.SUPABASE_URL).host; } catch {}
      console.error(`⚠️ Supabase init/load failed: ${err?.message || err}${cause ? ` (cause: ${cause})` : ''} | host: ${host}`);
    }
  }

  // Данные, накопленные локально пока Supabase был недоступен, объединяем с базой (берём максимум).
  mergeLocalState(localSnapshot) {
    for (const [key, value] of Object.entries(localSnapshot.voiceTimes || {})) {
      if (Number(value || 0) > Number(this.state.voiceTimes[key] || 0)) {
        this.state.voiceTimes[key] = Number(value || 0);
      }
    }

    const localStart = localSnapshot.lifeState?.startedAt;
    const remoteStart = this.state.lifeState?.startedAt;
    if (localStart && (!remoteStart || localStart < remoteStart)) {
      this.state.lifeState.startedAt = localStart;
    }

    const countTurns = (memory) => Object.values(memory?.channels || {})
      .reduce((sum, ch) => sum + (ch?.turns?.length || 0), 0);
    if (countTurns(localSnapshot.aiMemory) > countTurns(this.state.aiMemory)) {
      this.state.aiMemory = this.normalizeAiMemory(localSnapshot.aiMemory);
    }
  }

  startReconnectTimer() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setInterval(async () => {
      if (this.enabled) {
        clearInterval(this.reconnectTimer);
        this.reconnectTimer = null;
        return;
      }
      console.log('🔁 Retrying Supabase connection...');
      await this.connectSupabase();
    }, SUPABASE_RECONNECT_MS);
  }

  normalizeAiMemory(raw) {
    const channels = raw?.channels && typeof raw.channels === 'object' ? raw.channels : {};
    return {
      channels: Object.fromEntries(
        Object.entries(channels).map(([channelId, channelMemory]) => [
          channelId,
          normalizeChannelContext(channelMemory),
        ])
      ),
    };
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
      this.state.aiMemory = this.normalizeAiMemory(data.ai_memory);
      console.log(`✅ Loaded from Supabase: voice entries=${Object.keys(this.state.voiceTimes).length}, channels=${Object.keys(this.state.aiMemory.channels).length}`);
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
      if (raw?.aiMemory && typeof raw.aiMemory === 'object') this.state.aiMemory = this.normalizeAiMemory(raw.aiMemory);
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

  // ===== API состояния =====

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
    return this.state.lifeState;
  }

  setLifeState(next) {
    this.state.lifeState = { ...clone(DEFAULT_LIFE_STATE), ...next };
  }

  getChannelContext(channelId) {
    const memory = this.normalizeAiMemory(this.state.aiMemory);
    this.state.aiMemory = memory;
    return memory.channels[channelId] || createChannelContext();
  }

  setChannelContext(channelId, ctx) {
    const memory = this.normalizeAiMemory(this.state.aiMemory);
    memory.channels[channelId] = normalizeChannelContext(ctx);
    this.state.aiMemory = memory;
  }

  appendChannelTurn(channelId, turn) {
    const ctx = this.getChannelContext(channelId);
    addTurnToContext(ctx, turn);
    this.setChannelContext(channelId, ctx);
  }

  clearChannelContext(channelId) {
    const memory = this.normalizeAiMemory(this.state.aiMemory);
    delete memory.channels[channelId];
    this.state.aiMemory = memory;
  }

  shouldSummarizeChannel(channelId, threshold) {
    const ctx = this.getChannelContext(channelId);
    return (Number(ctx.turnsSinceSummary || 0) || 0) >= threshold;
  }

  applyChannelSummary(channelId, summary) {
    const ctx = this.getChannelContext(channelId);
    ctx.summary = clampText(summary || '', 800);
    ctx.archive = [];
    ctx.turnsSinceSummary = 0;
    ctx.lastUpdatedAt = new Date().toISOString();
    this.setChannelContext(channelId, ctx);
  }

  getSnapshot() {
    return clone(this.state);
  }
}

module.exports = { StateStore };

