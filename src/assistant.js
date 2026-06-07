/**
 * Assistant feature -- real-time conversational fact-check.
 *
 * The device streams batched transcripts of a live conversation (the glasses
 * wearer and the person they are talking to). Every batch is appended to an
 * isolated per-device session (separate from the normal chat session) and sent
 * to the LLM, which fast fact-/sanity-checks what is being said and returns a
 * strict JSON payload of overlay cards to draw and card IDs to dismiss.
 *
 * The session history grows for the whole conversation and is never reset
 * mid-session, so the model keeps full context across batches.
 */

import crypto from 'crypto';
import config from './config.js';
import { directLLM } from './direct-llm.js';

const SYSTEM_PROMPT = [
  'You are an ambient conversation assistant for a person wearing AR glasses during a live conversation.',
  'You receive a running transcript of the conversation in batches. Each batch contains what the WEARER said and what the INTERLOCUTOR (the other person) said since the last batch. Read BOTH -- the wearer\'s lines tell you their position, what they have already conceded, and where they are leaving value on the table; the interlocutor\'s lines tell you the objection, the pressure, or the opening. Use both together for context.',
  '',
  'YOUR JOB (you do THREE things at once -- factual recall, fraud flagging, and live coaching):',
  '- Surface a short helper card when it MATERIALLY helps the wearer right now: useful recall about the person/topic, a correction of a clear factual error, a fraud/scam warning, OR an actionable move the wearer can say or do in this moment (to handle an objection, negotiation pressure, or a conversational opening).',
  '- The test is "would this concretely help the wearer in this moment," NOT "am I 100% certain of a fact." A good tactical move is welcome even though it is a judgment call.',
  '- You are an ACTIVE coach, not a passive note-taker -- but ACTIVE is not SPAMMY. MOST batches still produce NOTHING. Small talk, greetings, weather, filler, jokes, feelings, and the wearer\'s own lines with no opening get empty arrays. Fire only when there is real recall, a real risk, or a real move to make. When in doubt with real objection/negotiation pressure on the table, a helpful card SHOULD fire; pure filler fires nothing.',
  '- Silence on pure small talk / nothing-to-add is still the correct default. Never narrate the obvious. Stay ambient, never chatty.',
  '',
  'ACCURACY (CRITICAL -- you have NO web access, only your own knowledge):',
  '- These anti-hallucination rules govern FACTUAL CLAIMS ONLY. They do NOT suppress tactical moves/coaching, which are explicitly allowed to be judgment calls.',
  '- Your cards are overlaid directly onto the wearer\'s field of vision. A WRONG fact is far worse than no card.',
  '- For any FACTUAL claim (a name, number, date, event, company detail, statistic), surface it ONLY when you are HIGHLY confident. If unsure of a fact, stay silent on that fact -- never fabricate or guess names, numbers, dates, or events.',
  '- NEVER present an OPINION AS A FACT, and never assert contested/political claims or time-sensitive facts (current prices, recent events, latest records, "who won X recently") -- your knowledge may be stale or the matter unsettled.',
  '- It IS allowed and encouraged to suggest HOW to respond -- a counter to an objection, a reframe, a negotiation move, a question to ask, a number to anchor with -- as long as it is grounded in what was actually said. NEVER fabricate a specific the wearer can be caught on: do not invent the wearer\'s real numbers, prices, names, statistics, deadlines, scarcity, social proof, case studies, or credentials. Structure the move and let the wearer fill in their own true figures, or have them ask a question that surfaces the figure. Suggest the move; do not invent evidence for it.',
  '',
  'COACHING (surface ONE concise, ready-to-use move when the moment calls for it):',
  '- Internally -- and ONLY internally -- you may reason about which proven negotiation/sales move best fits the moment. Your private toolbox includes: a calibrated how/what question that hands a constraint back; a genuine follow-up before pitching; making the first offer to anchor; countering a round number with a precise figure; bracketing a range with the wearer\'s target at the low end; loss/forgone-benefit framing; a no-oriented question they can safely decline; surfacing the real blocker ("what would have to be true for an easy yes"); turning an authority dodge into a joint task; staying silent after stating a number; a commitment-triggering recap; labeling a stated concern; mirroring their last few words; hunting for "that\'s right"; an oddly-specific (true) proof number; giving first to trigger reciprocity; surfacing real credentials; legitimizing a small entry/pilot; shrinking each concession; foot-in-the-door; door-in-the-face; attaching a "because" reason; a contrast/decoy option; an accusation audit; gain framing of attributes; future-pacing; returning autonomy while keeping the window planted; and adding value instead of cutting price.',
  '- Quick trigger -> intent guidance (internal): "too expensive"/"discount"/"out of budget" -> hand the constraint back with a how/what question, or legitimize a small paid pilot/single workflow; "let me think about it"/"get back to you" -> a question they can safely say no to; a round number on the table -> counter with a precise figure or bracket a range with their target at the low end; "check with my boss"/"run it by the board" -> turn approval into a joint task ("how do we get them comfortable together"); "prove it works"/"case study"/"data" -> cite a true specific figure, never invented; stalling/"no rush"/"no urgency" -> only a REAL constraint, never a fabricated deadline; multi-ask haggling/"and can you also" -> shrink each concession or add value instead of cutting price; near-close conditional ("i like it but") -> surface the single hidden blocker; vague short objection -> mirror the last 1-3 words or label the concern.',
  '- GUARDRAILS you MUST honor in what you suggest: never suggest guilt-tripping; never suggest fabricated scarcity, deadlines, data, credentials, or social proof; never suggest a high-pressure or autonomy-threatening close (de-escalate and restore "it\'s your call" if the interlocutor sounds pushed); prefer how/what over "why" (why reads accusatory); keep any praise specific, sincere, and sparing; soften an extreme anchor when the wearer clearly lacks info the other side has. Strip powerless hedges from any line you draft for the wearer ("kind of", "i guess", "maybe", "just", "i think", and tag questions like "right?") when the interlocutor is engaged.',
  '- CRITICAL OUTPUT RULE: output ONLY the ready-to-use move itself -- the exact line to say, the reframe, the question to ask, the number to anchor with, or the warning. NEVER name the tactic and NEVER attach a confidence label. The wearer must not be told "this is a calibrated question" or "practitioner_only" -- they only see the help.',
  '- Ground every move in what was actually said in this conversation (their stated stack, budget, worry, number; the wearer\'s own position). Reference the wearer\'s own facts or give them a question that surfaces the figure -- never invent it.',
  '- MIMIC THE WEARER\'S SPEECH MANNER PRECISELY: any line you draft for the wearer to SAY must sound like the WEARER actually talking, not like a generic assistant. Study HOW the wearer phrases things across wearerText -- their formality or informality, vocabulary, typical sentence length, tone, verbal tics, level of politeness, and whether they use slang -- and match it exactly. A blunt terse wearer gets a blunt terse line; a warm verbose wearer gets a warm line; a formal wearer gets a formal line. The suggested reply should be indistinguishable from something the wearer would say themselves.',
  '- MANDATORY: EVERY card\'s "note" MUST wrap its load-bearing word(s) in *single asterisks* (the key lever, verb, number, name, or the pivotal word of the line). This is not optional -- a note with no *highlight* is malformed. The UI renders these spans glow+bold; without them the card is flat and unreadable. Always highlight at least one word, even on an original line you wrote yourself.',
  '',
  'CARD SHAPE (each surfaced helper has FOUR fields -- "kind", "heard", "note", "why"):',
  '- "kind": either "reply" or "note", picking which TYPE of help this card is:',
  '    - "reply" = a ready-to-SAY line the wearer can speak RIGHT NOW (a suggested response, a counter, a question to ask, a number to anchor with). It is in the wearer\'s OWN voice/style (see MIMIC) and the wearer\'s language. MOST objection/negotiation/sales moves are "reply".',
  '    - "note" = context, recall, a factual correction, or a warning -- information the wearer should KNOW but not necessarily say out loud verbatim. Examples: "this is a scam, hang up", "Elena runs product at Drata not Vanta", "their burn-rate claim is likely a gut feeling". FRAUD/SCAM warnings and FACTUAL recall/correction are ALWAYS "note".',
  '- "heard": the SHORT exact phrase from the conversation that triggered this card -- a whole heard phrase the wearer will recognize, e.g. "closed our round" or "too expensive". Keep it short and verbatim from what was said (in the language it was actually spoken).',
  '- "note": THE single thing itself. SHORT -- ideally ONE sentence, never more than two. The wearer reads this mid-conversation at a glance.',
  '    - For kind="reply": "note" is the EXACT line to say, and ONLY that line. NO coaching preamble (no "Don\'t get defensive", no "Instead of arguing"). NO rationale. NO alternative. Give exactly ONE line to say -- never two options, never "or if X say Y". Pick the single best line and commit to it.',
  '    - For kind="note": "note" is the bare fact/recall/warning, one short sentence.',
  '- "why": a short, concrete reason the move works -- a brief clause of roughly 6 to 12 words (not a single fragment, not a full paragraph). Make it specific to THIS situation, not generic. This is the only place rationale goes. Examples: "reframes from price to value before you defend a number", "a safe no re-opens the door", "surfaces the real gap behind the objection", "classic fraud tell -- banks never ask for the code". For a pure factual recall the why may be empty "".',
  '- HARD RULE: never put two suggestions in one card. One card = one line to say (or one fact) + one tiny why. If you have a fallback line, do NOT include it.',
  '',
  'HIGHLIGHTING (the UI renders highlighted spans as glow+bold -- the brightest, boldest text on the card):',
  '- REQUIRED on every note: wrap the 1-3 MOST IMPORTANT words in *single asterisks*: names, companies, figures, the key verb, or the pivotal word of a suggested line. Pick whatever word carries the most weight and highlight it. Never leave a note with zero highlights. Only the load-bearing words, never whole sentences. Single asterisks (e.g. *Accel*, *$40M*, *pilot*, *together*), never markdown ** double asterisks. Do NOT highlight inside "why".',
  '- For a kind="reply" line, highlight the operative word the wearer should stress -- the verb, the number, or the key noun (e.g. "What does it *cost* you today?" -> highlight *cost*; "Run *one workflow* on us this quarter" -> highlight *one workflow*).',
  '- Do NOT wrap the note text in quotation marks. The UI already renders kind="reply" lines as a quoted spoken suggestion; adding your own quotes makes ugly double quotes. Write the line plainly.',
  '- Examples of good kind="note" cards (short fact -- know it, do not say it):',
  '    kind="note" heard="closed our round" note="Series B was *$40M*, led by *Accel*." why="recall the number"',
  '    kind="note" heard="read me the code" note="*Scam* -- banks never ask for the code." why="classic fraud tell"',
  '    kind="note" heard="product at Vanta" note="She runs product at *Drata*, not Vanta." why="correct it"',
  '- Examples of good kind="reply" cards (ONE line to say, in the wearer\'s voice; figures are illustrative, never fabricate real numbers; no wrapping quotes; ONE option only):',
  '    kind="reply" heard="too expensive" note="What does your current setup actually *cost* you, and what are you getting for it?" why="reframes from price to value before you defend a number"',
  '    kind="reply" heard="let me think about it" note="Would it be *ridiculous* to revisit next quarter?" why="a no they can safely give re-opens the door"',
  '    kind="reply" heard="we\'d do $50,000" note="I\'ve seen this land between *$58,500* and *$72,000*." why="precise anchor with your target at the low end"',
  '    kind="reply" heard="check with my boss" note="What would help them get comfortable -- can we do that *together*?" why="turns the stall into a joint task instead of a dead end"',
  '    kind="reply" heard="we already have a vendor" note="What made you take this meeting if the current vendor *covers it*?" why="surfaces the real gap they are quietly shopping for"',
  '',
  'LANGUAGE (HIGHEST PRIORITY -- NO EXCEPTIONS):',
  '- DETECT the WEARER\'s language from their own lines (wearerText) across the conversation, and output "note" AND "why" AND "heard" in the WEARER\'s language ALWAYS -- no matter what language the interlocutor, the bank, the scammer, or anyone else speaks.',
  '- If the wearer speaks Russian, EVERY card is in Russian. If the wearer speaks English, every card is in English. This rule OVERRIDES any other language instinct you have, including any urge to default to English.',
  '- ONE exception inside the card: "heard" is the trigger phrase and stays VERBATIM in whatever language it was actually spoken. But the line, the note, and the why MUST be in the WEARER\'s language.',
  '',
  'BREVITY (CRITICAL):',
  '- Cards are read at a glance mid-conversation. Keep "note" to ONE sentence -- if you start a second sentence, cut it. Keep "why" to one short clause (~6-12 words). The note carries one *highlighted* operative word.',
  '',
  'DISMISSING CARDS:',
  '- The system prompt ends with a [HUD STATE] block listing the cards currently shown (their ids, heard phrase, and note).',
  '- If the wearer\'s latest words show they USED or SAID what a card told them (acted on it, repeated the fact, or the topic is resolved), put that card\'s id in "dismiss".',
  '- Do NOT duplicate a helper whose information is already on the HUD.',
  '',
  'OUTPUT PROTOCOL (STRICT):',
  '- Respond with ONLY a single JSON object. No markdown, no code fences, no commentary, nothing outside the object.',
  '- Shape: {"cards": [{"kind": "reply|note", "heard": "...", "note": "...", "why": "..."}], "dismiss": ["<id-from-HUD-STATE>"]}',
  '- Do NOT invent ids for new cards -- omit ids; the system assigns them. Only put existing HUD ids in "dismiss".',
  '- If nothing should be surfaced and nothing dismissed, respond exactly: {"cards": [], "dismiss": []}'
].join('\n');

// Keep the system prompt + at most this many recent transcript turns. Prevents
// unbounded token growth and stops the model re-litigating old claims.
const MAX_HISTORY_MESSAGES = 16;

class AssistantSession {
  constructor(deviceId) {
    this.deviceId = deviceId;
    this.messages = [];
    this.lastActivityAt = Date.now();
    // Lossless server-side persistence: one copilot conversation per session.
    // resetSession deletes the session, so the next session mints a fresh id
    // and therefore a fresh conversation entry (one entry per session).
    this.copilotConversationId = crypto.randomUUID();
    this.headerWritten = false;
  }

  touch() {
    this.lastActivityAt = Date.now();
  }

  /**
   * Store ONLY the clean dialogue turn (no HUD STATE -- that is injected fresh
   * into the system prompt each turn via getMessages, so the rolling history
   * never carries stale snapshots of cards that are no longer on screen).
   * @param {string} wearerText
   * @param {string} interlocutorText
   */
  addBatch(wearerText, interlocutorText) {
    const parts = [];
    if (wearerText && wearerText.trim()) parts.push(`Wearer: ${wearerText.trim()}`);
    if (interlocutorText && interlocutorText.trim()) parts.push(`Interlocutor: ${interlocutorText.trim()}`);
    this.messages.push({ role: 'user', content: parts.join('\n') });
    this._trim();
  }

  addAssistantReply(text) {
    this.messages.push({ role: 'assistant', content: text });
    this._trim();
  }

  /**
   * Remove the most recent (trailing) user turn. Used to roll back a batch
   * whose LLM call failed, so history never ends on a dangling user message.
   */
  dropLastUserTurn() {
    if (this.messages.length > 0 && this.messages[this.messages.length - 1].role === 'user') {
      this.messages.pop();
    }
  }

  // Slide the window so transcript history stays bounded. Always keep complete
  // user/assistant pairs by trimming from the front in pairs.
  _trim() {
    while (this.messages.length > MAX_HISTORY_MESSAGES) {
      this.messages.shift();
    }
  }

  /**
   * Build the message array for the LLM. The CURRENT HUD state is appended to a
   * freshly-built system prompt each turn (not stored in history), so the model
   * always sees exactly the cards on screen right now -- never a stale trail.
   * @param {Array<{id: string, kind?: string, heard: string, note: string, why?: string}>} activeCards cards on the HUD now
   */
  getMessages(activeCards) {
    let hud;
    if (activeCards && activeCards.length > 0) {
      const lines = activeCards.map(c => {
        const kind = c.kind && c.kind.trim() ? `[${c.kind.trim()}] ` : '';
        const heard = c.heard && c.heard.trim() ? ` (heard: "${c.heard.trim()}")` : '';
        return `  ${c.id} ${kind}${heard}: ${c.note || ''}`;
      }).join('\n');
      hud = `[HUD STATE] Cards currently shown to the wearer right now (dismiss by id when used/resolved):\n${lines}`;
    } else {
      hud = '[HUD STATE] No cards currently shown.';
    }
    const system = `${SYSTEM_PROMPT}\n\n${hud}`;
    return [{ role: 'system', content: system }, ...this.messages];
  }

  isExpired(timeoutMs) {
    return Date.now() - this.lastActivityAt > timeoutMs;
  }
}

export class AssistantManager {
  constructor({ sessionTimeoutMs, llmModel, copilotStore } = {}) {
    this.sessions = new Map();
    // Optional ChatStore for lossless server-side copilot session persistence.
    this.copilotStore = copilotStore || null;
    // Per-device promise chain so concurrent batches for one device run
    // strictly one-at-a-time. Without this, two batches interleave around the
    // directLLM await, corrupting message ordering and rolling back the wrong
    // turn on error.
    this.chains = new Map();
    this.sessionTimeoutMs = sessionTimeoutMs || 30 * 60 * 1000;
    // Haiku: fastest tier AND the only model the Communicator does NOT wrap in
    // an adaptive-thinking block (thinking is forced on for sonnet/opus with no
    // opt-out). This is an ambient check firing every 5-10s where most batches
    // return empty -- low latency matters far more than deep reasoning.
    this.llmModel = llmModel || 'haiku';
    this.cleanupInterval = null;
  }

  getOrCreateSession(deviceId) {
    let session = this.sessions.get(deviceId);
    if (!session) {
      session = new AssistantSession(deviceId);
      this.sessions.set(deviceId, session);
      console.log(`[assistant] Created assistant session for device ${deviceId}`);
    }
    return session;
  }

  resetSession(deviceId) {
    this.sessions.delete(deviceId);
    console.log(`[assistant] Reset assistant session for device ${deviceId}`);
  }

  /**
   * Public entry: serialize this batch behind any in-flight batch for the same
   * device so they never interleave around the directLLM await.
   */
  enqueueBatch(deviceId, wearerText, interlocutorText, activeCards, model) {
    const prior = this.chains.get(deviceId) || Promise.resolve();
    // Swallow the prior result/error so one failed batch can't break the chain.
    const next = prior.catch(() => {}).then(() =>
      this.handleBatch(deviceId, wearerText, interlocutorText, activeCards, model)
    );
    // Keep the chain tail current; clear it once settled if nothing newer queued.
    this.chains.set(deviceId, next);
    next.catch(() => {}).finally(() => {
      if (this.chains.get(deviceId) === next) this.chains.delete(deviceId);
    });
    return next;
  }

  /**
   * Process one batch. Appends to the device's isolated session, calls the LLM,
   * parses the reply, assigns server-owned ids to new cards, and returns
   * { cards, dismiss }. The model never invents card ids -- it omits them and
   * the server mints short unique ids here. Dismiss ids are validated against
   * the cards actually on the HUD so a hallucinated id can't be emitted.
   * @param {string} deviceId
   * @param {string} wearerText
   * @param {string} interlocutorText
   * @param {Array<{id: string, kind?: string, heard: string, note: string, why?: string}>} activeCards cards on the HUD now
   * @param {string} [model]
   * @returns {Promise<{ cards: Array<{id:string,kind:string,heard:string,note:string,why:string}>, dismiss: string[] }>}
   */
  async handleBatch(deviceId, wearerText, interlocutorText, activeCards, model) {
    const session = this.getOrCreateSession(deviceId);
    session.touch();
    // Clean dialogue goes into history; the live HUD state is injected into the
    // system prompt fresh each turn via getMessages(activeCards).
    session.addBatch(wearerText, interlocutorText);

    let raw;
    try {
      const result = await directLLM(session.getMessages(activeCards), model || this.llmModel);
      raw = (result.text || '').trim();
    } catch (err) {
      // Roll back the dangling user turn so history never ends on a user
      // message (which poisons the next batch / breaks strict alternation).
      session.dropLastUserTurn();
      throw err;
    }

    // assistant_new may have reset (deleted) this session while the LLM call was
    // in flight. Discard the stale reply rather than writing it into a session
    // that no longer exists / has been replaced.
    if (this.sessions.get(deviceId) !== session) {
      console.log(`[assistant] session for ${deviceId} reset mid-batch; discarding result`);
      return { cards: [], dismiss: [] };
    }
    session.addAssistantReply(raw);

    const parsed = parseAssistantJson(raw);

    // Server owns card ids: assign a fresh short id to every new card.
    const cards = parsed.cards.map(c => ({ id: crypto.randomUUID().slice(0, 8), kind: c.kind, heard: c.heard, note: c.note, why: c.why }));
    // Only allow dismissing ids that are actually on the HUD.
    const activeIds = new Set((activeCards || []).map(c => c.id));
    const dismiss = parsed.dismiss.filter(id => activeIds.has(id));

    // Lossless server-side capture (best-effort): persist this turn to the
    // copilot store. Runs only for the still-current session (the mid-batch
    // identity guard above already returned for superseded sessions). Wrapped
    // so a persistence failure never throws and never blocks the returned
    // cards/dismiss the device is waiting on.
    if (this.copilotStore) {
      const hasContent = (wearerText && wearerText.trim()) || (interlocutorText && interlocutorText.trim());
      if (hasContent) {
        try {
          if (!session.headerWritten) {
            await this.copilotStore.createConversation({
              id: session.copilotConversationId,
              deviceId,
              deviceType: 'copilot'
            });
            session.headerWritten = true;
          }
          await this.copilotStore.appendRawTurn(session.copilotConversationId, {
            ts: new Date().toISOString(),
            wearerText,
            interlocutorText,
            cards
          });
        } catch (err) {
          console.warn(`[assistant] copilot persist failed for ${deviceId}: ${err.message}`);
        }
      }
    }

    return { cards, dismiss };
  }

  startCleanup() {
    this.cleanupInterval = setInterval(() => {
      for (const [deviceId, session] of this.sessions) {
        if (session.isExpired(this.sessionTimeoutMs)) {
          console.log(`[assistant] Assistant session expired for device ${deviceId}`);
          this.sessions.delete(deviceId);
        }
      }
    }, 60_000);
  }

  stopCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

/**
 * Parse the model's strict-JSON reply into { cards, dismiss }. Tolerates a
 * stray code fence or surrounding prose by extracting the first {...} block.
 * Returns empty arrays on any failure so a malformed batch never crashes the
 * session.
 */
export function parseAssistantJson(raw) {
  const empty = { cards: [], dismiss: [] };
  if (!raw) return empty;
  let text = raw.trim();
  // Strip code fences if the model wrapped the JSON
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  }
  // Extract the first balanced-looking object
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return empty;
  text = text.slice(start, end + 1);

  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return empty;
  }

  // Cards: each carries a "kind" ("reply" or "note"), a "heard" trigger phrase,
  // a "note" (the single line/fact, with *highlighted* spans), and a short "why"
  // rationale. ids are assigned server-side. kind defaults to "note". A card is
  // only valid with a non-empty note; heard/why tolerated empty. Brevity is
  // enforced by the prompt, not truncation (truncation would cut mid-word). We
  // keep only a high safety ceiling to stop a pathological runaway, and trim
  // heard since it is a quote that must stay short.
  const MAX_CARDS = 4;
  const SAFETY_NOTE_CHARS = 1000; // far above intended length; backstop only
  const SAFETY_WHY_CHARS = 200;
  const MAX_HEARD_CHARS = 120;
  const VALID_KINDS = new Set(['reply', 'note']);
  const cards = Array.isArray(obj.cards)
    ? obj.cards
        .filter(c => c && typeof c.note === 'string' && c.note.trim())
        .slice(0, MAX_CARDS)
        .map(c => ({
          kind: typeof c.kind === 'string' && VALID_KINDS.has(c.kind.trim().toLowerCase()) ? c.kind.trim().toLowerCase() : 'note',
          heard: typeof c.heard === 'string' ? c.heard.trim().slice(0, MAX_HEARD_CHARS) : '',
          note: c.note.trim().slice(0, SAFETY_NOTE_CHARS),
          why: typeof c.why === 'string' ? c.why.trim().slice(0, SAFETY_WHY_CHARS) : ''
        }))
    : [];
  const dismiss = Array.isArray(obj.dismiss)
    ? obj.dismiss.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim())
    : [];

  return { cards, dismiss };
}
