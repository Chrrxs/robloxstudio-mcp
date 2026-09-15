# 07 — many concurrent agents: `queued_ahead`/`waitedMs`, automatic dedupe, timeout guidance

Field report item 7. Studio evidence comes from a managed baseplate opened by the test runner; the
test client runs in proxy mode (the runner owns the primary server's port), so the
proxy → primary → plugin chain is verified as well.

## Symptom / reproduction

```
node tests/run-with-test-port.mjs tests/run-all.mjs --managed --test field-2026-09-15/07-queue-dedupe.mjs
```

Red (before the fix): the same `Instance.new("Folder")` code was sent twice without
`operation_id`, both ran, and the result carried no `operationId`/`deduplicatedFrom`/`queued_ahead`
fields:

```
=== TODO#7 queue metrics, automatic dedupe, timeout guidance ===
--- (b) same code, no operation_id → single dispatch ---
{"label":"first","timestamp":"2026-09-15T08:22:08.006Z","body":{"returnValue":"Dedupe","message":"Code executed successfully","success":true,"output":[]}}
{"label":"second","timestamp":"2026-09-15T08:22:08.006Z","body":{"returnValue":"Dedupe","message":"Code executed successfully","success":true,"output":[]}}
❌ TODO#7 queue metrics, automatic dedupe, timeout guidance FAILED: result carries operationId
+ actual - expected
+ 'undefined'
- 'string'
Closed managed Studio instance instance:4pi-p7x
========== SUMMARY ==========
  ❌ FAIL  todo-2026-09-15/07-queue-dedupe.mjs
0/1 passed.
=== 07 exit=1
```

(Section labels and assertion messages were translated; the tool output lines are verbatim from
the original run.)

## Design and rationale

**(b) Automatic dedupe.** When `operation_id` is omitted the server derives the identity
`auto-<sha256(JSON{targetPeerId, endpoint, data})>` (`bridge-service.ts` `autoOperationId`). The
report suggested `instance_id + target + code`; the **resolved peer id** is used instead: the peer id
already encodes instance + role, and when play mode restarts the client peer changes — an
instance+target hash would stay the same while the fingerprint changed, and the bridge would answer
`operation_id_collision`. Same peer + same endpoint + same `data` (code) ⇒ same identity ⇒ the
bridge's existing replay protection applies.

Decision table (`tools/index.ts` `_resolveAutoOperation`; every attempt is checked with
`getRequestStatusEverywhere`, i.e. over HTTP to the primary in proxy mode):

| Previous `auto-…` record | Behavior | Result fields |
|---|---|---|
| none (or the 5-minute retention expired) | the code runs | `dedupe:"auto"`, `operationId` |
| `pending` (queued/dispatched/executing) | the same promise is shared, **no second dispatch** | `deduplicatedFrom:<id>` |
| `settled` and **delivered** to its waiter (no `waiterEndedAt`) | deliberate rerun: **runs** as `auto-<hash>-2`, `-3`, … | `dedupe:"auto"` |
| `settled` but **undelivered** (`waiterEndedAt` set: the waiter left through timeout/abort/disconnect and the result arrived later), result retained | the retained outcome is returned, the code does not run | `deduplicatedFrom:<id>` |
| `executionOutcome: not_executed` (timed out in the queue, never dispatched) | safe: runs under the next attempt id (at most 16, then a random UUID) | `dedupe:"auto"` |
| timed_out/aborted but dispatched and not yet settled (outcome unknown), or an undelivered result that was evicted | **not run**; `operation_not_replayed` error: "…call get_request_status with operation_id <id>; do not resend; pass dedupe:false or a new operation_id to run it again" | — |

**Revision of the rule.** The first version also deduplicated a delivered retained result. That
broke `tests/runtime-bridge-lifecycle.mjs`: the test sends the same
`task.spawn(function() StudioTestService:ExecutePlayModeAsync({}) end) return true` code without
`operation_id` in two separate phases; the second call received the retained result and never
started play ("Timed out waiting for roles edit, server, client-1"). Final rule: **a delivered
result never blocks a rerun** — a caller that already holds the result and sends the same code again
is asking for a deliberate rerun. Automatic dedupe targets only the real damage scenario from the
field: a request whose waiter left through a timeout (`waiterEndedAt`) and whose result reached
nobody. The criterion is the `waiterEndedAt` that `bridge-service.ts` `endRequestWaiter` sets (it
survives `recordResponse`).

Why an unknown outcome is not re-run: this is exactly where the field damage happened (60 s timeout
→ the agent resent the same code → decor was placed twice). Unknown does not mean "did not run";
the agent must look at `get_request_status` first. Two explicit doors remain for a deliberate
rerun: `dedupe:false` (random UUID identity) or a new `operation_id`. Automatic dedupe is active only
when `operation_id` is omitted and `dedupe` is not `false`; the result then always carries
`dedupe:"auto"` so "why did it not run a second time" stays visible.

Two identical requests in the same millisecond: in primary mode the second one gets
`deduplicatedFrom` through the synchronous `getRequestStatus` check; in proxy mode, if two different
proxies send at the same instant, the bridge still dispatches once but the second result may lack
the `deduplicatedFrom` marker (marker only; the execution count is preserved).

**(a) `queued_ahead` / `waitedMs`.** When `bridge.sendRequest` enqueues, it records the number of
not-yet-settled requests on the same transport peer (the same Studio connection; edit + server share
one transport) as `status.queuedAhead` (`countQueuedAhead`). `waitedMs = (executionStartedAt ??
dispatchedAt ?? settledAt) − queuedAt` (the plugin's "executing" progress event reaching the
server). `execute_luau` and `export_rbxm` results carry `operationId`, `queued_ahead`, `waitedMs`;
`get_request_status` also shows `queuedAhead` (one line in the proxy's `parseRequestStatus`,
`proxy-bridge-service.ts`).

**(c) Timeout text.** `endRequestWaiter` appends `; call get_request_status with operation_id
<id>; do not resend` to its message; the error body already carried `requestId`.

## Fix (files)

- `packages/core/src/bridge-service.ts`: `RequestStatus.queuedAhead`,
  `operationFingerprint`/`autoOperationId`, `countQueuedAhead`, recorded in `sendRequest`, timeout
  text.
- `packages/core/src/tools/index.ts`: `executeLuau` new `dedupe` parameter; `_dispatchOperation`,
  `_queueMetrics`, `_resolveAutoOperation`; `exportRbxm` goes through the same path and reports the
  metrics.
- `packages/core/src/tools/definitions.ts`: `execute_luau` schema `dedupe` (`"auto"` | `false`),
  `operation_id` description.
- `packages/core/src/http-server.ts`: `body.dedupe` is passed through.
- `packages/core/src/proxy-bridge-service.ts`: `queuedAhead` parsed (so it is visible in proxy mode;
  one line).
- `managed-instance-registry.ts` untouched: it is the managed-Studio launch registry and has nothing
  to do with the request queue.
- Plugin (`CooperativeJobRunner.ts`) unchanged: dedupe and queue counting live in one place on the
  server; the plugin already refuses a requestId it has seen (`terminalResponseIds`).

## Green (final rule; managed baseplate `instance:baz-j4f`, 2026-09-15 10:47 UTC)

Command: `node tests/run-with-test-port.mjs tests/run-all.mjs --managed --test field-2026-09-15/07-queue-dedupe.mjs`

```
=== field #7 queue metrics, automatic dedupe, timeout guidance ===
--- (b) delivered result: same code, no operation_id → deliberate rerun (2 dispatches) ---
{"label":"first","timestamp":"2026-09-15T10:47:08.026Z","body":{"returnValue":"Dedupe","message":"Code executed successfully","success":true,"output":[],"truncated":false,"totalBytes":6,"returnedBytes":6,"maxOutputBytes":65536,"operationId":"auto-a5ae90589cba48202ffc6beec8c066772674a22f4ef564480b924fab03d9719e","queued_ahead":0,"waitedMs":7,"dedupe":"auto"}}
{"label":"second","timestamp":"2026-09-15T10:47:08.027Z","body":{"returnValue":"Dedupe","message":"Code executed successfully","success":true,"output":[],"truncated":false,"totalBytes":6,"returnedBytes":6,"maxOutputBytes":65536,"operationId":"auto-a5ae90589cba48202ffc6beec8c066772674a22f4ef564480b924fab03d9719e-2","queued_ahead":0,"waitedMs":6,"dedupe":"auto"}}
--- (b) dedupe:false → runs again ---
{"label":"forced","timestamp":"2026-09-15T10:47:08.059Z","body":{"returnValue":"Dedupe","message":"Code executed successfully","success":true,"output":[],"truncated":false,"totalBytes":6,"returnedBytes":6,"maxOutputBytes":65536,"operationId":"7b07d9dd-7dd0-4311-8003-3063dd521571","queued_ahead":0,"waitedMs":11}}
--- (b) new operation_id → runs again ---
{"label":"explicit","timestamp":"2026-09-15T10:47:08.092Z","body":{"returnValue":"Dedupe","message":"Code executed successfully","success":true,"output":[],"truncated":false,"totalBytes":6,"returnedBytes":6,"maxOutputBytes":65536,"operationId":"field07-1789469228075","queued_ahead":0,"waitedMs":12}}
--- (b) UNDELIVERED result: short waiter timeout → same code again → the code runs once ---
{"label":"slow via /proxy timeoutMs=1000","timestamp":"2026-09-15T10:47:09.142Z","status":500,"body":{"error":"Request timeout: auto-099b6d8407bd473538ac327f24826a87dc4b0e503f7fbe13e998f8277f166c04; executing; unknown; waiter ended, execution is not cancelled or rolled back; call get_request_status with operation_id auto-099b6d8407bd473538ac327f24826a87dc4b0e503f7fbe13e998f8277f166c04; do not resend","code":"request_timeout","details":{"requestId":"auto-099b6d8407bd473538ac327f24826a87dc4b0e503f7fbe13e998f8277f166c04","targetPeerId":"peer:g41-nix","stage":"executing","outcome":"unknown","executionStartedAt":1789469228139,"executionOutcome":"unknown"}}}
{"label":"immediate resend (still executing)","timestamp":"2026-09-15T10:47:09.145Z","body":{"error":"operation_not_replayed","message":"Request auto-099b6d8407bd473538ac327f24826a87dc4b0e503f7fbe13e998f8277f166c04 already exists: timed_out; executing; unknown; identical code was sent to this peer within the retention window, its waiter ended and its outcome is unknown; call get_request_status with operation_id auto-099b6d8407bd473538ac327f24826a87dc4b0e503f7fbe13e998f8277f166c04; do not resend; pass dedupe:false or a new operation_id to run it again","requestId":"auto-099b6d8407bd473538ac327f24826a87dc4b0e503f7fbe13e998f8277f166c04","targetPeerId":"peer:g41-nix","stage":"executing","outcome":"unknown"}}
{"label":"status after late settle","timestamp":"2026-09-15T10:47:19.178Z","body":{"requestId":"auto-099b6d8407bd473538ac327f24826a87dc4b0e503f7fbe13e998f8277f166c04","targetPeerId":"peer:g41-nix","queuedAt":1789469228135,"stage":"response_delivery","state":"settled","outcome":"success","executionOutcome":"success","executionStartedAt":1789469228139,"executionCompletedAt":1789469236156,"queuedAhead":0,"dispatchedAt":1789469228135,"settledAt":1789469236156,"waiterEndedAt":1789469229141,"response":{"returnValue":"SlowDedupe","message":"Code executed successfully","success":true,"output":[]}}}
{"label":"resend after undelivered settle","timestamp":"2026-09-15T10:47:19.182Z","body":{"returnValue":"SlowDedupe","message":"Code executed successfully","success":true,"output":[],"truncated":false,"totalBytes":10,"returnedBytes":10,"maxOutputBytes":65536,"operationId":"auto-099b6d8407bd473538ac327f24826a87dc4b0e503f7fbe13e998f8277f166c04","queued_ahead":0,"waitedMs":4,"dedupe":"auto","deduplicatedFrom":"auto-099b6d8407bd473538ac327f24826a87dc4b0e503f7fbe13e998f8277f166c04"}}
--- (a) 5 parallel execute_luau → queued_ahead 0..4, waitedMs ---
{"label":"parallel","timestamp":"2026-09-15T10:47:23.241Z","elapsedMs":4049,"queuedAhead":[0,1,2,3,4],"waited":[8,7,8,7,2022],"operationIds":["53744874-05eb-4665-8bb9-47e1e976d033","3d896dfc-a689-48ac-aa47-3b4b2aabff3c","7c5215f1-20ed-4da8-9d65-df5f3afe4411","b4cadb24-0f64-4df8-b6e3-786298299e1f","c89f5c41-56df-4620-a311-ee4054c1d17d"]}
--- (a) export_rbxm result carries queued_ahead + waitedMs ---
{"label":"export","timestamp":"2026-09-15T10:47:23.276Z","body":{"bytes_written":602,"instance_count":1,"output_path":"C:\\Users\\<user>\\AppData\\Local\\Temp\\field07-64032.rbxm","operationId":"631abbea-7cee-4f34-bc04-2d32f66e0cc9","queued_ahead":0,"waitedMs":11}}
--- (c) timeout error text: get_request_status guidance + operation_id ---
{"label":"timeout","timestamp":"2026-09-15T10:47:53.284Z","body":{"error":"request_timeout","message":"Request timeout: field07-timeout-1789469243276; executing; unknown; waiter ended, execution is not cancelled or rolled back; call get_request_status with operation_id field07-timeout-1789469243276; do not resend","requestId":"field07-timeout-1789469243276","targetPeerId":"peer:g41-nix","stage":"executing","outcome":"unknown","executionOutcome":"unknown","executionStartedAt":1789469243289}}
{"label":"status after timeout","timestamp":"2026-09-15T10:47:53.286Z","body":{"requestId":"field07-timeout-1789469243276","targetPeerId":"peer:g41-nix","queuedAt":1789469243278,"stage":"executing","state":"timed_out","outcome":"unknown","executionOutcome":"unknown","executionStartedAt":1789469243289,"queuedAhead":0,"dispatchedAt":1789469243278,"waiterEndedAt":1789469273283}}

✅ field #7 queue metrics, automatic dedupe, timeout guidance PASSED
Closed managed Studio instance instance:baz-j4f

========== SUMMARY ==========
  ✅ PASS  field-2026-09-15/07-queue-dedupe.mjs

1/1 passed.
```

Numbers: same code x2 (delivered) → **2** Folders, second `operationId = auto-…-2`, no
`deduplicatedFrom`; `dedupe:false` → 3; new `operation_id` → 4. Undelivered scenario: the
`task.wait(8)` code sent to the primary's `/proxy` endpoint with `timeoutMs:1000` → `request_timeout`
after 1 s (with the guidance sentence); the same code immediately again → `operation_not_replayed`
(still executing); after 10 s the `SlowDedupe` count is **1**, `get_request_status` →
`state:settled` with `waiterEndedAt`; the same code again → `deduplicatedFrom: auto-…`, count still
**1**. 5 parallel `task.wait(2)` → `queued_ahead` set {0,1,2,3,4}. `export_rbxm` → `queued_ahead`
and `waitedMs` present. `task.wait(40)` → `request_timeout` at 30 s + guidance.

Regression runs in the same session (separate managed Studios): `runtime-bridge-lifecycle.mjs`
(failed under the first version with "Timed out waiting for roles edit, server, client-1"),
`execute-luau-output-capture.mjs`, `luau-payload-transfers.mjs` — see the PR description for the
results.

## Regression (unit / static)

- Jest: `field-07-queue-dedupe.test.ts` — "field #7 queue position and timeout guidance" (2 tests:
  `queuedAhead` per transport; timed-out waiter message names `get_request_status` and the id) and
  "field #7 automatic execute_luau dedupe without operation_id" (9 tests: identical code while
  pending → one dispatch + `deduplicatedFrom`; identical code after a delivered result → two
  dispatches (`-2`, `-3`), no `deduplicatedFrom`; identical code after a late-settled undelivered
  request (`waiterEndedAt`) → dedupe; different code → two dispatches with `queued_ahead` 0/1;
  `dedupe:false` and a new `operation_id` → re-dispatch; after 5 minutes (fake timers) →
  re-dispatch; dispatched timeout → `operation_not_replayed`; never-dispatched timeout → `auto-…-2`;
  `max_output_bytes` accounting). Two existing tests in `request-recovery-tools.test.ts` and
  `payload-timeout-diagnostics.test.ts` switched from `toEqual` to `toMatchObject` because the
  result now carries the new fields, and the latter asserts the timeout guidance sentence.
- `npm run typecheck`: green. `npm run lint`: 7 pre-existing errors, no new ones.
  `npm test -w packages/core`: green (see the PR description for the counts).
