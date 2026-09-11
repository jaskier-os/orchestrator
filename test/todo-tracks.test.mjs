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

test('create puts the task at top of ITS track only', async () => {
  await store.ensureTracks();
  const other = (await store.listTracks())[0];
  const work = await store.createTrack({ name: 'Work', color: 'blue' });
  const o1 = await store.create('o1', other.id);
  const w1 = await store.create('w1', work.id);
  const w2 = await store.create('w2', work.id);
  const todos = await store.list();
  const byId = Object.fromEntries(todos.map(t => [t.id, t]));
  assert.equal(byId[o1.id].order, 0);   // untouched by work inserts
  assert.equal(byId[w2.id].order, 0);
  assert.equal(byId[w1.id].order, 1);
});

test('create without trackId falls back to default track', async () => {
  await store.ensureTracks();
  const t = await store.create('x');
  assert.equal(t.trackId, (await store.listTracks())[0].id);
});

test('move within track and across tracks recompacts both', async () => {
  await store.ensureTracks();
  const other = (await store.listTracks())[0];
  const work = await store.createTrack({ name: 'Work', color: 'red' });
  const a = await store.create('a', other.id);
  const b = await store.create('b', other.id); // b=0, a=1
  const c = await store.create('c', work.id);  // c=0
  await store.move(a.id, 0);                     // a=0, b=1
  let byId = Object.fromEntries((await store.list()).map(t => [t.id, t]));
  assert.equal(byId[a.id].order, 0); assert.equal(byId[b.id].order, 1);
  await store.move(b.id, 0, work.id);            // other: a=0 ; work: b=0, c=1
  byId = Object.fromEntries((await store.list()).map(t => [t.id, t]));
  assert.equal(byId[a.id].order, 0);
  assert.equal(byId[b.id].trackId, work.id); assert.equal(byId[b.id].order, 0);
  assert.equal(byId[c.id].order, 1);
});

test('remove recompacts only its track', async () => {
  await store.ensureTracks();
  const other = (await store.listTracks())[0];
  const work = await store.createTrack({ name: 'Work', color: 'green' });
  const a = await store.create('a', other.id);
  const b = await store.create('b', other.id);
  const c = await store.create('c', work.id);
  const d = await store.create('d', work.id);  // d=0, c=1
  await store.remove(b.id);
  const byId = Object.fromEntries((await store.list()).map(t => [t.id, t]));
  assert.equal(byId[a.id].order, 0);
  assert.equal(byId[d.id].order, 0); assert.equal(byId[c.id].order, 1);
});

test('track validation, update, delete guards', async () => {
  await store.ensureTracks();
  const other = (await store.listTracks())[0];
  await assert.rejects(() => store.createTrack({ name: '', color: 'red' }), /name/);
  await assert.rejects(() => store.createTrack({ name: 'X', color: 'pink' }), /color/);
  await assert.rejects(() => store.deleteTrack(other.id), /last track/);
  const work = await store.createTrack({ name: 'Work', color: 'blue' });
  const upd = await store.updateTrack(work.id, { name: 'Job', color: 'aqua' });
  assert.equal(upd.name, 'Job'); assert.equal(upd.color, 'aqua');
  await store.create('t', work.id);
  await assert.rejects(() => store.deleteTrack(work.id), /has tasks/);
  await store.remove((await store.list()).find(t => t.trackId === work.id).id);
  assert.equal(await store.deleteTrack(work.id), true);
  assert.equal((await store.listTracks()).length, 1);
});

test('findTrackByName is case-insensitive', async () => {
  await store.ensureTracks();
  await store.createTrack({ name: 'Work', color: 'blue' });
  assert.equal((await store.findTrackByName('wOrK')).name, 'Work');
  assert.equal(await store.findTrackByName('nope'), null);
});

test('move rejects non-integer positions', async () => {
  await store.ensureTracks();
  const a = await store.create('a');
  await assert.rejects(() => store.move(a.id, 'abc'), /Invalid position/);
  await assert.rejects(() => store.move(a.id, undefined), /Invalid position/);
  await assert.rejects(() => store.move(a.id, -1), /Invalid position/);
  assert.equal((await store.list())[0].order, 0);
});
