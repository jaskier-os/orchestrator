import { ObjectId } from 'mongodb';

export const TRACK_COLORS = ['red', 'green', 'yellow', 'blue', 'purple', 'aqua', 'orange', 'gray'];
const DEFAULT_TRACK = { name: 'Other', color: 'gray' };

function assertId(id, what) {
  if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
    throw new Error(`Invalid ${what} id: "${id}" (expected 24-char hex string)`);
  }
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function withId(doc) { return { ...doc, id: doc._id.toString() }; }

// Default tasks written once on a fresh install so the list is never empty on
// first run. Order matters: index 0 ends up at the top (order 0, newest createdAt).
const SEED_TASKS = [
  'finish glasses HUD review',
  'reply to ana re: contract',
  'reorder beans @ blue bottle',
  'pay parking ticket',
  'plan napa trip',
  'gym 2x this week',
  'read CRDT paper'
];

export class TodoStore {
  /**
   * @param {import('mongodb').Db} db
   */
  constructor(db) {
    this.collection = db.collection('todos');
    this.metaCollection = db.collection('todos_meta');
    this.tracks = db.collection('tracks');
  }

  /**
   * Startup migration: guarantee at least one track exists and every todo
   * belongs to one. Idempotent. Runs after ensureOrder().
   */
  async ensureTracks() {
    if (await this.tracks.countDocuments({}) === 0) {
      const now = new Date();
      await this.tracks.insertOne({ ...DEFAULT_TRACK, order: 0, createdAt: now, updatedAt: now });
      console.log('[todo-store] Created default track "Other"');
    }
    const def = await this.defaultTrack();
    const res = await this.collection.updateMany(
      { trackId: { $exists: false } },
      { $set: { trackId: def.id } }
    );
    if (res.modifiedCount > 0) {
      console.log(`[todo-store] Assigned ${res.modifiedCount} tasks to track "${def.name}"`);
      await this.recompact(def.id);
    }
  }

  /** The lowest-order track. */
  async defaultTrack() {
    const doc = await this.tracks.find().sort({ order: 1 }).limit(1).next();
    if (!doc) throw new Error('No tracks exist; call ensureTracks() first');
    return withId(doc);
  }

  async listTracks() {
    const docs = await this.tracks.find().sort({ order: 1 }).toArray();
    return docs.map(withId);
  }

  async findTrackByName(name) {
    if (!name) return null;
    const doc = await this.tracks.findOne({ name: { $regex: `^${escapeRegex(name.trim())}$`, $options: 'i' } });
    return doc ? withId(doc) : null;
  }

  validateTrackFields({ name, color }, partial = false) {
    const out = {};
    if (name !== undefined || !partial) {
      if (typeof name !== 'string' || !name.trim()) throw new Error('Track name must be a non-empty string');
      out.name = name.trim();
    }
    if (color !== undefined || !partial) {
      if (!TRACK_COLORS.includes(color)) throw new Error(`Track color must be one of: ${TRACK_COLORS.join(', ')}`);
      out.color = color;
    }
    return out;
  }

  async createTrack(fields) {
    const clean = this.validateTrackFields(fields);
    const last = await this.tracks.find().sort({ order: -1 }).limit(1).next();
    const now = new Date();
    const doc = { ...clean, order: last ? last.order + 1 : 0, createdAt: now, updatedAt: now };
    const r = await this.tracks.insertOne(doc);
    return { ...doc, id: r.insertedId.toString() };
  }

  async updateTrack(id, fields) {
    assertId(id, 'track');
    const clean = this.validateTrackFields(fields, true);
    const doc = await this.tracks.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { ...clean, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    return doc ? withId(doc) : null;
  }

  async deleteTrack(id) {
    assertId(id, 'track');
    if (await this.tracks.countDocuments({}) <= 1) throw new Error('Cannot delete the last track');
    const n = await this.collection.countDocuments({ trackId: id });
    if (n > 0) throw new Error(`Track has tasks (${n}); move or delete them first`);
    const r = await this.tracks.deleteOne({ _id: new ObjectId(id) });
    return r.deletedCount === 1;
  }

  /** Rewrite order = 0..n-1 for one track, preserving current order. */
  async recompact(trackId) {
    const docs = await this.collection.find({ trackId }).sort({ order: 1, createdAt: -1 }).toArray();
    if (docs.length === 0) return;
    await this.collection.bulkWrite(docs.map((doc, i) => ({
      updateOne: { filter: { _id: doc._id }, update: { $set: { order: i } } }
    })));
  }

  /**
   * Seed a default task set exactly once, the first time this store is ever used.
   * Idempotent: a persisted "seeded" flag in todos_meta guarantees it never runs
   * again, so if the user later deletes every task the list legitimately stays
   * empty (we do not re-seed). No-op if any tasks already exist.
   */
  async seedIfEmpty() {
    const meta = await this.metaCollection.findOne({ _id: 'seed' });
    if (meta && meta.seeded) return;

    const existing = await this.collection.countDocuments({});
    if (existing > 0) {
      // Pre-existing data: mark seeded so we never inject defaults over real tasks.
      await this.metaCollection.updateOne(
        { _id: 'seed' },
        { $set: { seeded: true, seededAt: new Date(), reason: 'pre-existing' } },
        { upsert: true }
      );
      return;
    }

    const base = Date.now();
    // index 0 is top of the list: order 0 and the newest createdAt.
    const docs = SEED_TASKS.map((text, i) => {
      const createdAt = new Date(base + (SEED_TASKS.length - 1 - i));
      return {
        text,
        completed: false,
        priority: 'primary',
        order: i,
        createdAt,
        updatedAt: createdAt
      };
    });
    await this.collection.insertMany(docs);
    await this.metaCollection.updateOne(
      { _id: 'seed' },
      { $set: { seeded: true, seededAt: new Date(), reason: 'fresh' } },
      { upsert: true }
    );
    console.log(`[todo-store] Seeded ${docs.length} default tasks (first run)`);
  }

  /**
   * Assign order values to existing docs that lack them (startup migration).
   * Preserves current createdAt desc ordering.
   */
  async ensureOrder() {
    const count = await this.collection.countDocuments({ order: { $exists: false } });
    if (count === 0) return;
    const docs = await this.collection.find({ order: { $exists: false } }).sort({ createdAt: -1 }).toArray();
    const maxOrder = await this.collection.find({ order: { $exists: true } }).sort({ order: -1 }).limit(1).toArray();
    const startOrder = maxOrder.length > 0 ? maxOrder[0].order + 1 : 0;
    const bulk = docs.map((doc, i) => ({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { order: startOrder + i } }
      }
    }));
    if (bulk.length > 0) await this.collection.bulkWrite(bulk);
    console.log(`[todo-store] Assigned order to ${count} existing tasks`);
  }

  /**
   * List all todos sorted by order ascending.
   * @returns {Promise<Array>}
   */
  async list() {
    const docs = await this.collection.find().sort({ order: 1 }).toArray();
    return docs.map(doc => ({ ...doc, id: doc._id.toString() }));
  }

  /**
   * Create a new todo at the top (order 0) of its track. An unknown or missing
   * trackId falls back to the default track.
   * @param {string} text
   * @param {string} [trackId]
   * @returns {Promise<Object>} Created todo with string id
   */
  async create(text, trackId) {
    if (trackId) assertId(trackId, 'track');
    const track = trackId ? await this.tracks.findOne({ _id: new ObjectId(trackId) }) : null;
    const resolvedTrackId = track ? track._id.toString() : (await this.defaultTrack()).id;
    const now = new Date();
    await this.collection.updateMany({ trackId: resolvedTrackId }, { $inc: { order: 1 } });
    const doc = {
      text,
      completed: false,
      priority: 'primary',
      trackId: resolvedTrackId,
      order: 0,
      createdAt: now,
      updatedAt: now
    };
    const result = await this.collection.insertOne(doc);
    return { ...doc, id: result.insertedId.toString() };
  }

  /**
   * Update a todo by id. trackId is not updatable here; use move().
   * @param {string} id
   * @param {Object} fields - Fields to update (text, completed, priority)
   * @returns {Promise<Object|null>} Updated todo or null
   */
  async update(id, fields) {
    assertId(id, 'todo');
    const { trackId: _ignored, order: _ignoredOrder, ...rest } = fields;
    const setFields = { ...rest, updatedAt: new Date() };
    const result = await this.collection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: setFields },
      { returnDocument: 'after' }
    );
    if (!result) return null;
    return { ...result, id: result._id.toString() };
  }

  /**
   * Move a task to `position` within `trackId` (defaults to its current track).
   * Cross-track moves recompact the source track too.
   * @param {string} id
   * @param {number} position - Target 0-based index within the target track
   * @param {string} [trackId]
   * @returns {Promise<Object>} Moved todo
   */
  async move(id, position, trackId) {
    assertId(id, 'todo');
    const current = await this.collection.findOne({ _id: new ObjectId(id) });
    if (!current) throw new Error(`Task not found: ${id}`);
    const targetTrackId = trackId || current.trackId;
    if (trackId) {
      assertId(trackId, 'track');
      if (!(await this.tracks.findOne({ _id: new ObjectId(trackId) }))) throw new Error(`Track not found: ${trackId}`);
    }
    const docs = (await this.collection.find({ trackId: targetTrackId }).sort({ order: 1 }).toArray())
      .filter(d => d._id.toString() !== id);
    const targetPos = Math.max(0, Math.min(position, docs.length));
    docs.splice(targetPos, 0, current);
    const now = new Date();
    await this.collection.bulkWrite(docs.map((doc, i) => ({
      updateOne: { filter: { _id: doc._id }, update: { $set: { order: i, trackId: targetTrackId, updatedAt: now } } }
    })));
    if (targetTrackId !== current.trackId) await this.recompact(current.trackId);
    return { ...current, id, trackId: targetTrackId, order: targetPos };
  }

  /**
   * Remove a todo by id and recompact its track's order values.
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async remove(id) {
    assertId(id, 'todo');
    const doc = await this.collection.findOneAndDelete({ _id: new ObjectId(id) });
    if (!doc) return false;
    await this.recompact(doc.trackId);
    return true;
  }
}
