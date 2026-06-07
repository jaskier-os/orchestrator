import { ObjectId } from 'mongodb';

export class JobStore {
  /**
   * @param {import('mongodb').Db} db
   */
  constructor(db) {
    this.collection = db.collection('jobs');
  }

  /**
   * List all jobs sorted by scheduledAt descending (newest first).
   * @returns {Promise<Array>}
   */
  async list() {
    const docs = await this.collection.find().sort({ scheduledAt: -1 }).toArray();
    return docs.map(doc => ({ ...doc, id: doc._id.toString() }));
  }

  /**
   * Create a new job.
   * @param {string} name
   * @param {string} prompt
   * @param {Date} scheduledAt
   * @returns {Promise<Object>}
   */
  async create(name, prompt, scheduledAt) {
    const now = new Date();
    const doc = {
      name,
      prompt,
      scheduledAt,
      status: 'pending',
      result: null,
      error: null,
      conversationId: null,
      createdAt: now,
      updatedAt: now
    };
    const result = await this.collection.insertOne(doc);
    return { ...doc, id: result.insertedId.toString() };
  }

  /**
   * Update a job by id.
   * @param {string} id
   * @param {Object} fields
   * @returns {Promise<Object|null>}
   */
  async update(id, fields) {
    if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
      throw new Error(`Invalid job id: "${id}" (expected 24-char hex string)`);
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
   * Remove a job by id.
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async remove(id) {
    if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
      throw new Error(`Invalid job id: "${id}" (expected 24-char hex string)`);
    }
    const result = await this.collection.deleteOne({ _id: new ObjectId(id) });
    return result.deletedCount === 1;
  }

  /**
   * Find all pending jobs that are due for execution.
   * @returns {Promise<Array>}
   */
  async findDueJobs() {
    const docs = await this.collection
      .find({ status: 'pending', scheduledAt: { $lte: new Date() } })
      .sort({ scheduledAt: 1 })
      .toArray();
    return docs.map(doc => ({ ...doc, id: doc._id.toString() }));
  }

  /**
   * @param {string} id
   */
  async markRunning(id) {
    return this.update(id, { status: 'running' });
  }

  /**
   * @param {string} id
   * @param {string} result
   * @param {string} [conversationId]
   */
  async markCompleted(id, result, conversationId) {
    const fields = { status: 'completed', result };
    if (conversationId) fields.conversationId = conversationId;
    return this.update(id, fields);
  }

  /**
   * @param {string} id
   * @param {string} error
   * @param {string} [conversationId]
   */
  async markFailed(id, error, conversationId) {
    const fields = { status: 'failed', error };
    if (conversationId) fields.conversationId = conversationId;
    return this.update(id, fields);
  }

  /**
   * Reset any jobs stuck in 'running' state (orphaned by crash/restart).
   * @returns {Promise<number>} count of jobs reset
   */
  async resetStaleRunningJobs() {
    const result = await this.collection.updateMany(
      { status: 'running' },
      { $set: { status: 'failed', error: 'Orchestrator restarted while job was in-flight', updatedAt: new Date() } }
    );
    return result.modifiedCount;
  }

  /**
   * @param {string} id
   * @param {string} result
   * @param {string} [conversationId]
   */
  async markNeedsInput(id, result, conversationId) {
    const fields = { status: 'needs_input', result };
    if (conversationId) fields.conversationId = conversationId;
    return this.update(id, fields);
  }
}
