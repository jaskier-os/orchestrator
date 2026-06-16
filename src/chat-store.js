/**
 * ChatStore - persists conversations as NDJSON files with a lightweight JSON index.
 *
 * Directory structure:
 *   <dataDir>/
 *     index.json
 *     2026/02/22/<uuid>.ndjson
 *
 * Each NDJSON file contains:
 *   {"type":"header","id":"...","deviceId":"...","deviceType":"...","startedAt":"..."}
 *   {"type":"turn","ts":"...","requestId":"...","userText":"...","userImage":null,...}
 *   {"type":"close","ts":"...","reason":"timeout|shutdown"}
 */

import fs from 'fs/promises';
import path from 'path';

export class ChatStore {
  /**
   * @param {string} dataDir - Root directory for chat history data
   */
  constructor(dataDir) {
    this.dataDir = dataDir;
    /** @type {Map<string, object>} id -> metadata */
    this.index = new Map();
    this.indexPath = path.join(dataDir, 'index.json');
    this.saveTimer = null;
    this.saveDebounceMs = 5000;
    /**
     * Idempotency guard for beginTurn: "<conversationId>:<requestId>" keys that
     * already have a pending turn written this process. A transport-level resend
     * reuses its requestId, so the second beginTurn is skipped (no duplicate
     * user turn, no double turnCount). Pruned in completeTurn. Transient by
     * design: the resend window is milliseconds, far shorter than process life.
     * @type {Set<string>}
     */
    this.begunRequests = new Set();
  }

  /**
   * Initialize: ensure directories exist, load or rebuild index.
   */
  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });

    try {
      const raw = await fs.readFile(this.indexPath, 'utf-8');
      const entries = JSON.parse(raw);
      for (const entry of entries) {
        this.index.set(entry.id, entry);
      }
      console.log(`[chat-store] Loaded index with ${this.index.size} conversations`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log('[chat-store] No existing index, starting fresh');
      } else {
        console.error('[chat-store] Index corrupt or unreadable, rebuilding:', err.message);
        await this.rebuildIndex();
      }
    }
  }

  /**
   * Create a new conversation.
   * @param {object} metadata
   * @param {string} metadata.id - Conversation UUID
   * @param {string} metadata.deviceId
   * @param {string} metadata.deviceType
   * @param {string} [metadata.previousConversationId] - Links to prior conversation (compaction chain)
   * @returns {Promise<void>}
   */
  async createConversation({ id, deviceId, deviceType, previousConversationId }) {
    const now = new Date();
    const datePath = this.getDatePath(now);
    const dir = path.join(this.dataDir, datePath);
    await fs.mkdir(dir, { recursive: true });

    const filePath = path.join(datePath, `${id}.ndjson`);
    const fullPath = path.join(this.dataDir, filePath);

    const header = {
      type: 'header',
      id,
      deviceId,
      deviceType,
      startedAt: now.toISOString()
    };
    if (previousConversationId) {
      header.previousConversationId = previousConversationId;
    }

    await fs.appendFile(fullPath, JSON.stringify(header) + '\n');

    const indexEntry = {
      id,
      deviceId,
      deviceType,
      startedAt: now.toISOString(),
      lastActivityAt: now.toISOString(),
      turnCount: 0,
      closed: false,
      firstUserMessage: null,
      agents: [],
      path: filePath
    };
    if (previousConversationId) {
      indexEntry.previousConversationId = previousConversationId;
    }

    this.index.set(id, indexEntry);
    this.scheduleSave();

    console.log(`[chat-store] Created conversation ${id} for device ${deviceId}`);
  }

  /**
   * Resolve a conversation's index entry, auto-creating the conversation if it
   * does not exist yet (and device metadata is available). Returns null if the
   * conversation cannot be resolved or created.
   * @param {string} conversationId
   * @param {object} [metadata]
   * @returns {Promise<object|null>}
   */
  async _resolveEntry(conversationId, metadata) {
    let entry = this.index.get(conversationId);
    if (!entry && metadata?.deviceId) {
      console.log(`[chat-store] Auto-creating conversation ${conversationId} for device ${metadata.deviceId}`);
      await this.createConversation({ id: conversationId, deviceId: metadata.deviceId, deviceType: metadata.deviceType || 'unknown' });
      entry = this.index.get(conversationId);
    }
    return entry || null;
  }

  /**
   * Persist the user half of a turn immediately, before the AI has responded.
   * Writes a pending turn line (response: null) keyed by requestId so a client
   * that reopens the conversation mid-flight still sees its own prompt. The
   * matching response is appended later by completeTurn() and merged on read.
   * @param {string} conversationId
   * @param {object} turn
   * @param {string} turn.requestId
   * @param {string} [turn.userText]
   * @param {string} [turn.userImage] - base64 image or null
   * @param {object} [metadata]
   * @returns {Promise<void>}
   */
  async beginTurn(conversationId, turn, metadata) {
    const entry = await this._resolveEntry(conversationId, metadata);
    if (!entry) {
      console.error(`[chat-store] Cannot begin turn: conversation ${conversationId} not found`);
      return;
    }

    // Idempotency: skip a duplicate begin for the same requestId (transport
    // resend). The first begin already wrote the pending turn + bumped the count.
    const guardKey = turn.requestId ? `${conversationId}:${turn.requestId}` : null;
    if (guardKey && this.begunRequests.has(guardKey)) {
      console.log(`[chat-store] Skipping duplicate beginTurn for ${guardKey}`);
      return;
    }
    if (guardKey) this.begunRequests.add(guardKey);

    const now = new Date().toISOString();
    const line = {
      type: 'turn',
      ts: now,
      requestId: turn.requestId,
      userText: turn.userText || null,
      userImage: turn.userImage || null,
      classification: null,
      response: null,
      usage: null,
      toolCalls: null
    };

    const fullPath = path.join(this.dataDir, entry.path);
    await fs.appendFile(fullPath, JSON.stringify(line) + '\n');

    this._recordTurnInIndex(entry, now, { firstUserMessage: turn.userText });
  }

  /**
   * Persist the response half of a turn once the AI has finished. Appends a
   * turn_response line keyed by the same requestId as the earlier beginTurn();
   * getConversationTurns()/rebuildIndex() fold it into the pending turn. Does
   * NOT bump turnCount (beginTurn already did). If no prior beginTurn was
   * written (legacy / direct callers), the merge still emits a standalone turn.
   * @param {string} conversationId
   * @param {object} turn
   * @param {string} turn.requestId
   * @param {object} [turn.classification]
   * @param {object} turn.response
   * @param {object} [turn.usage]
   * @param {Array} [turn.toolCalls]
   * @param {object} [metadata]
   * @returns {Promise<void>}
   */
  async completeTurn(conversationId, turn, metadata) {
    const entry = await this._resolveEntry(conversationId, metadata);
    if (!entry) {
      console.error(`[chat-store] Cannot complete turn: conversation ${conversationId} not found`);
      return;
    }

    const now = new Date().toISOString();
    const line = {
      type: 'turn_response',
      ts: now,
      requestId: turn.requestId,
      classification: turn.classification || null,
      response: turn.response || null,
      usage: turn.usage || null,
      toolCalls: turn.toolCalls || null
    };

    const fullPath = path.join(this.dataDir, entry.path);
    await fs.appendFile(fullPath, JSON.stringify(line) + '\n');

    // Response only advances activity + agent tracking; the turn was already
    // counted by beginTurn so turnCount must not increase here.
    entry.lastActivityAt = now;
    const agentId = turn.response?.agentId;
    if (agentId && !entry.agents.includes(agentId)) {
      entry.agents.push(agentId);
    }
    if (turn.requestId) this.begunRequests.delete(`${conversationId}:${turn.requestId}`);
    this.scheduleSave();
  }

  /**
   * Append a raw, caller-shaped turn line to an existing conversation without
   * imposing the normal-chat turn schema. Used by feature stores (e.g. copilot)
   * that persist their own turn fields. Index bookkeeping is shared with
   * beginTurn via _recordTurnInIndex so there is no duplication.
   * @param {string} conversationId
   * @param {object} turnObj - arbitrary turn fields (merged after {type:'turn'})
   * @returns {Promise<void>}
   */
  async appendRawTurn(conversationId, turnObj) {
    const entry = this.index.get(conversationId);
    if (!entry) {
      console.error(`[chat-store] Cannot append raw turn: conversation ${conversationId} not found`);
      return;
    }

    const now = new Date().toISOString();
    const line = { type: 'turn', ...turnObj };

    const fullPath = path.join(this.dataDir, entry.path);
    await fs.appendFile(fullPath, JSON.stringify(line) + '\n');

    // Derive a title/first-line for the index from the copilot turn shape so the
    // list endpoint stays O(1) and never has to read files. interlocutorText is
    // preferred (it is what the wearer is reacting to), then wearerText.
    const firstLine = (typeof turnObj.interlocutorText === 'string' && turnObj.interlocutorText.trim())
      ? turnObj.interlocutorText
      : (typeof turnObj.wearerText === 'string' ? turnObj.wearerText : null);

    this._recordTurnInIndex(entry, now, { firstUserMessage: firstLine });
  }

  /**
   * Shared index bookkeeping for any appended turn: bump turnCount, advance
   * lastActivityAt, capture the first user-facing line, and track agents. Keeps
   * beginTurn and appendRawTurn from duplicating the index update logic.
   * @param {object} entry - index entry to mutate
   * @param {string} now - ISO timestamp of the turn
   * @param {object} [meta]
   * @param {string} [meta.firstUserMessage] - candidate first-line text
   * @param {string} [meta.agentId] - agent that produced the turn
   */
  _recordTurnInIndex(entry, now, { firstUserMessage, agentId } = {}) {
    entry.lastActivityAt = now;
    entry.turnCount++;
    if (!entry.firstUserMessage && firstUserMessage) {
      entry.firstUserMessage = firstUserMessage.substring(0, 200);
    }
    if (agentId && !entry.agents.includes(agentId)) {
      entry.agents.push(agentId);
    }
    this.scheduleSave();
  }

  /**
   * Close a conversation.
   * @param {string} conversationId
   * @param {string} reason - "timeout" | "shutdown" | "compacted" | "replaced"
   * @returns {Promise<void>}
   */
  async closeConversation(conversationId, reason) {
    const entry = this.index.get(conversationId);
    if (!entry) return;
    if (entry.closed) return;

    const now = new Date().toISOString();
    const line = { type: 'close', ts: now, reason };

    const fullPath = path.join(this.dataDir, entry.path);
    try {
      await fs.appendFile(fullPath, JSON.stringify(line) + '\n');
    } catch (err) {
      console.error(`[chat-store] Failed to write close line for ${conversationId}:`, err.message);
    }

    entry.closed = true;
    entry.lastActivityAt = now;
    this.scheduleSave();

    console.log(`[chat-store] Closed conversation ${conversationId} (${reason})`);
  }


  /**
   * Close all open conversations whose lastActivityAt is older than timeoutMs.
   * Handles orphans left by unclean shutdowns (crash, SIGKILL, OOM).
   * @param {number} timeoutMs
   * @returns {Promise<number>} count of conversations closed
   */
  async closeStaleConversations(timeoutMs) {
    const cutoff = Date.now() - timeoutMs;
    let closed = 0;
    for (const entry of this.index.values()) {
      if (entry.closed) continue;
      if (new Date(entry.lastActivityAt).getTime() < cutoff) {
        await this.closeConversation(entry.id, 'stale');
        closed++;
      }
    }
    return closed;
  }

  /**
   * Debounced index save.
   */
  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      await this.saveIndex();
    }, this.saveDebounceMs);
  }

  /**
   * Persist index to disk.
   */
  async saveIndex() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    const entries = Array.from(this.index.values());
    const tmp = this.indexPath + '.tmp';
    try {
      await fs.writeFile(tmp, JSON.stringify(entries, null, 2));
      await fs.rename(tmp, this.indexPath);
    } catch (err) {
      console.error('[chat-store] Failed to save index:', err.message);
    }
  }

  /**
   * Rebuild index by scanning all NDJSON files.
   */
  async rebuildIndex() {
    console.log('[chat-store] Rebuilding index from NDJSON files...');
    this.index.clear();

    const ndjsonFiles = await this.findNdjsonFiles(this.dataDir);

    for (const filePath of ndjsonFiles) {
      try {
        const relativePath = path.relative(this.dataDir, filePath);
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);

        if (lines.length === 0) continue;

        const header = JSON.parse(lines[0]);
        if (header.type !== 'header') continue;

        const entry = {
          id: header.id,
          deviceId: header.deviceId,
          deviceType: header.deviceType,
          startedAt: header.startedAt,
          lastActivityAt: header.startedAt,
          turnCount: 0,
          closed: false,
          firstUserMessage: null,
          agents: [],
          path: relativePath
        };
        if (header.previousConversationId) {
          entry.previousConversationId = header.previousConversationId;
        }

        for (let i = 1; i < lines.length; i++) {
          const line = JSON.parse(lines[i]);
          if (line.type === 'turn') {
            // turnCount tracks user turns; the paired turn_response (if any) is
            // counted via its turn line, never on its own.
            entry.turnCount++;
            entry.lastActivityAt = line.ts;
            if (!entry.firstUserMessage && line.userText) {
              entry.firstUserMessage = line.userText.substring(0, 200);
            }
            if (line.response?.agentId && !entry.agents.includes(line.response.agentId)) {
              entry.agents.push(line.response.agentId);
            }
          } else if (line.type === 'turn_response') {
            entry.lastActivityAt = line.ts;
            if (line.response?.agentId && !entry.agents.includes(line.response.agentId)) {
              entry.agents.push(line.response.agentId);
            }
          } else if (line.type === 'close') {
            entry.closed = true;
            entry.lastActivityAt = line.ts;
          }
        }

        this.index.set(entry.id, entry);
      } catch (err) {
        console.error(`[chat-store] Failed to parse ${filePath}:`, err.message);
      }
    }

    console.log(`[chat-store] Rebuilt index: ${this.index.size} conversations`);
    await this.saveIndex();
  }

  /**
   * List conversations sorted by lastActivityAt descending. Pure in-memory, no disk reads.
   * @param {object} [opts]
   * @param {number} [opts.limit=50]
   * @param {number} [opts.offset=0]
   * @returns {{ conversations: object[], total: number, offset: number, limit: number }}
   */
  listConversations({ limit = 50, offset = 0 } = {}) {
    const sorted = Array.from(this.index.values())
      .sort((a, b) => new Date(b.lastActivityAt) - new Date(a.lastActivityAt));

    return {
      conversations: sorted.slice(offset, offset + limit),
      total: sorted.length,
      offset,
      limit
    };
  }

  /**
   * Read a conversation's NDJSON file and return metadata + parsed turns.
   * @param {string} conversationId
   * @returns {Promise<object|null>}
   */
  async getConversationTurns(conversationId) {
    const entry = this.index.get(conversationId);
    if (!entry) return null;

    try {
      const fullPath = path.join(this.dataDir, entry.path);
      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      const events = lines.map(line => JSON.parse(line));

      const header = events.find(e => e.type === 'header');
      const turns = mergeTurnEvents(events);
      const close = events.find(e => e.type === 'close');

      return {
        ...entry,
        header,
        turns,
        close: close || null
      };
    } catch (err) {
      console.error(`[chat-store] Failed to read conversation ${conversationId}:`, err.message);
      return null;
    }
  }

  /**
   * Reopen a closed conversation so new turns can be appended.
   * @param {string} conversationId
   * @returns {boolean} true if reopened, false if not found
   */
  reopenConversation(conversationId) {
    const entry = this.index.get(conversationId);
    if (!entry) return false;
    entry.closed = false;
    this.scheduleSave();
    return true;
  }

  /**
   * Search conversations by query string.
   * Phase 1: Filter in-memory index by firstUserMessage (case-insensitive substring).
   * Phase 2: For non-matching conversations, scan NDJSON files for content matches.
   * @param {string} query
   * @param {object} [opts]
   * @param {number} [opts.limit=50]
   * @param {number} [opts.offset=0]
   * @returns {Promise<{ conversations: object[], total: number, offset: number, limit: number }>}
   */
  async searchConversations(query, { limit = 50, offset = 0 } = {}) {
    const q = query.toLowerCase();
    const matched = new Map();

    // Phase 1: index scan (firstUserMessage)
    for (const entry of this.index.values()) {
      if (entry.firstUserMessage && entry.firstUserMessage.toLowerCase().includes(q)) {
        matched.set(entry.id, entry);
      }
    }

    // Phase 2: content scan for conversations not matched by title
    for (const entry of this.index.values()) {
      if (matched.has(entry.id)) continue;
      try {
        const fullPath = path.join(this.dataDir, entry.path);
        const content = await fs.readFile(fullPath, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);
        for (const line of lines) {
          const parsed = JSON.parse(line);
          // userText lives on `turn` lines; response.text may live on either a
          // legacy `turn` line or a two-phase `turn_response` line.
          if (parsed.type !== 'turn' && parsed.type !== 'turn_response') continue;
          const userMatch = parsed.userText && parsed.userText.toLowerCase().includes(q);
          const respMatch = parsed.response?.text && parsed.response.text.toLowerCase().includes(q);
          if (userMatch || respMatch) {
            matched.set(entry.id, entry);
            break;
          }
        }
      } catch {
        // skip unreadable files
      }
    }

    const sorted = Array.from(matched.values())
      .sort((a, b) => new Date(b.lastActivityAt) - new Date(a.lastActivityAt));

    return {
      conversations: sorted.slice(offset, offset + limit),
      total: sorted.length,
      offset,
      limit
    };
  }

  /**
   * Delete a conversation: remove from index and delete NDJSON file.
   * @param {string} conversationId
   * @returns {Promise<boolean>} true if found and deleted
   */
  async deleteConversation(conversationId) {
    const entry = this.index.get(conversationId);
    if (!entry) return false;

    // Delete NDJSON file
    try {
      const fullPath = path.join(this.dataDir, entry.path);
      await fs.unlink(fullPath);
    } catch (err) {
      console.error(`[chat-store] Failed to delete file for ${conversationId}:`, err.message);
    }

    this.index.delete(conversationId);
    this.scheduleSave();
    console.log(`[chat-store] Deleted conversation ${conversationId}`);
    return true;
  }

  /**
   * Recursively find all .ndjson files under a directory.
   * @param {string} dir
   * @returns {Promise<string[]>}
   */
  async findNdjsonFiles(dir) {
    const results = [];
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return results;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const nested = await this.findNdjsonFiles(fullPath);
        results.push(...nested);
      } else if (entry.name.endsWith('.ndjson')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  /**
   * Get date-based path segment: YYYY/MM/DD
   * @param {Date} date
   * @returns {string}
   */
  getDatePath(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}/${m}/${d}`;
  }
}

/**
 * Fold a conversation's raw NDJSON events into client-facing turns. A turn is
 * persisted in two phases: a `turn` line (user half, written at request start)
 * and a later `turn_response` line (AI half) sharing the same requestId. This
 * merges them into one object preserving file order, so a turn whose response
 * has not arrived yet surfaces with response: null (a pending turn the client
 * renders as "thinking"). A `turn_response` with no preceding `turn` (legacy or
 * direct completeTurn callers) becomes a standalone turn.
 * @param {object[]} events - parsed NDJSON lines in file order
 * @returns {object[]} merged turns in original order
 */
export function mergeTurnEvents(events) {
  const turns = [];
  const byRequestId = new Map();

  for (const e of events) {
    if (e.type === 'turn') {
      // Collapse a duplicate pending turn for the same requestId (a transport
      // resend that slipped past the in-process begin guard, e.g. across a
      // restart). The existing pending turn is the merge target; drop the dup.
      if (e.requestId && byRequestId.has(e.requestId)) {
        continue;
      }
      const turn = {
        type: 'turn',
        ts: e.ts,
        requestId: e.requestId,
        userText: e.userText ?? null,
        userImage: e.userImage ?? null,
        classification: e.classification ?? null,
        response: e.response ?? null,
        usage: e.usage ?? null,
        toolCalls: e.toolCalls ?? null
      };
      turns.push(turn);
      // Only index pending turns (no response yet) as merge targets. A turn
      // already carrying a response is a completed legacy turn; a later stray
      // turn_response with the same id must not overwrite it.
      if (turn.response == null && turn.requestId) {
        byRequestId.set(turn.requestId, turn);
      }
    } else if (e.type === 'turn_response') {
      const pending = e.requestId ? byRequestId.get(e.requestId) : null;
      if (pending) {
        pending.ts = e.ts ?? pending.ts;
        pending.classification = e.classification ?? null;
        pending.response = e.response ?? null;
        pending.usage = e.usage ?? null;
        pending.toolCalls = e.toolCalls ?? null;
        byRequestId.delete(e.requestId);
      } else {
        // Orphan response (no matching pending turn): surface standalone so the
        // AI text is never silently dropped.
        turns.push({
          type: 'turn',
          ts: e.ts,
          requestId: e.requestId,
          userText: null,
          userImage: null,
          classification: e.classification ?? null,
          response: e.response ?? null,
          usage: e.usage ?? null,
          toolCalls: e.toolCalls ?? null
        });
      }
    }
  }

  return turns;
}
