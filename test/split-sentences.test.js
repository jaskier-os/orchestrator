// Set required env vars before config loads
process.env.API_KEY = 'test';
process.env.COMMUNICATOR_URL = 'http://localhost';
process.env.MONGO_URL = 'mongodb://localhost';

import { splitSentences } from '../src/tts.js';
import assert from 'node:assert';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL: ${name}`);
    console.log(`        ${err.message}`);
  }
}

console.log('splitSentences tests:\n');

test('basic sentence split', () => {
  const result = splitSentences('Hello world. How are you? Fine!');
  assert.deepStrictEqual(result, ['Hello world.', 'How are you?', 'Fine!']);
});

test('version numbers are not split', () => {
  const result = splitSentences('Ubuntu 24.04.4 LTS is installed.');
  assert.strictEqual(result.length, 1);
  assert.ok(result[0].includes('24.04.4'), `Expected "24.04.4" in "${result[0]}"`);
});

test('version number in sentence context', () => {
  const result = splitSentences('Running Ubuntu 24.04.4 LTS. Everything works fine.');
  assert.strictEqual(result.length, 2);
  assert.ok(result[0].includes('24.04.4'), `First sentence should contain version: "${result[0]}"`);
});

test('IP addresses are not split', () => {
  const result = splitSentences('Connect to 192.168.1.1 for access.');
  assert.strictEqual(result.length, 1);
  assert.ok(result[0].includes('192.168.1.1'));
});

test('decimal numbers are not split', () => {
  const result = splitSentences('The value is 3.14 approximately.');
  assert.strictEqual(result.length, 1);
  assert.ok(result[0].includes('3.14'));
});

test('multiple sentences with numbers', () => {
  const result = splitSentences('Version 2.0.1 is out. Download it now! It costs $9.99.');
  assert.strictEqual(result.length, 3);
  assert.ok(result[0].includes('2.0.1'));
  assert.ok(result[2].includes('9.99'));
});

test('Russian text with version', () => {
  const result = splitSentences('Ubuntu 24.04.4 LTS (Noble Numbat) -- eto operacionnaya sistema, ustanovlennaya na tvoem kompyutere.');
  assert.strictEqual(result.length, 1);
});

test('short fragments are filtered out', () => {
  const result = splitSentences('OK. A. This is a real sentence.');
  // "A." is only 2 chars, should be filtered
  assert.ok(result.every(s => s.length >= 3), `All sentences should be >= 3 chars: ${JSON.stringify(result)}`);
});

test('empty string returns empty array', () => {
  assert.deepStrictEqual(splitSentences(''), []);
});

test('no punctuation returns whole string', () => {
  const result = splitSentences('Just a plain text without punctuation');
  assert.deepStrictEqual(result, ['Just a plain text without punctuation']);
});

test('question marks and exclamation', () => {
  const result = splitSentences('What is this? I do not know! Let me check.');
  assert.strictEqual(result.length, 3);
});

test('markdown is stripped', () => {
  const result = splitSentences('**Bold text** is here. And `code` too.');
  assert.ok(!result[0].includes('**'));
  assert.ok(!result[1].includes('`'));
});

test('protocol URL path and protocol stripped', () => {
  const result = splitSentences('Visit https://www.example.com/long/path/here for details.');
  const joined = result.join(' ');
  assert.ok(!joined.includes('/long/path'), `URL path should be stripped: "${joined}"`);
  assert.ok(!joined.includes('https://'), `Protocol should be stripped: "${joined}"`);
  assert.ok(!joined.includes('www.'), `www. should be stripped: "${joined}"`);
});

test('bare www URL path stripped', () => {
  const result = splitSentences('Check www.github.com/user/repo for the code.');
  const joined = result.join(' ');
  assert.ok(!joined.includes('/user/repo'), `URL path should be stripped: "${joined}"`);
  assert.ok(!joined.includes('www.'), `www. should be stripped: "${joined}"`);
});

test('markdown link keeps text, strips URL', () => {
  const result = splitSentences('See [docs](https://docs.example.com/api/v2) here.');
  const joined = result.join(' ');
  assert.ok(joined.includes('docs'), `Link text should remain: "${joined}"`);
  assert.ok(!joined.includes('/api/v2'), `URL path should be gone: "${joined}"`);
});

test('multiple URLs paths stripped', () => {
  const result = splitSentences('Found on https://reddit.com/r/test and https://news.ycombinator.com/item?id=123 today.');
  const joined = result.join(' ');
  assert.ok(!joined.includes('/r/test'), `Path should be stripped: "${joined}"`);
  assert.ok(!joined.includes('/item?id='), `Query should be stripped: "${joined}"`);
  assert.ok(!joined.includes('https://'), `Protocol should be stripped: "${joined}"`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
