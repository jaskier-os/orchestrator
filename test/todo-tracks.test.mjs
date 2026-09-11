// Run: MONGO_URL=$(test/run-mongo.sh) node --test test/todo-tracks.test.mjs
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { TodoStore, TRACK_COLORS } from '../src/todo-store.js';

const url = process.env.MONGO_URL;
if (!url) throw new Error('MONGO_URL required (use test/run-mongo.sh)');
let client, db, store;

before(async () => {
  client = await MongoClient.connect(url);
  db = client.db('todo_tracks_test_' + Date.now());
});
after(async () => { await db.dropDatabase(); await client.close(); });
beforeEach(async () => {
  await db.collection('todos').deleteMany({});
  await db.collection('tracks').deleteMany({});
  await db.collection('todos_meta').deleteMany({});
  store = new TodoStore(db);
});

test('ensureTracks creates Other and assigns orphan todos to it', async () => {
  await db.collection('todos').insertMany([
    { text: 'a', completed: false, priority: 'primary', order: 0, createdAt: new Date(), updatedAt: new Date() },
    { text: 'b', completed: false, priority: 'primary', order: 1, createdAt: new Date(), updatedAt: new Date() },
  ]);
  await store.ensureTracks();
  const tracks = await store.listTracks();
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].name, 'Other');
  assert.equal(tracks[0].color, 'gray');
  assert.ok(TRACK_COLORS.includes(tracks[0].color));
  const todos = await store.list();
  assert.ok(todos.every(t => t.trackId === tracks[0].id));
  // idempotent
  await store.ensureTracks();
  assert.equal((await store.listTracks()).length, 1);
});
