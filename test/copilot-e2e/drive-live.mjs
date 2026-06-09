/**
 * Standalone test harness for the live Copilot (assistant/fact-check) feature.
 *
 * Drives the remote orchestrator's /ws/device endpoint directly over WebSocket,
 * mimicking the phone/glasses device contract:
 *   1. identify {deviceId, deviceType:'glasses'}
 *   2. assistant_new (reset isolated session)
 *   3. per ~10s batch: assistant {requestId, wearerText, interlocutorText, activeCards, model:'haiku'}
 *      -> await assistant_result {requestId, cards, dismiss}
 *   4. maintain local HUD state (newest-first, cap 5); add new cards, remove dismissed ids.
 *
 * Does NOT modify production code. Standalone. No emojis.
 *
 * Connection target chosen via env COPILOT_WS (defaults to the prod TLS ingress).
 */

import WebSocket from 'ws';
import crypto from 'crypto';

const WS_URL = process.env.COPILOT_WS || 'ws://localhost:10001/ws/device';
const BATCH_TIMEOUT_MS = 30_000;
const HUD_CAP = 5;
const MODEL = 'haiku';

function uuid() { return crypto.randomUUID(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- Scenarios -----------------------------------------------------------
// Each batch ~= one 10s spoken chunk. w = wearer, i = interlocutor (either may be '').
const SCENARIOS = [
  {
    name: 'SALES MEETING',
    batches: [
      { w: "Thanks for making time. I am Mark from NorthBeacon, we build the customer-data platform I mentioned.", i: "Sure, happy to chat. We are evaluating a few CDPs right now." },
      { w: "We work great with Salesforce and Segment out of the box.", i: "Good, because we run everything on HubSpot and Snowflake, not Salesforce." },
      { w: "", i: "How does your pricing compare to Segment? They quoted us around forty thousand a year." },
      { w: "Our entry tier is twelve thousand a year, and it scales by monthly tracked users.", i: "And what about the enterprise tier with the reverse-ETL feature?" },
      { w: "", i: "We were also looking at RudderStack since it is open source and cheaper." },
      { w: "RudderStack is solid but you self-host it, so you carry the ops burden. We are fully managed.", i: "That is a fair point. Our data team is tiny." },
      { w: "I said earlier we integrate with Salesforce, but to be clear we have a native HubSpot connector too.", i: "Okay, that matters. Send me the security docs and we can do a pilot." },
      { w: "Will do. Our SOC 2 Type II report is ready to share under NDA.", i: "Perfect. Let us aim for a two week pilot." },
    ],
    expect: 'Mostly silent; may recall HubSpot/Snowflake mismatch or correct the earlier Salesforce claim.'
  },
  {
    name: 'STARTUP PARTNERSHIP NEGOTIATION',
    batches: [
      { w: "Great to finally meet in person. Last time we talked at the Lisbon conference you mentioned a co-marketing idea.", i: "Yes, I am Priya from Loomstack. We met right after your talk on supply-chain APIs." },
      { w: "Right. My company Cartograph does logistics routing, you do warehouse robotics.", i: "Exactly. I think our customers overlap a lot, especially mid-market 3PLs." },
      { w: "Daniel at Flexport introduced us originally, he thought we should bundle.", i: "Daniel is great. He is actually an advisor to Loomstack now." },
      { w: "On terms, I was thinking a revenue share, maybe seventy thirty in favor of whoever sources the deal.", i: "We usually do a flat referral fee, but revenue share could work for larger accounts." },
      { w: "", i: "What about co-development? We could build a joint integration in the next quarter." },
      { w: "I am open to that, but we have limited engineering bandwidth until our Series A closes.", i: "When is the round expected to close?" },
      { w: "We are targeting end of Q3, around eight million led by Bessemer.", i: "Congrats. Let us draft an MOU and revisit the rev-share split after your raise." },
      { w: "Sounds good. I will loop in Daniel to sanity check the structure.", i: "Perfect, I will send a calendar invite for next week." },
    ],
    expect: 'Mostly silent; may recall the Lisbon meeting / Daniel as mutual contact and advisor.'
  },
  {
    name: 'INVESTOR OBJECTIONS',
    batches: [
      { w: "Thanks for taking the meeting. We are raising a four million seed for our dev-tools company.", i: "Walk me through the numbers. What is your current burn?" },
      { w: "We burn about one hundred eighty thousand a month with eighteen months of runway.", i: "That burn seems high for your stage and revenue. How do you justify it?" },
      { w: "Most of it is engineering. We have nine engineers building the core platform.", i: "The TAM here worries me. Dev tools is crowded and margins compress fast." },
      { w: "We estimate the observability market alone is north of seventeen billion and growing.", i: "Honestly, I have seen this movie. Remember a company called Sourcegraph style plays that stalled out?" },
      { w: "", i: "What is your moat? Anyone with a weekend could clone a wrapper around open telemetry." },
      { w: "Our moat is the proprietary trace-correlation engine and two years of labeled incident data.", i: "Data moats are often overstated. What stops a big incumbent from doing this?" },
      { w: "Incumbents are locked into legacy architectures and cannot rebuild without breaking customers.", i: "Okay. And your CAC payback period?" },
      { w: "About eleven months, trending down as we move to product-led growth.", i: "That is reasonable. Send me the data room and I will discuss with my partners." },
    ],
    expect: 'May surface counters on burn/TAM/moat objections; should not hallucinate financials.'
  },
  {
    name: 'SALES OBJECTIONS',
    batches: [
      { w: "So based on what you told me, the Pro plan at nine hundred a month fits your team of forty.", i: "Honestly that feels too expensive compared to what we pay now." },
      { w: "What are you using today?", i: "We are on Zendesk and we are pretty happy with it, the team knows it well." },
      { w: "Our customers usually switch because Zendesk lacks the AI triage you asked about.", i: "Maybe, but we have no budget left this quarter. It would have to wait." },
      { w: "We can start a paid pilot now and defer the annual contract to next quarter.", i: "I also worry about security. Where is our customer data stored?" },
      { w: "All data is encrypted at rest and stored in EU regions, we are GDPR compliant.", i: "And do you have any certifications? Our compliance team will ask." },
      { w: "Yes, SOC 2 Type II and ISO 27001, I can share both reports.", i: "Okay. The price is still my biggest hangup though." },
      { w: "If we sign before quarter end I can include onboarding at no charge, that is a six thousand value.", i: "That helps. Let me take this to my manager." },
      { w: "Great, I will send a one-pager you can forward.", i: "Thanks, talk soon." },
    ],
    expect: 'May surface counters to price/incumbent/budget/security objections.'
  },
  {
    name: 'FRAUD CALL',
    batches: [
      { w: "Hello?", i: "Good afternoon, this is the security department of your bank. We detected suspicious activity on your account." },
      { w: "Oh no, what kind of activity?", i: "Someone tried to withdraw two thousand dollars. To stop it we must verify your identity immediately." },
      { w: "Okay, how do I verify?", i: "I will send a one time code to your phone. Please read it back to me so I can confirm it is really you." },
      { w: "I think I just got a text with a code.", i: "Yes, read me that six digit code now, quickly, before the transaction goes through." },
      { w: "Um, are you sure this is normal? It feels rushed.", i: "Sir this is urgent, every second your money is at risk. Trust me, I am here to protect you." },
      { w: "Maybe I should call the bank myself first.", i: "There is no time for that. If you hang up the thieves win. Just give me the code and stay on the line." },
      { w: "", i: "Also, to fully secure your device, download AnyDesk and give me the access ID so I can remove the malware." },
      { w: "You want remote access to my computer?", i: "Yes, and if remote access is blocked, simply buy two five hundred dollar gift cards and read me the numbers as a temporary security hold." },
      { w: "This sounds really wrong.", i: "Do not be difficult. I also need your social security number and online banking password to finalize the protection." },
    ],
    expect: 'MUST strongly and repeatedly flag fraud: OTP, remote access, gift cards, SSN, urgency = scam.'
  }
];

// ---- HUD state helper ----------------------------------------------------
function applyResult(hud, result) {
  let next = hud;
  if (Array.isArray(result.dismiss) && result.dismiss.length) {
    const drop = new Set(result.dismiss);
    next = next.filter(c => !drop.has(c.id));
  }
  if (Array.isArray(result.cards) && result.cards.length) {
    // newest first, cap
    next = [...result.cards, ...next].slice(0, HUD_CAP);
  }
  return next;
}

function fmtCard(c) { return c.id; }
function fmtList(arr) { return arr.length ? `[${arr.map(fmtCard).join(', ')}]` : '[]'; }

// ---- WS plumbing ---------------------------------------------------------
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
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`batch timeout (requestId=${requestId})`));
    }, BATCH_TIMEOUT_MS);
    function onMsg(raw) {
      let env;
      try { env = JSON.parse(raw.toString()); } catch { return; }
      if (env.type === 'assistant_result' && env.requestId === requestId) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve({ cards: env.cards || [], dismiss: env.dismiss || [], latencyMs: Date.now() - t0 });
      }
    }
    ws.on('message', onMsg);
    ws.send(JSON.stringify({
      type: 'assistant',
      requestId,
      wearerText: batch.w || '',
      interlocutorText: batch.i || '',
      activeCards: hud,
      model: MODEL
    }));
  });
}

function send(ws, obj) { ws.send(JSON.stringify(obj)); }

// ---- Run -----------------------------------------------------------------
async function run() {
  console.log(`[harness] connecting to ${WS_URL}`);
  let ws;
  try {
    ws = await connect(WS_URL);
  } catch (e) {
    console.error(`[harness] CONNECT FAILED: ${e.message}`);
    process.exit(2);
  }
  console.log('[harness] connected');

  const summary = [];
  const allLatencies = [];

  for (let s = 0; s < SCENARIOS.length; s++) {
    const sc = SCENARIOS[s];
    const deviceId = `copilot-test-${s + 1}-${crypto.randomBytes(3).toString('hex')}`;
    // fresh identity + reset per scenario
    send(ws, { type: 'identify', deviceId, deviceType: 'glasses' });
    await sleep(200);
    send(ws, { type: 'assistant_new' });
    await sleep(200);

    console.log(`\n=== SCENARIO ${s + 1}: ${sc.name} (deviceId=${deviceId}) ===`);
    let hud = [];
    let firedBatches = 0;
    let emptyBatches = 0;
    const scLatencies = [];
    const scNotes = [];

    for (let b = 0; b < sc.batches.length; b++) {
      const batch = sc.batches[b];
      let res;
      try {
        res = await sendBatch(ws, batch, hud);
      } catch (e) {
        console.log(`[batch ${b + 1}] ERROR: ${e.message}`);
        continue;
      }
      allLatencies.push(res.latencyMs);
      scLatencies.push(res.latencyMs);

      const wLine = batch.w ? `Wearer: "${batch.w}"` : 'Wearer: (silent)';
      const iLine = batch.i ? `Interlocutor: "${batch.i}"` : 'Interlocutor: (silent)';
      console.log(`[batch ${b + 1}] ${wLine}  ${iLine}   (${res.latencyMs}ms)`);

      const newCards = res.cards || [];
      const dismiss = res.dismiss || [];
      if (newCards.length === 0 && dismiss.length === 0) {
        emptyBatches++;
        console.log(`   -> cards: (none)   | dismiss: (none)   | HUD now: ${fmtList(hud)}`);
      } else {
        if (newCards.length) firedBatches++;
        for (const c of newCards) {
          console.log(`   -> NEW CARD [${c.id}] heard="${c.heard}" note="${c.note}"`);
          scNotes.push(c.note);
        }
        if (dismiss.length) {
          console.log(`   -> DISMISS: ${dismiss.join(', ')}`);
        }
        hud = applyResult(hud, res);
        console.log(`   | HUD now: ${fmtList(hud)}`);
      }
    }

    // per-scenario assessment
    let assess;
    if (sc.name === 'FRAUD CALL') {
      const blob = scNotes.join(' ').toLowerCase();
      const hits = ['otp', 'code', 'remote', 'gift card', 'scam', 'fraud', 'never', 'ssn', 'social security', 'bank', 'hang up', 'password']
        .filter(k => blob.includes(k));
      const flagged = scNotes.length >= 2 && hits.length >= 3;
      assess = `Cards fired=${firedBatches}, empty=${emptyBatches}. Fraud-flagging ${flagged ? 'STRONG' : 'WEAK/MISSING'} (signal hits: ${hits.join(', ') || 'none'}).`;
    } else {
      assess = `Cards fired=${firedBatches}, empty=${emptyBatches}. ${sc.expect}`;
    }
    console.log(`   ASSESSMENT: ${assess}`);
    summary.push({ name: sc.name, deviceId, firedBatches, emptyBatches, batches: sc.batches.length, scLatencies, notes: scNotes, assess });
  }

  // overall summary
  console.log('\n========== OVERALL SUMMARY ==========');
  const avg = allLatencies.length ? Math.round(allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length) : 0;
  const min = allLatencies.length ? Math.min(...allLatencies) : 0;
  const max = allLatencies.length ? Math.max(...allLatencies) : 0;
  console.log(`Latency across all batches: avg=${avg}ms min=${min}ms max=${max}ms (n=${allLatencies.length})`);
  for (const s of summary) {
    console.log(`- ${s.name}: ${s.firedBatches}/${s.batches} batches produced cards, ${s.emptyBatches} empty. ${s.assess}`);
  }

  ws.close();
  await sleep(300);
  console.log('[harness] done, ws closed');
}

run().catch(e => { console.error('[harness] fatal', e); process.exit(1); });
