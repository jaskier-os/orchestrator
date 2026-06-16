import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// config.js is Object.freeze()d and reads env once at import time, and tts.js
// imports the same `./config.js` specifier (no query cache-bust), so the config
// instance cannot be swapped or mutated within a single process between the two
// modes. The robust approach is therefore a fresh child process per mode, each
// with its own TTS_ROUTING_MODE in the environment. The child installs a fetch
// spy (so no real TTS service is needed) and prints every URL it hit; the parent
// asserts on those URLs.
//
// Ports asserted on are the resolved config defaults (no .env override present):
//   Kokoro  (config.ttsUrl)      -> 10007
//   TeraTTS (config.piperTtsUrl) -> 10013

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ttsPath = path.resolve(__dirname, '../src/tts.js');

function runGenerateAudio(routingMode) {
  const driver = `
    globalThis.__hits = [];
    globalThis.fetch = async (url) => {
      globalThis.__hits.push(String(url));
      const wav = Buffer.alloc(44);
      wav.write('RIFF', 0); wav.write('WAVE', 8);
      return {
        ok: true,
        headers: { get: () => 'audio/wav' },
        arrayBuffer: async () => wav.buffer.slice(0, 44),
      };
    };
    const { generateAudio } = await import(${JSON.stringify(ttsPath)});
    await generateAudio('hello world');
    process.stdout.write('HITS:' + JSON.stringify(globalThis.__hits));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', driver], {
    env: { ...process.env, API_KEY: process.env.API_KEY || 'test', TTS_ROUTING_MODE: routingMode },
    encoding: 'utf8',
  });
  const m = out.match(/HITS:(\[.*\])/);
  assert.ok(m, `driver did not print hits, got: ${out}`);
  return JSON.parse(m[1]);
}

test('teratts mode routes English to TeraTTS not Kokoro', () => {
  const hits = runGenerateAudio('teratts');
  assert.ok(hits.some(u => u.includes('10013')), `expected TeraTTS(10013) hit, got ${JSON.stringify(hits)}`);
  assert.ok(!hits.some(u => u.includes('10007')), `must NOT hit Kokoro(10007), got ${JSON.stringify(hits)}`);
});

test('language-split mode routes English to Kokoro', () => {
  const hits = runGenerateAudio('language-split');
  assert.ok(hits.some(u => u.includes('10007')), `expected Kokoro(10007) hit, got ${JSON.stringify(hits)}`);
});
