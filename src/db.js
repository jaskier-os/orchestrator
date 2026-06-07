import { MongoClient } from 'mongodb';

const DB_NAME = 'orchestrator';

/** @type {MongoClient|null} */
let client = null;

/** @type {import('mongodb').Db|null} */
let db = null;

/**
 * Connect to MongoDB and create required indexes.
 * @param {string} url - MongoDB connection URL
 */
export async function connectDb(url) {
  try {
    client = new MongoClient(url);
    await client.connect();
    db = client.db(DB_NAME);

    await db.collection('todos').createIndex({ createdAt: -1 });
    await db.collection('jobs').createIndex({ scheduledAt: 1, status: 1 });
    await db.collection('jobs').createIndex({ createdAt: -1 });

    console.log(`[db] Connected to MongoDB (${url}/${DB_NAME})`);
  } catch (err) {
    console.error(`[db] Failed to connect to MongoDB (${url}/${DB_NAME}): ${err.message}`);
    client = null;
    db = null;
  }
}

/**
 * Get the database instance.
 * @returns {import('mongodb').Db}
 */
export function getDb() {
  if (!db) {
    throw new Error('Database not connected. Call connectDb() first.');
  }
  return db;
}

/**
 * Close the MongoDB connection.
 */
export async function closeDb() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    console.log('[db] MongoDB connection closed');
  }
}
