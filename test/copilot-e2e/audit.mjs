/**
 * Standalone Copilot AUDIT harness (evaluation only -- does NOT touch production src).
 *
 * Richer scenario set to grade the live ambient assistant against:
 *   A) Sales objections, B) Investor objections, C) Negotiation tactics,
 *   D) Recall/factual (with planted error), E) Fraud escalation, F) Small talk.
 *
 * Protocol mirrors the device contract: identify -> assistant_new -> per-batch
 * assistant {requestId, wearerText, interlocutorText, activeCards, model:'haiku'}
 * -> await assistant_result {requestId, cards, dismiss}. HUD newest-first cap 5,
 * single-in-flight, await each before the next. Fresh deviceId+assistant_new per scenario.
 */

import WebSocket from 'ws';
import crypto from 'crypto';

const WS_URL = process.env.COPILOT_WS || 'ws://127.0.0.1:10901/ws/device';
const BATCH_TIMEOUT_MS = 40_000;
const HUD_CAP = 5;
const MODEL = 'haiku';

function uuid() { return crypto.randomUUID(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// helpfulBatches: batch indices (1-based) where a genuinely useful note was possible.
const SCENARIOS = [
  {
    name: 'A_SALES_OBJECTIONS',
    cls: 'Objection (sales)',
    helpfulBatches: [1, 2, 3, 4, 5, 6, 7],
    batches: [
      { w: "So the Pro plan at nine hundred a month fits your team of forty.", i: "Honestly that is way too expensive compared to what we pay now." },
      { w: "What are you on today?", i: "Zendesk, and frankly we are happy. The team knows it inside out." },
      { w: "Customers usually switch for the AI triage Zendesk does not have.", i: "Maybe, but we have zero budget left this quarter. It would have to wait." },
      { w: "We could start a paid pilot now and defer the annual contract.", i: "I also worry about security. Where exactly is our customer data stored?" },
      { w: "Encrypted at rest, stored in EU regions, fully GDPR compliant.", i: "Do you have certifications? Compliance will absolutely ask." },
      { w: "SOC 2 Type II and ISO 27001, both reports available.", i: "Okay. The price is honestly still my biggest hangup." },
      { w: "If you sign before quarter end I will throw in onboarding free.", i: "We are also seriously considering just building this in-house." },
      { w: "I will send a one-pager you can forward to your manager.", i: "Thanks, talk soon." },
    ],
  },
  {
    name: 'B_INVESTOR_OBJECTIONS',
    cls: 'Objection (investor)',
    helpfulBatches: [1, 2, 3, 4, 5, 6, 7],
    batches: [
      { w: "We are raising a four million seed for our dev-tools company.", i: "Walk me through the numbers. What is your monthly burn?" },
      { w: "About one hundred eighty thousand a month, eighteen months runway.", i: "That burn is high for your stage and revenue. Justify it." },
      { w: "Mostly engineering. Nine engineers on the core platform.", i: "The TAM worries me. Dev tools is crowded and margins compress." },
      { w: "Observability alone is north of seventeen billion and growing.", i: "I have seen this movie. Remember the Sourcegraph-style plays that stalled?" },
      { w: "", i: "And the moat? Anyone with a weekend could wrap open telemetry." },
      { w: "Our moat is the trace-correlation engine and labeled incident data.", i: "Data moats are overstated. What stops a big incumbent doing this?" },
      { w: "Incumbents are locked into legacy stacks, cannot rebuild cleanly.", i: "Fine. And your CAC payback period?" },
      { w: "Around eleven months, trending down with product-led growth.", i: "Reasonable. Send the data room, I will discuss with partners." },
    ],
  },
  {
    name: 'C_NEGOTIATION_TACTICS',
    cls: 'Negotiation',
    helpfulBatches: [1, 2, 3, 4, 5, 6, 7],
    batches: [
      { w: "Glad we are close on scope. Shall we talk commercials?", i: "Sure. Frankly your list price is more than we budgeted." },
      { w: "What number did you have in mind?", i: "We can do sixty thousand, take it or leave it. That is our ceiling." },
      { w: "That is well below our usual.", i: "Look, two other vendors quoted us cheaper. We do not need you specifically." },
      { w: "", i: "And we need a decision today. My CFO signs off only this week." },
      { w: "I want to make this work but sixty is tough for us.", i: "If you cannot hit sixty just say so and we will go elsewhere." },
      { w: "Could we meet at seventy-two with annual prepay?", i: "Throw in the premium support tier free and you have a deal at seventy." },
      { w: "Let me see what I can do on support.", i: "Good. Send paper today and we sign this week." },
      { w: "I will get the contract over this afternoon.", i: "Appreciate it." },
    ],
  },
  {
    name: 'D_RECALL_FACTUAL',
    cls: 'Recall/factual',
    helpfulBatches: [2, 3, 4, 6],
    batches: [
      { w: "Good to see you again. How was the trip?", i: "Long. I am Elena, we met at the Helsinki summit in March." },
      { w: "Of course, Elena. You run product at Vanta, right?", i: "Close, I run product at Drata, the compliance automation company." },
      { w: "Right, Drata. You were founded around 2020 if I recall.", i: "Yes. By the way, your CEO Sarah introduced us over email last year." },
      { w: "She did. Sarah leads our partnerships now.", i: "Quick question, the Eiffel Tower is in Berlin, correct? I always forget." },
      { w: "Anyway, about the integration roadmap.", i: "Right, we wanted SSO support by Q3 and the audit-log export." },
      { w: "Both are on our roadmap. Audit-log export ships next month.", i: "Perfect. Loop in your CTO, what was his name, Marcus?" },
      { w: "Yes, Marcus. I will set up a call.", i: "Great, talk soon." },
    ],
  },
  {
    name: 'E_FRAUD',
    cls: 'Fraud',
    helpfulBatches: [2, 3, 4, 5, 6, 7, 8, 9],
    batches: [
      { w: "Hello?", i: "Good afternoon, this is the security department of your bank. We detected suspicious activity." },
      { w: "Oh no, what kind?", i: "Someone tried to withdraw two thousand dollars. To stop it we must verify your identity now." },
      { w: "Okay, how?", i: "I will send a one time code to your phone. Read it back so I can confirm it is you." },
      { w: "I think I just got a text with a code.", i: "Read me that six digit code now, quickly, before the transaction goes through." },
      { w: "Are you sure this is normal? It feels rushed.", i: "Sir this is urgent, every second your money is at risk. Trust me." },
      { w: "Maybe I should call the bank myself first.", i: "There is no time. If you hang up the thieves win. Stay on the line." },
      { w: "", i: "To secure your device, download AnyDesk and give me the access ID." },
      { w: "You want remote access to my computer?", i: "Yes, and if that is blocked, buy two five hundred dollar gift cards and read me the numbers." },
      { w: "This sounds really wrong.", i: "Do not be difficult. I also need your social security number and online banking password." },
    ],
  },
  {
    name: 'F_SMALL_TALK',
    cls: 'Small talk',
    helpfulBatches: [],
    batches: [
      { w: "Crazy weather today, huh?", i: "Tell me about it. I forgot my umbrella again." },
      { w: "Did you catch the game last night?", i: "No, I fell asleep on the couch. Was it any good?" },
      { w: "Pretty boring honestly. Coffee?", i: "Sure, milk no sugar. Thanks." },
      { w: "These pastries here are underrated.", i: "Right? The almond croissant is my weakness." },
      { w: "How are the kids doing?", i: "Growing too fast. The little one started school." },
      { w: "They grow up quick. Anyway, good to catch up.", i: "Likewise, let us grab lunch sometime." },
    ],
  },
];

function applyResult(hud, result) {
  let next = hud;
  if (Array.isArray(result.dismiss) && result.dismiss.length) {
    const drop = new Set(result.dismiss);
    next = next.filter(c => !drop.has(c.id));
  }
  if (Array.isArray(result.cards) && result.cards.length) {
    next = [...result.cards, ...next].slice(0, HUD_CAP);
  }
  return next;
}
function fmtList(arr) { return arr.length ? `[${arr.map(c => c.id).join(', ')}]` : '[]'; }

function connect(url) {
  return new Promise((resolve, reject) => {
    const opts = url.startsWith('wss') ? { rejectUnauthorized: false } : {};
    const ws = new WebSocket(url, opts);
    const to = setTimeout(() => { ws.terminate(); reject(new Error('connect timeout')); }, 15_000);
    ws.on('open', () => { clearTimeout(to); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}

function sendBatch(ws, batch, hud) {
  const requestId = uuid();
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setTimeout(() => { ws.off('message', onMsg); reject(new Error(`timeout`)); }, BATCH_TIMEOUT_MS);
    function onMsg(raw) {
      let env; try { env = JSON.parse(raw.toString()); } catch { return; }
      if (env.type === 'assistant_result' && env.requestId === requestId) {
        clearTimeout(timer); ws.off('message', onMsg);
        resolve({ cards: env.cards || [], dismiss: env.dismiss || [], latencyMs: Date.now() - t0 });
      }
    }
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ type: 'assistant', requestId, wearerText: batch.w || '', interlocutorText: batch.i || '', activeCards: hud, model: MODEL }));
  });
}
function send(ws, obj) { ws.send(JSON.stringify(obj)); }

async function run() {
  const out = [];
  const log = (s = '') => { out.push(s); console.log(s); };

  log(`[audit] connecting to ${WS_URL}`);
  let ws;
  try { ws = await connect(WS_URL); } catch (e) { console.error(`CONNECT FAILED: ${e.message}`); process.exit(2); }
  log('[audit] connected');

  const scorecard = [];

  for (let s = 0; s < SCENARIOS.length; s++) {
    const sc = SCENARIOS[s];
    const deviceId = `audit-${sc.name}-${crypto.randomBytes(3).toString('hex')}`;
    send(ws, { type: 'identify', deviceId, deviceType: 'glasses' });
    await sleep(200);
    send(ws, { type: 'assistant_new' });
    await sleep(200);

    log(`\n========== SCENARIO ${s + 1}: ${sc.name} (${sc.cls}) ==========`);
    let hud = [];
    let fired = 0;
    const firedAt = new Set();

    for (let b = 0; b < sc.batches.length; b++) {
      const batch = sc.batches[b];
      let res;
      try { res = await sendBatch(ws, batch, hud); } catch (e) { log(`[batch ${b + 1}] ERROR ${e.message}`); continue; }
      log(`\n[batch ${b + 1}] (${res.latencyMs}ms)`);
      log(`  Wearer: ${batch.w ? '"' + batch.w + '"' : '(silent)'}`);
      log(`  Interlocutor: ${batch.i ? '"' + batch.i + '"' : '(silent)'}`);
      const newCards = res.cards || [];
      const dismiss = res.dismiss || [];
      if (newCards.length === 0 && dismiss.length === 0) {
        log(`  -> (silent)`);
      } else {
        if (newCards.length) { fired++; firedAt.add(b + 1); }
        for (const c of newCards) log(`  -> CARD heard="${c.heard}"  note="${c.note}"`);
        if (dismiss.length) log(`  -> DISMISS: ${dismiss.join(', ')}`);
        hud = applyResult(hud, res);
      }
      log(`  HUD: ${fmtList(hud)}`);
    }

    const missed = sc.helpfulBatches.filter(i => !firedAt.has(i));
    const overFire = sc.helpfulBatches.length === 0 ? fired : 0;
    log(`\n  SUMMARY ${sc.name}: fired ${fired}/${sc.batches.length} batches.`);
    log(`  helpful-possible batches: [${sc.helpfulBatches.join(', ')}] | fired-at: [${[...firedAt].sort((a,b)=>a-b).join(', ')}]`);
    log(`  MISSED OPPORTUNITIES: ${missed.length} ${missed.length ? '(batches ' + missed.join(', ') + ')' : ''}`);
    if (sc.helpfulBatches.length === 0) log(`  OVER-FIRE on small talk: ${overFire} (want 0)`);
    scorecard.push({ name: sc.name, cls: sc.cls, fired, total: sc.batches.length, missed: missed.length, overFire, helpful: sc.helpfulBatches.length });
  }

  log(`\n========== SCORECARD ==========`);
  log(`scenario | fired/total | helpful-possible | missed-opps | over-fire`);
  for (const r of scorecard) {
    log(`${r.name} | ${r.fired}/${r.total} | ${r.helpful} | ${r.missed} | ${r.overFire}`);
  }

  ws.close();
  await sleep(300);
  log('[audit] done');

  const fs = await import('fs');
  const path = await import('path');
  const url = await import('url');
  const outDir = path.dirname(url.fileURLToPath(import.meta.url));
  fs.writeFileSync(path.join(outDir, 'copilot-audit-output.txt'), out.join('\n'));
}

run().catch(e => { console.error('[audit] fatal', e); process.exit(1); });
