# RC transcript: JSONL-authoritative merge (kill stale phone transcript)

Date: 2026-07-16

## Problem

When an RC coding session runs PC -> phone -> PC, the phone shows an outdated
transcript. The final PC leg runs Claude Code directly (outside the live RC
WebSocket relay), so its turns land only in Claude Code's on-disk JSONL and never
reach MongoDB. The phone renders MongoDB, which froze at the last relayed turn.

Verified on session `78856ee3` (workDir `/home/varingait`):
- MongoDB `rc_session_end` at 13:23:36; last renderable content well before that.
- JSONL on disk updated 13:44:59 (21 min / many turns later).
- JSONL export = 324 current entries (34 user_message, 129 rc_message, 161
  rc_tool_status); MongoDB rendered only ~35 assistant turns.

The phone code is correct: it loaded 663 Mongo entries -> 237 messages and
rendered them. The data source was stale, not the client.

## Why the first design was wrong

The phone's HTTP transcript fetch FAILS (`connection closed`, self-signed cert /
network). The phone actually renders via the **WebSocket** `rc_transcript`
messages. There are four transcript-serving paths; only the HTTP one had a JSONL
fallback:

| Path | Location | JSONL fallback (before) | Phone uses |
|------|----------|--------------------------|-----------|
| HTTP GET `/transcript` | gateway.js ~1370 | yes | no (fails) |
| WS `rc_transcript_request`, live session | rc-handler.js ~1690 | no | YES |
| WS `rc_transcript_request`, ended session | rc-handler.js ~1412 | no | YES |
| WS `notifyPhoneReconnect` | rc-handler.js ~1991 | no | YES |

Fixing only the gateway would have changed nothing observable.

## Design

JSONL (Claude Code's native record) becomes the authoritative conversation spine.
MongoDB is demoted to a side-channel for phone-only entries (permission cards),
plus the session index / pending queue (unchanged). No phone changes.

### Shared helper (rc-handler.js)

```
async function buildMergedTranscript(sessionId, workDir):
  mongoP  = rcStore.getTranscript(sessionId)          // always
  jsonlP  = exportJsonlCoalesced(sessionId, workDir)  // injected; may reject/empty
  [mongo, jsonl] = await Promise.allSettled([mongoP, jsonlP])
  mongoArr = mongo.value || []
  if jsonl.fulfilled and Array.isArray(jsonl.value) and jsonl.value.length > 0:
     spine = jsonl.value
     perms = mongoArr.filter(e => e.type === 'rc_permission_request'
                               || e.type === 'rc_permission_resolved')
     return stableMergeByTs(spine, perms)   // spine first on ts ties
  return mongoArr                            // no regression path
```

- `stableMergeByTs`: concat then `sort((a,b)=> a.ts<b.ts?-1 : a.ts>b.ts?1 : 0)`
  (V8 sort is stable, so equal-ts keeps spine-before-perms insertion order).
- JSONL `ts` and Mongo `ts` are both ISO-8601 strings -> lexicographic compare is
  chronological. Verified against the real export.

### Dependency injection (no circular import)

- `initRcHandler(store, connections, options)` gains
  `options.exportJsonl = (workDir, sessionId) => Promise<Array>`.
- index.js supplies it, reusing the pattern it already runs at lines 82-89:
  `getAgent('pc-agent')` + `sendDirectAgentRequest(..., action:
  'remote_session_export_transcript', workDir, sessionId, 60000)` ->
  `response.data.transcript`. Returns `[]` on missing agent / missing workDir /
  error (never throws to caller; helper treats empty as "use Mongo").
- gateway does NOT import index (verified) -> no cycle. index already imports
  `sendDirectAgentRequest` from gateway and `getAgent` from registry.

### Call-site changes

Replace the raw `rcStore.getTranscript(sessionId)` used to BUILD the phone
payload in all three WS paths with `buildMergedTranscript(sessionId, workDir)`:
- live `rc_transcript_request`: workDir from in-memory `session.workDir`.
- ended `rc_transcript_request`: session not in memory -> `rcStore.get(sessionId)`
  for workDir (this path already looks up the store).
- `notifyPhoneReconnect`: workDir from in-memory session.

Gateway HTTP path: replace its bespoke inline fallback with the same helper for
consistency (it already has `existing.workDir`).

Do NOT touch the OTHER `getTranscript` calls (dedup-LRU seeding, etc.) — only the
ones that build a transcript payload sent to the phone.

## Poor-connectivity / race hardening

- **In-flight coalescing**, not a TTL cache: `Map<sessionId, Promise>` cleared on
  settle. The phone's open-storm (HTTP retry + WS request + reconnect can all
  fire within ~1s) collapses to ONE shell-out. A TTL cache could serve stale
  content; coalescing cannot — every settled call reflects disk at call time.
- Export failure (pc-agent offline, session on another machine, timeout) ->
  helper returns Mongo. Strict no-regression.
- Export runs with the existing 60s timeout + 256MB buffer already in
  `exportTranscript`.
- Merge is O(n log n) on ~330 entries; negligible.

## Blast radius / safety

- Phone: zero changes. Payload stays `{ ts, type, data }[]`; parser already
  renders a superset of the merged types. Mongo-only non-rendered types
  (`rc_thinking`, `rc_error`, `rc_session_end`) simply stop appearing in resumed
  history — phone never rendered them anyway. Live streaming path untouched.
- Merged payload is SMALLER than today (no `rc_thinking` spam) -> less WS load.
- MongoDB writes unchanged; still the source for session list / permissions /
  pending queue. Only the READ that builds the phone transcript changes.
- If pc-agent is down, behavior == today (Mongo). No new hard dependency.

## Out of scope

- Fixing the phone's HTTP transcript failure (separate; WS path is the one that
  matters and is now correct).
- Removing MongoDB entirely (session index + permissions + queue still need it;
  bigger refactor, explicitly deferred).

## Test plan

1. Unit: `buildMergedTranscript` with (a) jsonl+perms, (b) jsonl empty ->
   Mongo, (c) export throws -> Mongo, (d) ts-tie ordering stable.
2. Integration: run export helper against session `78856ee3`, assert merged
   length ~= jsonl + mongo-perms and strictly ascending `ts`.
3. E2E: open `78856ee3` on the phone, assert `parseAndLoadTranscript fetched=`
   count jumps from 663 to the merged count and last user turn == the 13:44 one.
