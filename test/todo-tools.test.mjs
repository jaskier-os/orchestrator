// Run: API_KEY=test COMMUNICATOR_URL=http://localhost MONGO_URL=$(test/run-mongo.sh) node --test test/todo-tools.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { TodoStore } from '../src/todo-store.js';
import { initDispatcher, handleTodoTool } from '../src/dispatcher.js';

const url = process.env.MONGO_URL;
if (!url) throw new Error('MONGO_URL required (use test/run-mongo.sh)');
let client, db, store;
before(async () => {
  client = await MongoClient.connect(url);
  db = client.db('todo_tools_test_' + Date.now());
  store = new TodoStore(db);
  await store.ensureTracks();
  await store.createTrack({ name: 'Work', color: 'blue' });
  initDispatcher(null, null, store, null);
});
after(async () => { await db.dropDatabase(); await client.close(); });

test('add_task with track name, list_tasks shows track, move_task across tracks', async () => {
  const a = await handleTodoTool('add_task', { text: 'in work', track: 'work' }, null);
  assert.equal(a.created.track, 'Work');
  const b = await handleTodoTool('add_task', { text: 'default' }, null);
  assert.equal(b.created.track, 'Other');
  await assert.rejects(() => handleTodoTool('add_task', { text: 'x', track: 'Nope' }, null), /Unknown track.*Other.*Work/s);
  const l = await handleTodoTool('list_tasks', {}, null);
  assert.deepEqual(l.tracks.map(t => t.name), ['Other', 'Work']);
  assert.equal(l.tasks.find(t => t.id === b.created.id).track, 'Other');
  const m = await handleTodoTool('move_task', { id: b.created.id, position: 0, track: 'Work' }, null);
  assert.equal(m.moved.track, 'Work'); assert.equal(m.moved.position, 0);
});
