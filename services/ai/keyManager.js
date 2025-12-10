// services/ai/keyManager.js
'use strict';

const supabase = require('../data/supabase');
const logger = require('../../utils/logger');
const { shuffled, sleep } = require('../../utils');
const { GoogleGenerativeAI } = require('@google/generative-ai');

class KeyManager {
    constructor() {
        this.keys = new Map(); // In-memory storage
        this.queue = [];       // Request queue
        this.MAX_FAILS = 4;
        this.isInitialized = false;
    }

    async reloadKeys() {
        this.isInitialized = false;
        this.keys.clear();
        await this.init();
    }

    // ============================================================
    // 1. Smart Initialization
    // ============================================================
    async init() {
        if (this.isInitialized) return;
        logger.info('🔑 KeyManager: Initializing & Syncing with DB...');

        try {
            // A. Fetch all keys from Database first
            const { data: dbKeys, error } = await supabase
                .from('system_api_keys')
                .select('*');

            if (error) logger.error(`KeyManager DB Load Error: ${error.message}`);

            // Convert DB array to Map for faster lookup
            const dbKeyMap = new Map();
            if (dbKeys) {
                dbKeys.forEach(k => dbKeyMap.set(k.key_value, k));
            }

            // B. Prepare Environment Keys
            const envKeys = [];
            // Master Key
            if (process.env.GOOGLE_API_KEY) {
                envKeys.push({ key: process.env.GOOGLE_API_KEY, nick: 'Master_Key' });
            }
            // Loop for numbered keys (GOOGLE_API_KEY_1 to GOOGLE_API_KEY_20)
            for (let i = 1; i <= 20; i++) {
                const k = process.env[`GOOGLE_API_KEY_${i}`];
                if (k) envKeys.push({ key: k, nick: `Env_Key_${i}` });
            }

            // C. Smart Merge Logic
            for (const envK of envKeys) {
                const existing = dbKeyMap.get(envK.key);

                if (existing) {
                    // ✅ Case 1: Key exists in DB -> Restore stats (don't start from zero)
                    this._addKeyToMemory(
                        existing.key_value,
                        existing.nickname || envK.nick,
                        existing.fails_count,
                        existing.usage_count,
                        existing.total_input_tokens,
                        existing.total_output_tokens,
                        existing.today_requests_count, // 🔥 Restore daily counter
                        existing.last_reset_at
                    );
                    // Remove from map to avoid duplication in step D
                    dbKeyMap.delete(envK.key);
                } else {
                    // 🆕 Case 2: New key in .env not in DB -> Register it
                    await this._registerNewKeyInDb(envK.key, envK.nick);
                    this._addKeyToMemory(envK.key, envK.nick); // Starts fresh
                }
            }

            // D. Add keys that are ONLY in DB (e.g., added manually via Admin Panel)
            for (const [keyStr, row] of dbKeyMap.entries()) {
                if (row.status === 'active') {
                    this._addKeyToMemory(
                        row.key_value,
                        row.nickname,
                        row.fails_count,
                        row.usage_count,
                        row.total_input_tokens,
                        row.total_output_tokens,
                        row.today_requests_count,
                        row.last_reset_at
                    );
                }
            }

            logger.success(`🔑 KeyManager Initialized. Loaded ${this.keys.size} keys (Stats Restored).`);
            this.isInitialized = true;

        } catch (e) {
            logger.error('KeyManager Critical Init Error:', e);
            // Fallback: If DB fails completely, load Env keys to keep server running
            this._emergencyLoadEnv();
        }
    }

    // Helper to register new key in DB
    async _registerNewKeyInDb(keyStr, nickname) {
        try {
            await supabase.from('system_api_keys').insert({
                key_value: keyStr,
                nickname: nickname,
                status: 'active',
                created_at: new Date().toISOString()
            });
        } catch (e) {
            // Ignore if key already exists (Duplicate)
        }
    }

    // Emergency Mode (If DB is down)
    _emergencyLoadEnv() {
        logger.warn('⚠️ KeyManager: Running in Emergency Mode (Env Only, No Stats).');
        if (process.env.GOOGLE_API_KEY) {
            this._addKeyToMemory(process.env.GOOGLE_API_KEY, 'Master_Key');
        }
        for (let i = 1; i <= 20; i++) {
            const k = process.env[`GOOGLE_API_KEY_${i}`];
            if (k) this._addKeyToMemory(k, `Env_Key_${i}`);
        }
    }

    _addKeyToMemory(keyStr, nickname = 'Unknown', fails = 0, usage = 0, inputTokens = 0, outputTokens = 0, todayCount = 0, lastReset = null) {
        if (this.keys.has(keyStr)) return;

        // Daily Reset Logic
        let currentTodayCount = todayCount;
        const now = new Date();
        const lastResetDate = lastReset ? new Date(lastReset) : new Date();

        // Check if day has changed (comparing date strings is safer than getDate())
        if (lastReset && lastResetDate.toDateString() !== now.toDateString()) {
            currentTodayCount = 0;
            // Note: DB update happens lazily on next usage
        }

        this.keys.set(keyStr, {
            key: keyStr,
            nickname,
            client: new GoogleGenerativeAI(keyStr),
            status: fails >= this.MAX_FAILS ? 'dead' : 'idle',
            fails: fails,
            usage: usage,
            inputTokens: inputTokens || 0,
            outputTokens: outputTokens || 0,
            todayRequests: currentTodayCount,
            rpdLimit: 2000, // Daily Limit (Adjust as needed, e.g., 20 or 2000)
            rpmLimit: 5,    // RPM Limit (Not strictly enforced here but good for ref)
            lastUsed: null
        });
    }

    // ============================================================
    // 2. Acquire Key (Check-Out)
    // ============================================================
    async acquireKey() {
        return new Promise((resolve) => {
            const tryAcquire = () => {
                // 1. Filter Available Keys (Idle & Not over daily limit)
                const available = Array.from(this.keys.values()).filter(k => {
                    return k.status === 'idle' && k.todayRequests < k.rpdLimit;
                });

                if (available.length > 0) {
                    // Load Balancing: Random Selection
                    const selected = shuffled(available)[0];

                    selected.status = 'busy';
                    selected.lastUsed = Date.now();
                    selected.usage++;
                    selected.todayRequests++; // Increment memory counter

                    // Sync to DB (Total + Daily + Last Reset Time)
                    this._syncKeyStats(selected.key, {
                        usage_count: selected.usage,
                        today_requests_count: selected.todayRequests,
                        last_reset_at: new Date().toISOString()
                    });

                    resolve(selected);
                } else {
                    // Queue request if no keys available
                    logger.warn('⚠️ All keys reached daily limit or are busy! Queuing request...');
                    this.queue.push(tryAcquire);
                }
            };

            tryAcquire();
        });
    }

    // ============================================================
    // 3. Release Key (Check-In)
    // ============================================================
    releaseKey(keyStr, wasSuccess = true, errorType = null) {
        const keyObj = this.keys.get(keyStr);
        if (!keyObj) return;

        if (wasSuccess) {
            keyObj.status = 'idle';
            keyObj.fails = 0; // Reset fails on success
        } else {
            keyObj.fails++;
            logger.warn(`❌ Key ${keyObj.nickname} failed (${keyObj.fails}/${this.MAX_FAILS}). Error: ${errorType}`);

            if (keyObj.fails >= this.MAX_FAILS) {
                keyObj.status = 'dead';
                logger.error(`💀 Key ${keyObj.nickname} is now DEAD.`);
                this._syncKeyStats(keyStr, { status: 'dead', fails_count: keyObj.fails });
            } else if (errorType === '429') {
                keyObj.status = 'cooldown';
                logger.warn(`❄️ Key ${keyObj.nickname} in cooldown for 1 min.`);
                
                // Release from cooldown after 1 minute
                setTimeout(() => {
                    if (keyObj.status !== 'dead') keyObj.status = 'idle';
                    this._processQueue();
                }, 60000);
            } else {
                keyObj.status = 'idle';
            }

            this._syncKeyStats(keyStr, { fails_count: keyObj.fails });
        }

        // Check Queue
        this._processQueue();
    }

    _processQueue() {
        if (this.queue.length > 0) {
            const hasIdle = Array.from(this.keys.values()).some(k => k.status === 'idle');
            if (hasIdle) {
                const nextRequest = this.queue.shift(); // FIFO
                if (nextRequest) nextRequest();
            }
        }
    }

    // Log Token Usage
    async recordUsage(keyStr, usageMetadata, userId = null, modelName = 'unknown') {
        const keyObj = this.keys.get(keyStr);
        if (!keyObj || !usageMetadata) return;

        const input = usageMetadata.promptTokenCount || 0;
        const output = usageMetadata.candidatesTokenCount || 0;

        keyObj.inputTokens += input;
        keyObj.outputTokens += output;

        try {
            // Atomic Update via RPC
            await supabase.rpc('increment_key_usage', {
                key_val: keyStr,
                inc_input: input,
                inc_output: output
            });
            
            // Optional: Detailed logs table
            /* 
            await supabase.from('ai_usage_logs').insert({
                user_id: userId,
                model_name: modelName,
                input_tokens: input,
                output_tokens: output,
                total_tokens: input + output,
                key_nickname: keyObj.nickname
            }); 
            */

        } catch (e) {
            console.error('Failed to log tokens:', e.message);
        }
    }

    async _syncKeyStats(keyStr, updates) {
        // Fire & Forget background update
        try {
            await supabase.from('system_api_keys').update(updates).eq('key_value', keyStr);
        } catch (e) { /* ignore */ }
    }

    // --- Admin Functions ---

    getAllKeysStatus() {
        return Array.from(this.keys.values()).map(k => ({
            key: k.key.substring(0, 8) + '...',
            nickname: k.nickname,
            status: k.status,
            fails: k.fails,
            todayRequests: k.todayRequests,
            limit: k.rpdLimit,
            usage: k.usage,
            lastUsed: k.lastUsed ? new Date(k.lastUsed).toISOString() : 'Never'
        }));
    }

    async addKey(keyStr, nickname) {
        if (this.keys.has(keyStr)) return { success: false, msg: 'Duplicate' };
        await this._registerNewKeyInDb(keyStr, nickname);
        this._addKeyToMemory(keyStr, nickname);
        return { success: true };
    }

    async removeKey(keyStr) {
        this.keys.delete(keyStr);
        await supabase.from('system_api_keys').delete().eq('key_value', keyStr);
        return { success: true };
    }

    async reviveKey(keyStr) {
        const k = this.keys.get(keyStr);
        if (k) {
            k.status = 'idle';
            k.fails = 0;
            this._syncKeyStats(keyStr, { status: 'active', fails_count: 0 });
            return { success: true };
        }
        return { success: false };
    }
}

const instance = new KeyManager();
module.exports = instance;
