#!/usr/bin/env node
// Autonomous test for the RC startup-race fix in rc-handler.js.
//
// Dials the orchestrator WS as a fake phone device, emits an
// rc_user_message for a freshly-minted sessionId that the orchestrator
// has never seen, and asserts:
//   - scenario A (no desktop attaches): within ~15s we receive an rc_error
//     envelope for that sessionId (expiry path).
//   - scenario B (desktop attaches): the queued message is replayed and the
//     fake desktop receives it over its WS.
//
// This is a live integration test: it requires a running orchestrator reachable
// at ORCH_WS / ORCH_RC_WS. By default it targets a local instance over plain ws://.
//
// Env vars:
//   ORCH_WS    override device WS URL (default ws://localhost:10001/ws/device)
//   ORCH_RC_WS override remote-control WS URL (default ws://localhost:10001/ws/remote-control)
//   API_KEY    required. Read from ../.env if not set.
//
// TLS: when ORCH_WS points at a wss:// endpoint with a self-signed cert, the
//   connections below skip certificate verification (rejectUnauthorized: false).

import WebSocket from 'ws';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadApiKey() {
  if (process.env.API_KEY) return process.env.API_KEY;
  const envPath = path.join(__dirname, '..', '.env');
  const txt = fs.readFileSync(envPath, 'utf8');
  const m = txt.match(/^API_KEY=(.+)$/m);
  if (!m) throw new Error('API_KEY not found in .env');
  return m[1].trim();
}

const API_KEY = loadApiKey();
const ORCH_WS = process.env.ORCH_WS || 'ws://localhost:10001/ws/device';
const ORCH_RC_WS = process.env.ORCH_RC_WS || 'ws://localhost:10001/ws/remote-control';

function connectPhone() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(ORCH_WS, { headers: { 'x-api-key': API_KEY }, rejectUnauthorized: false });
    ws.once('open', () => {
      ws.send(JSON.stringify({
        type: 'identify',
        deviceId: `phone-race-test-${process.pid}`,
        deviceType: 'phone'
      }));
      resolve(ws);
    });
    ws.once('error', reject);
  });
}

function connectDesktop(sessionId) {
  const url = `${ORCH_RC_WS}?session=${sessionId}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { 'x-api-key': API_KEY }, rejectUnauthorized: false });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function collect(ws, match, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    ws.on('message', (buf) => {
      try {
        const parsed = JSON.parse(buf.toString());
        if (match(parsed)) { clearTimeout(timer); resolve(parsed); }
      } catch {}
    });
  });
}

function collectRaw(ws, match, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    ws.on('message', (buf) => {
      const text = buf.toString();
      if (match(text)) { clearTimeout(timer); resolve(text); }
    });
  });
}

async function scenarioA() {
  const sid = crypto.randomUUID();
  console.log(`[A] sessionId=${sid} -- no desktop will attach`);
  const phone = await connectPhone();
  // Give orchestrator a beat to register identify
  await new Promise(r => setTimeout(r, 300));
  const errPromise = collect(phone, (m) => m.type === 'rc_error' && m.sessionId === sid, 20_000);
  phone.send(JSON.stringify({ type: 'rc_user_message', sessionId: sid, text: 'race-probe-A' }));
  const err = await errPromise;
  phone.close();
  if (err) {
    console.log(`[A] PASS -- received rc_error: ${JSON.stringify(err).slice(0, 160)}`);
    return true;
  }
  console.log('[A] FAIL -- no rc_error received within 20s');
  return false;
}

async function scenarioB() {
  const sid = crypto.randomUUID();
  console.log(`[B] sessionId=${sid} -- desktop attaches 1s after phone sends`);
  const phone = await connectPhone();
  await new Promise(r => setTimeout(r, 300));

  phone.send(JSON.stringify({ type: 'rc_user_message', sessionId: sid, text: 'race-probe-B' }));

  // Wait 1s then attach the fake desktop and watch for the replayed user input.
  await new Promise(r => setTimeout(r, 1000));
  const desktop = await connectDesktop(sid);

  // The orchestrator forwards user input to desktop as a stream-json
  // "user" control message OR as a direct stdin write. For this smoke
  // test we just look for ANY frame containing our unique probe text.
  const got = await collectRaw(desktop, (t) => t.includes('race-probe-B'), 10_000);
  phone.close();
  desktop.close();
  if (got) {
    console.log(`[B] PASS -- desktop received replayed text: ${got.slice(0, 200)}`);
    return true;
  }
  console.log('[B] FAIL -- desktop did not receive replayed text within 10s');
  return false;
}

(async () => {
  let ok = true;
  try { ok = (await scenarioA()) && ok; } catch (e) { console.error('[A] ERROR', e); ok = false; }
  try { ok = (await scenarioB()) && ok; } catch (e) { console.error('[B] ERROR', e); ok = false; }
  process.exit(ok ? 0 : 1);
})();
