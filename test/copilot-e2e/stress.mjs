/**
 * Copilot STRESS harness (evaluation only -- does NOT touch production src).
 *
 * Four LONG worst-case scenarios with a MIDDLE-SKILLED wearer and a hostile
 * interlocutor. Drives /ws/device over a local SSH-forwarded port.
 *
 * Protocol per scenario: identify -> assistant_new -> per-batch
 * assistant {requestId, wearerText, interlocutorText, activeCards, model:'haiku'}
 * -> await assistant_result {requestId, cards, dismiss}. HUD newest-first cap 5,
 * single-in-flight, await each before the next. Fresh deviceId+assistant_new per scenario.
 */

import WebSocket from 'ws';
import crypto from 'crypto';
import fs from 'fs';

const WS_URL = process.env.COPILOT_WS || 'ws://127.0.0.1:10901/ws/device';
const BATCH_TIMEOUT_MS = 45_000;
const HUD_CAP = 5;
const MODEL = 'haiku';
const OUT_FILE = '/tmp/copilot_stress.txt';

function uuid() { return crypto.randomUUID(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const SCENARIOS = [
  {
    name: '1_SALES_HOSTILE_PROSPECT',
    batches: [
      { w: "Hi, thanks so much for taking the time today, I really appreciate it. I'm excited to walk you through our platform.", i: "Look, I've got five minutes, tops. We've seen a dozen of these this quarter. Make it quick." },
      { w: "Sure, of course. So, um, we built a customer-data platform that, basically, helps teams unify their data and, you know, act on it faster.", i: "Everybody says that. What does it actually do that I can't already do?" },
      { w: "Well, it connects all your sources and gives you a single customer view, plus real-time segmentation.", i: "We built our own internal tool for that two years ago. It works fine. Next." },
      { w: "Oh. Okay. I mean, a lot of teams find that maintaining an in-house tool gets really expensive over time.", i: "Our engineers like maintaining it. And honestly your stuff is probably overpriced anyway. What's the price?" },
      { w: "It starts at twelve thousand a year, but it scales with usage, so the exact number depends on volume.", i: "Twelve grand? For something we already have for free? That's a hard no. We have no budget for this." },
      { w: "I understand budget is tight. But, um, the in-house tool isn't really free if you count engineering time, right?", i: "Don't tell me how to run my budget. You don't know our costs. Is there anything else?" },
      { w: "Sorry, I didn't mean it like that. Maybe I could show you the ROI calculator we have?", i: "I don't have time for a calculator demo. Just send me an email with the deck and I'll look when I can." },
      { w: "I can definitely send the deck. Would it help if I also included a couple of case studies from similar companies?", i: "Sure, whatever. Look, we're also worried about security, we handle sensitive customer data. Your tool is probably a liability." },
      { w: "Actually security is one of our strengths, we're SOC 2 Type II and ISO 27001 certified, data encrypted at rest in EU regions.", i: "Everyone claims certifications. Doesn't mean much. And integrating a new tool would be a nightmare with our stack." },
      { w: "What does your stack look like? We have native connectors for most of the common tools.", i: "We're on Snowflake and HubSpot mostly. But like I said, not a priority this quarter. Maybe next year." },
      { w: "We actually have native connectors for both Snowflake and HubSpot, so integration is usually pretty fast.", i: "Hm. Even so, I'm not convinced it's worth switching. The incumbent does the job." },
      { w: "Totally fair. I'm not asking you to switch today. Could we maybe just do a short technical call so your team can see the connectors?", i: "I'm slammed. I really don't have bandwidth to add another meeting right now." },
      { w: "I get it, everyone's busy. What if I sent over a short async video walkthrough instead, like ten minutes, no meeting needed?", i: "...Fine. Send the video. No promises I'll watch it." },
      { w: "That's totally fine, no pressure at all. And if the video looks interesting, would you be open to me checking back in two weeks?", i: "If it's interesting, sure, ping me in two weeks. But if it's the usual fluff, don't bother." },
      { w: "Deal. I'll keep it concrete, just the Snowflake and HubSpot connectors and one ROI number. Thanks for the five minutes, genuinely.", i: "Right. We'll see. I have to jump to my next thing." },
    ],
  },
  {
    name: '2_JOB_INTERVIEW_ADVERSARIAL',
    batches: [
      { w: "Thanks for having me in. I'm, uh, really excited about this role and the team.", i: "Let's not waste time on pleasantries. Your resume is frankly thinner than the other candidates we're seeing. Why are you even here?" },
      { w: "Oh, um. Well, I think my background is actually a good fit, I've done a lot of, you know, relevant work.", i: "That's vague. 'Relevant work' tells me nothing. Be specific or don't bother." },
      { w: "Right, sorry. So at my last job I built and shipped a reporting dashboard that the sales team used daily.", i: "A dashboard. That's it? We have interns who do dashboards. Why should we hire you over someone genuinely senior?" },
      { w: "I mean, it wasn't just a dashboard, I also, um, handled the data pipeline behind it and, I guess, some of the architecture.", i: "You 'guess'? You either owned the architecture or you didn't. Which is it?" },
      { w: "I owned it. I designed the pipeline, picked the tools, and got it into production myself.", i: "Fine. Walk me through a time you failed. And don't give me the fake 'I work too hard' answer." },
      { w: "Okay, uh, one time a deploy I made took down the reporting service for a few hours during a busy period.", i: "So you broke production. Great. That's exactly the kind of recklessness we can't afford here." },
      { w: "It was a mistake, yeah. I felt terrible about it and I, um, stayed late to fix it.", i: "Staying late doesn't undo downtime. What did you actually change so it never happens again?" },
      { w: "After that I added a staging environment and a rollback step to the deploy, so we could catch issues before prod.", i: "Took an outage to learn that basic lesson? Hardly impressive. You also seem honestly overqualified-slash-underqualified, hard to tell which." },
      { w: "I'm not sure how to take that. I think I'm right for the level, honestly.", i: "We have stronger candidates lined up. Convince me in one sentence why I shouldn't just go with them." },
      { w: "Um. Because I learn fast and I work hard and I'd really give it my all here?", i: "That's exactly the generic non-answer I told you not to give. Try again, and mean it this time." },
      { w: "Okay. Because I've owned a system end to end, broke it, fixed the root cause, and built the guardrails, so I bring scar tissue a fresh senior hire won't have day one.", i: "Better. Barely. What's your biggest weakness, and I'll know if you're lying." },
      { w: "I tend to take on too much myself instead of delegating, and it's bitten me when I get overloaded.", i: "So you're a bottleneck. Noted. Why do you even want this job, the salary, the title, what?" },
      { w: "Honestly, the problem space, you're working on data infrastructure at a scale I haven't touched yet and I want that challenge.", i: "Everyone says 'the challenge'. Do you have any actual questions for me, or are you just here to nod?" },
      { w: "Yeah, I do. Um, what does success look like in the first ninety days for this role?", i: "Decent question. Anything else, or is that the extent of your curiosity?" },
      { w: "Also, what's the biggest technical risk the team is worried about right now, the thing that keeps you up at night?", i: "Hm. That's actually a fair question. We're done here. We'll be in touch. Maybe." },
    ],
  },
  {
    name: '3_ANGRY_NEIGHBOR_DEESCALATION',
    batches: [
      { w: "Hey, what's up? You knocked pretty hard.", i: "What's UP? Your contractor's truck has been blocking my driveway since SIX THIS MORNING. I couldn't get my kid to school! Are you serious right now?" },
      { w: "Whoa, okay, it's not even my truck, it's the contractor's, so technically that's on them.", i: "Oh, 'technically'? You HIRED them! This is YOUR renovation! Don't you dare pawn this off on someone else!" },
      { w: "I mean, I didn't tell them to park there. Calm down, it's not that big a deal.", i: "Do NOT tell me to calm down! My daughter was LATE for a test because of you! How dare you say it's not a big deal!" },
      { w: "Okay, look, I'm sorry, but you're kind of yelling at me on my own porch here.", i: "I'm yelling because you're not LISTENING! This is the third time this week your people have blocked something! I'm done being nice!" },
      { w: "Third time? I didn't even know about the other times, nobody told me.", i: "That's the problem! You don't know ANYTHING that's going on! You're a terrible neighbor and frankly a terrible person!" },
      { w: "Hey, that's out of line. I'm trying to be reasonable and you're insulting me now.", i: "Out of line? OUT OF LINE? You want to talk about out of line after ruining my morning?! Unbelievable!" },
      { w: "...Okay. You're right that I should've known. I hear you, this has clearly been a nightmare for you.", i: "Yeah. It HAS. And nobody's done a damn thing about it. I'm about ready to call the city and report the whole site." },
      { w: "I don't want it to get to that. It sounds like you've been dealing with this for days and feeling completely ignored.", i: "...Yes. Exactly. I've left notes. I texted you once. Nothing. It's like I don't even exist to you people." },
      { w: "That's a fair thing to be furious about. If I'd gotten ignored like that I'd be banging on the door too.", i: "...I mean. It's been really frustrating. The test thing this morning was just the last straw, okay?" },
      { w: "I get it. The driveway being blocked when you've got a kid to get to school, that's genuinely awful, I'm sorry.", i: "Thank you. That's... the first time anyone's actually said sorry about it. I just want to be able to get out of my own driveway." },
      { w: "Right, and that's not too much to ask, that's the bare minimum. So, um, what would actually fix this for you going forward?", i: "Just keep the trucks off my side. And tell me when there's gonna be heavy work so I can plan. That's it. That's all I wanted." },
      { w: "Okay. I can absolutely do both of those. But I want to be honest, I can't promise the contractor's perfect overnight, so let's set up a direct line.", i: "...Fine. A direct line works. As long as someone actually answers it this time." },
      { w: "Deal. Here's my cell, text me the second anything's blocked and I'll come move it myself if I have to. And I'll get you the work schedule tonight.", i: "Okay. Okay. I appreciate that. Sorry I came in so hot, I was just... it's been a week." },
      { w: "No, honestly, you had every right to be angry, I'd have been worse. We're good. I should've checked in way sooner.", i: "Alright. Thanks. Just... let's not let it get like this again, yeah?" },
      { w: "Agreed. Schedule tonight, my number now, and I'll talk to the contractor first thing tomorrow about the parking.", i: "Okay. Thank you. Really. I'll let you get back to it." },
    ],
  },
  {
    name: '4_HEAVY_CORPORATE_NEGOTIATION',
    batches: [
      { w: "Thanks for joining. I'm hoping we can get the renewal wrapped up today, we really value the partnership.", i: "Let's be efficient. Before we start, are you even able to sign this, or are you just the messenger? I don't want to waste my time." },
      { w: "I, um, I have authority to negotiate the terms, yes. So, on the renewal, our standard uplift this year is eight percent.", i: "Eight percent? Absolutely not. Your competitor quoted us the same scope for half what we pay you now. Half." },
      { w: "Half seems, uh, really aggressive. I'm not sure that's a like-for-like comparison.", i: "It's exactly like-for-like. So either you match a forty percent cut or we move our business. Take it or leave it." },
      { w: "Forty percent is, honestly, not something I can do. That's below our cost on this.", i: "Then I guess we're done. My CFO has authorized me to walk today if you can't get serious. Should I end the call?" },
      { w: "No, no, let's, let's keep talking. I want to make this work. Maybe I can find some movement.", i: "Good. Start by cutting twenty-five percent. And we'll need a three-year lock at that rate, no annual increases." },
      { w: "A three-year lock at minus twenty-five with no increases is a lot. Um, can I get back to you on the number?", i: "No. I need a decision today, this offer expires when this call ends. My calendar is brutal this quarter." },
      { w: "Okay. Look, I can't do twenty-five, but maybe there's a version of this that works for both of us.", i: "Fine, what's your number? And don't insult me with eight percent again." },
      { w: "What if we held price flat this year, zero uplift, in exchange for the three-year term?", i: "Flat? That's still you charging premium prices for a commodity. Throw in the premium SLA and 24/7 support at no cost and maybe." },
      { w: "The premium SLA and 24/7 support normally carry a real cost for us, that's not nothing.", i: "Everything's negotiable. You want the three years, that's the price. Also we'll need uncapped liability in the contract." },
      { w: "Uncapped liability is, um, that's a tough one, our legal team usually caps that at fees paid.", i: "Your legal team isn't on this call. You are. Are you telling me you can't make a decision after all?" },
      { w: "I can make decisions, but uncapped liability genuinely isn't mine to give, that's a board-level policy.", i: "Convenient. Fine, cap it then, but at three times annual fees, not one. And net-90 payment terms." },
      { w: "Net-90 is a stretch, we're usually net-30. And three times fees on the cap is still high for us.", i: "You're nickel-and-diming me on terms while I'm handing you a three-year deal. Don't be difficult. Net-90, 3x cap, flat price, premium SLA included. Done?" },
      { w: "That's, um, that's a lot of concessions stacked together. Can we maybe trade some of those off against each other?", i: "Trade what? I've already come way down from forty percent off. You're getting a great deal. What more do you want?" },
      { w: "Okay, here's where I can land: flat price and the three-year term, premium SLA included, but liability capped at one times fees and net-45. That's a real package.", i: "Net-45 and 2x cap, and you also throw in the onboarding for our new region free. That's my final, and I mean final." },
      { w: "Let me make sure I've got it: three-year flat, premium SLA, 2x liability cap, net-45, free new-region onboarding. If that's genuinely final, I think I can get that approved.", i: "That's final. Send paper today and we sign by Friday. And next year, don't come in at eight percent." },
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
function pct(sorted, p) { if (!sorted.length) return 0; const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length)); return sorted[i]; }

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
    const timer = setTimeout(() => { ws.off('message', onMsg); reject(new Error('timeout')); }, BATCH_TIMEOUT_MS);
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

  log(`[stress] connecting to ${WS_URL}`);
  log(`[stress] run at ${new Date().toISOString()}`);
  let ws;
  try { ws = await connect(WS_URL); } catch (e) { console.error(`CONNECT FAILED: ${e.message}`); process.exit(2); }
  log('[stress] connected');

  const allLat = [];
  const perScenario = [];

  for (let s = 0; s < SCENARIOS.length; s++) {
    const sc = SCENARIOS[s];
    const deviceId = `stress-${sc.name}-${crypto.randomBytes(3).toString('hex')}`;
    send(ws, { type: 'identify', deviceId, deviceType: 'glasses' });
    await sleep(250);
    send(ws, { type: 'assistant_new' });
    await sleep(250);

    log(`\n${'='.repeat(78)}`);
    log(`SCENARIO ${s + 1}: ${sc.name}  (deviceId=${deviceId})`);
    log(`${'='.repeat(78)}`);
    let hud = [];
    let firedBatches = 0;
    let totalCards = 0;
    const firedAt = [];
    const scLat = [];

    for (let b = 0; b < sc.batches.length; b++) {
      const batch = sc.batches[b];
      let res;
      try { res = await sendBatch(ws, batch, hud); } catch (e) { log(`\n[batch ${b + 1}] ERROR ${e.message}`); continue; }
      allLat.push(res.latencyMs); scLat.push(res.latencyMs);
      log(`\n--- batch ${b + 1}/${sc.batches.length}  (${res.latencyMs}ms) ---`);
      log(`  Wearer:       ${batch.w ? '"' + batch.w + '"' : '(silent)'}`);
      log(`  Interlocutor: ${batch.i ? '"' + batch.i + '"' : '(silent)'}`);
      const newCards = res.cards || [];
      const dismiss = res.dismiss || [];
      if (newCards.length === 0 && dismiss.length === 0) {
        log(`  -> (silent, no card)`);
      } else {
        if (newCards.length) { firedBatches++; firedAt.push(b + 1); totalCards += newCards.length; }
        for (const c of newCards) {
          log(`  -> CARD id=${c.id} kind=${c.kind || '(none)'}`);
          log(`       heard: "${c.heard}"`);
          log(`       note:  "${c.note}"`);
        }
        if (dismiss.length) log(`  -> DISMISS: ${dismiss.join(', ')}`);
        hud = applyResult(hud, res);
      }
      log(`  HUD now: ${fmtList(hud)}`);
    }

    const sorted = [...scLat].sort((a, b) => a - b);
    log(`\n  SCENARIO SUMMARY ${sc.name}:`);
    log(`    batches that fired a card: ${firedBatches}/${sc.batches.length}  (at batches ${firedAt.join(', ') || 'none'})`);
    log(`    total cards: ${totalCards}`);
    log(`    latency ms: min=${sorted[0] || 0} p50=${pct(sorted, 50)} max=${sorted[sorted.length - 1] || 0}`);
    perScenario.push({ name: sc.name, firedBatches, totalCards, total: sc.batches.length, firedAt, scLat: sorted });
  }

  const allSorted = [...allLat].sort((a, b) => a - b);
  log(`\n${'='.repeat(78)}`);
  log(`OVERALL`);
  log(`${'='.repeat(78)}`);
  log(`total batches: ${allLat.length}`);
  log(`latency ms across all batches: min=${allSorted[0] || 0} p50=${pct(allSorted, 50)} p90=${pct(allSorted, 90)} max=${allSorted[allSorted.length - 1] || 0}`);
  for (const r of perScenario) {
    const ss = r.scLat;
    log(`- ${r.name}: ${r.firedBatches}/${r.total} batches fired, ${r.totalCards} cards | lat min=${ss[0] || 0} p50=${pct(ss, 50)} max=${ss[ss.length - 1] || 0}`);
  }

  ws.close();
  await sleep(300);
  log('[stress] done');

  fs.writeFileSync(OUT_FILE, out.join('\n'));
  console.log(`\n[stress] full transcript written to ${OUT_FILE}`);
}

run().catch(e => { console.error('[stress] fatal', e); process.exit(1); });
