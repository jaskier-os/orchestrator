import { ObjectId } from 'mongodb';

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
   * Create a new todo at the top of the list (order 0).
   * @param {string} text
   * @returns {Promise<Object>} Created todo with string id
   */
  async create(text) {
    const now = new Date();
    // Push all existing tasks down by 1
    await this.collection.updateMany({}, { $inc: { order: 1 } });
    const doc = {
      text,
      completed: false,
      priority: 'primary',
      order: 0,
      createdAt: now,
      updatedAt: now
    };
    const result = await this.collection.insertOne(doc);
    return { ...doc, id: result.insertedId.toString() };
  }

  /**
   * Update a todo by id.
   * @param {string} id
   * @param {Object} fields - Fields to update (text, completed, priority)
   * @returns {Promise<Object|null>} Updated todo or null
   */
  async update(id, fields) {
    if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
      throw new Error(`Invalid todo id: "${id}" (expected 24-char hex string)`);
    }
    const setFields = { ...fields, updatedAt: new Date() };
    const result = await this.collection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: setFields },
      { returnDocument: 'after' }
    );
    if (!result) return null;
    return { ...result, id: result._id.toString() };
  }

  /**
   * Move a task to a new position in the list.
   * @param {string} id
   * @param {number} position - Target 0-based index
   * @returns {Promise<Object>} Moved todo
   */
  async move(id, position) {
    if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
      throw new Error(`Invalid todo id: "${id}" (expected 24-char hex string)`);
    }
    const docs = await this.collection.find().sort({ order: 1 }).toArray();
    if (docs.length === 0) throw new Error('No tasks to reorder');

    const currentIndex = docs.findIndex(d => d._id.toString() === id);
    if (currentIndex === -1) throw new Error(`Task not found: ${id}`);

    const targetPos = Math.max(0, Math.min(position, docs.length - 1));
    const [moved] = docs.splice(currentIndex, 1);
    docs.splice(targetPos, 0, moved);

    const bulk = docs.map((doc, i) => ({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { order: i, updatedAt: new Date() } }
      }
    }));
    await this.collection.bulkWrite(bulk);

    return { ...moved, id: moved._id.toString(), order: targetPos };
  }

  /**
   * Remove a todo by id and recompact order values.
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async remove(id) {
    if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
      throw new Error(`Invalid todo id: "${id}" (expected 24-char hex string)`);
    }
    const result = await this.collection.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 1) {
      // Recompact order values
      const docs = await this.collection.find().sort({ order: 1 }).toArray();
      if (docs.length > 0) {
        const bulk = docs.map((doc, i) => ({
          updateOne: {
            filter: { _id: doc._id },
            update: { $set: { order: i } }
          }
        }));
        await this.collection.bulkWrite(bulk);
      }
    }
    return result.deletedCount === 1;
  }
}
