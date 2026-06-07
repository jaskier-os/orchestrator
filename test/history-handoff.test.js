// Test: Session.getHistoryForAgent emits clean history, and
// BaseAgent.buildMessagesWithHistory passes it through without role coercion.
//
// Regression target: a multi-turn glasses chat where Q2's reply was prefixed
// with Q1's answer text. Root cause was getMessages() returning [system,
// ...messages] and buildMessagesWithHistory coercing the system entry to a
// user message, which polluted the sub-agent prompt.

// Required env: API_KEY, COMMUNICATOR_URL, MONGO_URL. Set on the command line
// (ESM hoists imports before any in-file process.env writes can run).
//   API_KEY=test COMMUNICATOR_URL=http://localhost MONGO_URL=mongodb://localhost \
//     node test/history-handoff.test.js

import assert from 'node:assert/strict';
import { Session } from '../src/session.js';
import { BaseAgent } from '../sdk/base-agent.js';

class DummyAgent extends BaseAgent {
  constructor() {
    super(
      { id: 'dummy', name: 'Dummy', capabilities: [], healthEndpoint: '/health' },
      { orchestratorUrl: 'http://localhost:0', healthPort: 0 }
    );
  }
}

function run() {
  const session = new Session('conv-1');
  session.addUserMessage('What time is it?');
  session.addAssistantMessage('It is 3:54 AM.');
  session.addUserMessage('What is on this photo?');

  const history = session.getHistoryForAgent();
  assert.equal(history.length, 2, 'history excludes the pending user turn');
  assert.equal(history[0].role, 'user');
  assert.equal(history[0].content, 'What time is it?');
  assert.equal(history[1].role, 'assistant');
  assert.equal(history[1].content, 'It is 3:54 AM.');
  assert.ok(!history.some(m => m.role === 'system'),
    'history must not contain the orchestrator system prompt');

  const agent = new DummyAgent();
  const userContent = [
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/AAA' } },
    { type: 'text', text: 'What is on this photo?' }
  ];
  const messages = agent.buildMessagesWithHistory(
    'You are a vision agent.',
    userContent,
    history,
    null,
    null
  );

  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, 'You are a vision agent.',
    'agent system prompt is the only system message');
  assert.equal(messages[1].role, 'user');
  assert.equal(messages[1].content, 'What time is it?');
  assert.equal(messages[2].role, 'assistant');
  assert.equal(messages[2].content, 'It is 3:54 AM.');
  assert.equal(messages[3].role, 'user');
  assert.deepEqual(messages[3].content, userContent,
    'multimodal content is passed through, not stringified');

  // Defensive: previously, system would be coerced to user. Make sure that
  // even if a stray non-{user,assistant} message slips into history, it does
  // not become a user message. Session.getHistoryForAgent already filters,
  // but buildMessagesWithHistory should also be safe.
  const polluted = [
    { role: 'system', content: 'STRAY SYSTEM' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' }
  ];
  const out = agent.buildMessagesWithHistory('sys', 'next', polluted, null, null);
  const userTexts = out.filter(m => m.role === 'user').map(m => m.content);
  assert.ok(!userTexts.includes('STRAY SYSTEM'),
    'a stray system message in history must not appear as a user message');

  // sessionHistory is empty after first turn, ensure nothing weird is added.
  const fresh = new Session('conv-2');
  fresh.addUserMessage('first prompt');
  const empty = fresh.getHistoryForAgent();
  assert.equal(empty.length, 0, 'first turn yields empty history');

  console.log('history-handoff: all assertions passed');
}

run();
