import { DEFAULT_ORCHESTRATOR_MODE } from './permission-mode.js';

export class RcStore {
  /**
   * @param {import('mongodb').Db} db
   */
  constructor(db) {
    this.collection = db.collection('rc_sessions');
  }

  /**
   * Create indexes (call once after construction).
   */
  async init() {
    await this.collection.createIndex({ sessionId: 1 }, { unique: true });
    await this.collection.createIndex({ status: 1, createdAt: -1 });
  }

  /**
   * Create or reattach an active RC session. Upserts on sessionId so a desktop
   * reconnecting to the same sessionId after an orchestrator pod restart no
   * longer collides with the unique index. Preserves transcript and
   * pendingQueue when a doc already exists; only resets status/workDir/
   * endedAt so the session is "active" again from the orchestrator's POV.
   * @param {string} sessionId
   * @param {string|null} workDir
   * @param {string} [permissionMode] orchestrator-side mode name
   * @returns {Promise<Object>}
   */
  async create(sessionId, workDir = null, permissionMode = DEFAULT_ORCHESTRATOR_MODE) {
    const now = new Date();
    const result = await this.collection.findOneAndUpdate(
      { sessionId },
      {
        $set: { workDir, status: 'active', endedAt: null, updatedAt: now },
        $setOnInsert: {
          sessionId,
          permissionMode,
          transcript: [],
          pendingQueue: [],
          createdAt: now
        }
      },
      { upsert: true, returnDocument: 'after' }
    );
    return result;
  }

  /**
   * Get a session by sessionId.
   * @param {string} sessionId
   * @returns {Promise<Object|null>}
   */
  async get(sessionId) {
    return this.collection.findOne({ sessionId });
  }

  /**
   * List all active sessions, newest first.
   * @returns {Promise<Array>}
   */
  async listActive() {
    return this.collection.find({ status: 'active' }).sort({ createdAt: -1 }).toArray();
  }

  /**
   * List all sessions, newest first.
   * @returns {Promise<Array>}
   */
  async listRecent() {
    return this.collection.find().sort({ updatedAt: -1 }).toArray();
  }

  /**
   * List recent sessions with optional filters and pagination.
   * @param {{ workDir?: string, limit?: number, offset?: number }} filters
   * @returns {Promise<{ sessions: Array, total: number }>}
   */
  async listRecentFiltered(filters = {}) {
    const query = {};
    if (filters.workDir) query.workDir = filters.workDir;
    const total = await this.collection.countDocuments(query);
    // Project out the heavy fields. The chats list view only needs the
    // summary columns (id/title/status/workDir/timestamps); transcript can
    // run into hundreds of KB per session and used to balloon a 50-row
    // response to ~2 MB, which times out on flaky mobile cells. Detail
    // views fetch the transcript via /sessions/:id/transcript on demand.
    const sessions = await this.collection.find(query, {
      projection: { transcript: 0, pendingQueue: 0 }
    })
      .sort({ updatedAt: -1 })
      .skip(filters.offset || 0)
      .limit(filters.limit || 50)
      .toArray();
    return { sessions, total };
  }

  /**
   * Get distinct workDir values from recent sessions.
   * @returns {Promise<Array<string>>}
   */
  async getDistinctWorkDirs() {
    return this.collection.distinct('workDir');
  }

  /**
   * Search sessions by title and transcript content.
   * @param {string} query
   * @param {{ limit?: number, offset?: number }} opts
   * @returns {Promise<{ sessions: Array, total: number }>}
   */
  async searchSessions(query, { limit = 50, offset = 0 } = {}) {
    const q = query.toLowerCase();
    const all = await this.collection.find()
      .sort({ updatedAt: -1 })
      .toArray();

    const matched = all.filter(doc => {
      if (doc.title && doc.title.toLowerCase().includes(q)) return true;
      if (doc.workDir && doc.workDir.toLowerCase().includes(q)) return true;
      if (Array.isArray(doc.transcript)) {
        return doc.transcript.some(entry => {
          const text = entry.data?.text;
          return text && typeof text === 'string' && text.toLowerCase().includes(q);
        });
      }
      return false;
    });

    // Strip heavy fields before returning -- the search query needed the
    // transcript to match against, but the response shape mirrors the
    // list endpoint and only the summary columns are rendered.
    const slim = matched.slice(offset, offset + limit).map(doc => {
      const { transcript, pendingQueue, ...rest } = doc;
      return rest;
    });
    return {
      sessions: slim,
      total: matched.length
    };
  }

  /**
   * Reactivate an ended session.
   * @param {string} sessionId
   * @returns {Promise<Object|null>}
   */
  async reactivate(sessionId) {
    const result = await this.collection.findOneAndUpdate(
      { sessionId, status: 'ended' },
      { $set: { status: 'active', endedAt: null, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    return result;
  }

  /**
   * Append an entry to the session transcript.
   * @param {string} sessionId
   * @param {{ ts: string, type: string, data: Object }} entry
   * @returns {Promise<Object|null>}
   */
  async appendTranscript(sessionId, entry) {
    const result = await this.collection.findOneAndUpdate(
      { sessionId },
      {
        $push: { transcript: { $each: [entry], $slice: -1000 } },
        $set: { updatedAt: new Date() }
      },
      { returnDocument: 'after' }
    );
    return result;
  }

  /**
   * Append a message to the pending queue.
   * @param {string} sessionId
   * @param {Object} message
   * @returns {Promise<Object|null>}
   */
  async appendPendingQueue(sessionId, message) {
    const result = await this.collection.findOneAndUpdate(
      { sessionId },
      { $push: { pendingQueue: { ts: new Date().toISOString(), message } }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    return result;
  }

  /**
   * Atomically read and clear the pending queue.
   * @param {string} sessionId
   * @returns {Promise<Array>}
   */
  async drainPendingQueue(sessionId) {
    const result = await this.collection.findOneAndUpdate(
      { sessionId },
      { $set: { pendingQueue: [], updatedAt: new Date() } },
      { returnDocument: 'before' }
    );
    return result ? result.pendingQueue : [];
  }

  /**
   * End a session.
   * @param {string} sessionId
   * @returns {Promise<Object|null>}
   */
  async end(sessionId) {
    const now = new Date();
    const result = await this.collection.findOneAndUpdate(
      { sessionId },
      { $set: { status: 'ended', endedAt: now, updatedAt: now } },
      { returnDocument: 'after' }
    );
    return result;
  }

  /**
   * End all active sessions whose updatedAt is older than timeoutMs.
   * Handles zombie sessions left behind when desktop WS disconnects
   * (session stays "active" in DB for reattach, but the in-memory
   * timer is lost). Safe to call on startup and periodically.
   * @param {number} timeoutMs
   * @returns {Promise<number>} count of sessions ended
   */
  async endStaleSessions(timeoutMs) {
    const cutoff = new Date(Date.now() - timeoutMs);
    const result = await this.collection.updateMany(
      { status: 'active', updatedAt: { $lt: cutoff } },
      { $set: { status: 'ended', endedAt: new Date(), updatedAt: new Date() } }
    );
    return result.modifiedCount;
  }

  /**
   * Update the title for a session (first assistant response).
   * @param {string} sessionId
   * @param {string} title
   * @returns {Promise<Object|null>}
   */
  async updateTitle(sessionId, title) {
    const result = await this.collection.findOneAndUpdate(
      { sessionId },
      { $set: { title, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    return result;
  }

  /**
   * Update the permission mode for a session.
   * @param {string} sessionId
   * @param {string} mode
   * @returns {Promise<Object|null>}
   */
  async updatePermissionMode(sessionId, mode) {
    const result = await this.collection.findOneAndUpdate(
      { sessionId },
      { $set: { permissionMode: mode, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    return result;
  }

  /**
   * Get the transcript array only for a session.
   * @param {string} sessionId
   * @returns {Promise<Array>}
   */
  async getTranscript(sessionId) {
    const doc = await this.collection.findOne({ sessionId }, { projection: { transcript: 1 } });
    return doc ? doc.transcript : [];
  }

  /**
   * Persist a pending permission request so it survives orchestrator restarts.
   * @param {string} sessionId
   * @param {string} requestId
   * @param {{ toolName: string, toolArgs: Object, description: string|null, requestId: string }} data
   */
  async persistPermission(sessionId, requestId, data) {
    await this.collection.updateOne(
      { sessionId },
      {
        $set: {
          [`pendingPermissions.${requestId}`]: { ...data, createdAt: new Date().toISOString() },
          updatedAt: new Date()
        }
      }
    );
  }

  /**
   * Remove a resolved pending permission.
   * @param {string} sessionId
   * @param {string} requestId
   */
  async removePermission(sessionId, requestId) {
    await this.collection.updateOne(
      { sessionId },
      {
        $unset: { [`pendingPermissions.${requestId}`]: '' },
        $set: { updatedAt: new Date() }
      }
    );
  }

  /**
   * Get all persisted pending permissions for a session.
   * @param {string} sessionId
   * @returns {Promise<Object>} Map of requestId -> permission data
   */
  async getPermissions(sessionId) {
    const doc = await this.collection.findOne(
      { sessionId },
      { projection: { pendingPermissions: 1 } }
    );
    return doc?.pendingPermissions || {};
  }

  /**
   * Backfill titles on sessions that were never titled. Walks each session's
   * transcript looking for the first usable text chunk -- prefers a
   * user_message entry, falls back to the first rc_message text. Updates
   * `title` in-place. Idempotent: skips sessions that already have a title.
   * @returns {Promise<{scanned:number, updated:number}>}
   */
  async backfillMissingTitles() {
    const cursor = this.collection.find(
      { $or: [{ title: { $exists: false } }, { title: null }, { title: '' }] },
      { projection: { sessionId: 1, transcript: 1 } }
    );
    let scanned = 0;
    let updated = 0;
    for await (const doc of cursor) {
      scanned++;
      const transcript = Array.isArray(doc.transcript) ? doc.transcript : [];
      let chosen = null;
      // Pass 1: prefer user_message entries.
      for (const entry of transcript) {
        const t = entry?.data?.text;
        if (entry?.type === 'user_message' && typeof t === 'string' && t.trim().length > 0) {
          chosen = t.trim();
          break;
        }
      }
      // Pass 2: fall back to first rc_message text.
      if (!chosen) {
        for (const entry of transcript) {
          const t = entry?.data?.text;
          if (entry?.type === 'rc_message' && typeof t === 'string' && t.trim().length > 0) {
            chosen = t.trim();
            break;
          }
        }
      }
      if (chosen) {
        await this.updateTitle(doc.sessionId, chosen.substring(0, 80)).catch(() => {});
        updated++;
      }
    }
    return { scanned, updated };
  }
}
