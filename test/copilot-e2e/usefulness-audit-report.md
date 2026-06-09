# Live Copilot Usefulness Audit -- Objection & Negotiation Focus

Evaluation only. No production code changed, nothing deployed. Run against the live
deployed orchestrator (ai namespace, clusterIP 10.43.29.220:10001) via SSH local-forward,
`ws://127.0.0.1:10901/ws/device`, model `haiku`, fresh deviceId + assistant_new per scenario,
single-in-flight, HUD newest-first cap 5. Latency was healthy throughout (~0.8-1.7s/batch).

Harness: `AI/orchestrator/copilot-audit-harness.mjs`. Raw transcript: `AI/orchestrator/copilot-audit-output.txt`.

## Scorecard

| scenario | fired/total | missed-opps | quality (1-5) | harm | objection-help |
|---|---|---|---|---|---|
| A Sales objections | 0/8 | 7 | n/a (never fired) | none | NO |
| B Investor objections | 0/8 | 7 | n/a (never fired) | none | NO |
| C Negotiation tactics | 0/8 | 7 | n/a (never fired) | none | NO |
| D Recall/factual | 2/7 | 2 | 5 | none (caught planted error) | n/a |
| E Fraud | 2/9 | 6 | 5 | none | n/a (strong but sparse) |
| F Small talk | 0/6 | 0 | n/a (correctly silent) | none (no over-fire) | n/a |

Verdict: Copilot is **completely silent on objections and negotiation (A/B/C: 0/24 helpful
batches)**. It is accurate and harmless where it does fire (D/E), and correctly silent on
small talk (F). The objection gap is total, not partial.

## Per-scenario findings (verbatim notes)

### A Sales objections -- 0/8, SILENT THROUGHOUT
Every classic objection went unaddressed: "too expensive" (b1), happy incumbent Zendesk (b2),
no budget this quarter (b3), data-residency/security (b4), certifications (b5), price hangup
(b6), build-in-house (b7). A coach would have offered reframes (ROI vs current spend, AI-triage
switching cost, pilot-now/defer-contract, EU/GDPR + SOC2 talking points, build-vs-buy TCO).
Copilot said nothing on all 7. **Objection-help: NO.**

### B Investor objections -- 0/8, SILENT THROUGHOUT
Burn-too-high (b2), crowded TAM (b3), "seen this movie / Sourcegraph stalled" (b4),
no-moat/weekend-clone (b5), data-moat-overstated + incumbent threat (b6), CAC payback (b7).
Each is a textbook objection with a known counter; Copilot surfaced zero. **Objection-help: NO.**

### C Negotiation tactics -- 0/8, SILENT THROUGHOUT
Heavy tactical pressure: budget anchor + "take it or leave it" low anchor at 60k (b2),
competitor leverage / "we don't need you" (b3), false-deadline "decision today" (b4),
ultimatum (b5), concession-trade ask (b6). No move suggestions (counter-anchor, trade not
concede, test the deadline, defend value). **Objection-help: NO.**

### D Recall/factual -- 2/7, quality 5, planted error CAUGHT
- b2 CARD heard="You run product at Vanta, right?" note="*Elena* runs product at *Drata*,
  not Vanta. *Drata* is a compliance automation platform." (correct, concise, well-highlighted)
- b4 CARD heard="the Eiffel Tower is in Berlin, correct?" note="The *Eiffel Tower* is in
  *Paris*, France, not Berlin. It was built for the 1889 World's Fair." (planted error caught)
Misses: b3 (Drata founded 2020 -- defensible to stay silent on a date it can't verify), b6
(name "Marcus" recall -- no prior fact to recall, fair). This is the feature working as designed.

### E Fraud -- 2/9, quality 5, strong but sparse
- b3 CARD: "Legitimate banks *never* ask you to read back a code over the phone. This is a
  *phishing scam*. Hang up and call your bank directly using the number on your card."
- b7 CARD: "Classic *scam escalation*. Banks never ask you to download remote-access software
  ... *Hang up immediately* and contact your bank directly."
Both notes are excellent. It correctly avoids re-firing duplicate cards (b4-b6, b8-b9 silent
because the warning is already on the HUD). The gift-card (b8) and SSN/password (b9) escalations
arguably warranted a fresh, sharper warning, but no harm -- the standing card covers it.

### F Small talk -- 0/6, correctly SILENT, no over-fire
Weather, sports, coffee, pastries, kids. Zero false positives. The default-silence behavior is
exactly right here, and is the same behavior that kills A/B/C.

## Root cause of the objection silence

The objection silence is **not a bug; it is the SYSTEM_PROMPT working as written.** In
`AI/orchestrator/src/assistant.js` the prompt scopes "help" almost entirely to factual recall and
corrections, then aggressively suppresses everything else. The load-bearing lines:

- L24: "MOST TURNS YOU OUTPUT NOTHING. This is ambient assist, not a chatbot. Small talk,
  greetings, opinions, jokes, and feelings get empty arrays."
- L25: "Stay silent unless a helper genuinely adds real value. Silence is the default and the
  safe choice."
- L29: "Surface a helper ONLY when you are HIGHLY confident. If you are not sure, stay silent."
- L30: "NEVER surface opinions, predictions, jokes, subjective judgments, contested or political
  topics, or anything time-sensitive ..."
- L31: "When unsure whether something is solid, prefer SILENCE. Bet-the-money confidence only."

Why this returns empty for A/B/C: a suggested objection counter or negotiation move is, by
nature, a **subjective judgment / recommendation / opinion** -- precisely the category L30 says
to NEVER surface. A counter-argument is also never something the model can hold with
"bet-the-money confidence" (L31) the way it can hold "Paris, not Berlin," because it is advice,
not a verifiable fact. Combined with L23-24 framing the job purely as "recall / correction of a
factual error / context," there is no category in the prompt that authorizes coaching. The model
correctly infers that an objection-counter is an opinion + low-certainty + not-recall, and the
prompt's three independent suppressors (default-silence, never-opinions, bet-the-money) each
veto it. The result is a total 0/24 on objection/negotiation batches.

## Concrete prompt recommendation (specification only -- NOT applied)

Add a distinct, bounded "conversation coaching" lane that is exempt from the
opinions/confidence suppressors *for suggestions only*, while keeping the existing high bar for
factual CLAIMS and the fraud flagging untouched. Precise changes to the `SYSTEM_PROMPT` array:

1. Add a fourth allowed card type in the JOB section (after recall/correction/context):
   "- A SUGGESTION: when the interlocutor raises an objection (price, budget, incumbent,
   security, burn, TAM, moat, CAC) or applies negotiation pressure (anchoring, ultimatum,
   deadline, 'take it or leave it', competitor leverage), you MAY surface ONE concise suggested
   counter, reframe, or move to help the wearer respond. This is the only case where a
   recommendation is allowed."

2. Scope the guardrails to factual claims only. Rewrite L30/L31 to say the
   NEVER-opinions / bet-the-money-confidence rules apply to **factual claims and corrections**,
   NOT to coaching suggestions. Keep: "Never fabricate specific figures, names, or facts even
   inside a suggestion." This preserves the D/E behavior (no hallucinated financials, fraud
   still flagged) while unblocking A/B/C.

3. Make suggestions visually distinguishable from recall. Require a lead-in word so the wearer
   never mistakes advice for a verified fact, e.g. note must start with "Try: " or "Counter: "
   for the suggestion type (factual cards keep the plain declarative form). Example target
   output for A/b3: heard="we have zero budget left this quarter" note="Try: *pilot now*,
   defer the annual contract to next quarter's budget -- no spend this period."

4. Threshold tuning (note the trade-off explicitly): keep "only when it CLEARLY helps -- at most
   one suggestion per objection, do not coach small talk or routine back-and-forth." More firing
   means more HUD noise; cap suggestions and keep default-silence for non-objection turns so F
   stays clean. Do NOT loosen the fraud/factual paths.

Net effect: A/B/C gain actionable, clearly-labeled suggestions; D/E/F behavior is preserved
because the hallucination guardrail stays scoped to factual claims and the coaching lane only
opens on detected objection/negotiation triggers.
