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
   * Append a turn to an existing conversation.
   * @param {string} conversationId
   * @param {object} turn
   * @param {string} turn.requestId
   * @param {string} [turn.userText]
   * @param {string} [turn.userImage] - base64 image or null
   * @param {object} [turn.classification]
   * @param {object} turn.response
   * @param {object} [turn.usage]
   * @returns {Promise<void>}
   */
  async appendTurn(conversationId, turn, metadata) {
    let entry = this.index.get(conversationId);
    if (!entry) {
      if (metadata?.deviceId) {
        console.log(`[chat-store] Auto-creating conversation ${conversationId} for device ${metadata.deviceId}`);
        await this.createConversation({ id: conversationId, deviceId: metadata.deviceId, deviceType: metadata.deviceType || 'unknown' });
        entry = this.index.get(conversationId);
      }
      if (!entry) {
        console.error(`[chat-store] Cannot append turn: conversation ${conversationId} not found`);
        return;
      }
    }

    const now = new Date().toISOString();
    const line = {
      type: 'turn',
      ts: now,
      requestId: turn.requestId,
      userText: turn.userText || null,
      userImage: turn.userImage || null,
      classification: turn.classification || null,
      response: turn.response || null,
      usage: turn.usage || null,
      toolCalls: turn.toolCalls || null
    };

    const fullPath = path.join(this.dataDir, entry.path);
    await fs.appendFile(fullPath, JSON.stringify(line) + '\n');

    this._recordTurnInIndex(entry, now, {
      firstUserMessage: turn.userText,
      agentId: turn.response?.agentId
    });
  }

  /**
   * Append a raw, caller-shaped turn line to an existing conversation without
   * imposing the normal-chat turn schema. Used by feature stores (e.g. copilot)
   * that persist their own turn fields. Index bookkeeping is shared with
   * appendTurn via _recordTurnInIndex so there is no duplication.
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
   * appendTurn and appendRawTurn from duplicating the index update logic.
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
            entry.turnCount++;
            entry.lastActivityAt = line.ts;
            if (!entry.firstUserMessage && line.userText) {
              entry.firstUserMessage = line.userText.substring(0, 200);
            }
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
      const turns = events.filter(e => e.type === 'turn');
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
          if (parsed.type !== 'turn') continue;
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
