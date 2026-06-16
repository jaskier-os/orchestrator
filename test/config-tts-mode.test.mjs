import { test } from 'node:test';
import assert from 'node:assert';

// config.js requires API_KEY (Joi .required()) and exits the process if it is
// unset, so set the minimal required env before importing it.
process.env.API_KEY = 'test';

test('ttsRoutingMode defaults to language-split', async () => {
  delete process.env.TTS_ROUTING_MODE;
  const { default: config } = await import('../src/config.js?cfg1');
  assert.equal(config.ttsRoutingMode, 'language-split');
});

test('ttsRoutingMode honors env teratts', async () => {
  process.env.TTS_ROUTING_MODE = 'teratts';
  const { default: config } = await import('../src/config.js?cfg2');
  assert.equal(config.ttsRoutingMode, 'teratts');
});
