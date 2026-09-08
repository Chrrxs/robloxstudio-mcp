# Reliable large Luau inputs

Use `execute_luau` with an explicit `instance_id` and `target: "edit"` for place edits. Call `get_connected_instances` first; never choose a different place merely because the original connection disappeared. For generated geometry, a small deterministic loop is usually better than thousands of repeated source lines. For genuinely large source, stage byte-bounded chunks, read each back, validate the assembled source, and execute once behind a retained completion marker.

This is an **existing-tool recipe**, not a new upload protocol. The reusable [workflow helper](../tests/lib/large-input-workflow.mjs) generates the exact Luau programs used by the [native Studio regression](../tests/large-input-workflow.mjs). It uses only `execute_luau`, `ServerStorage` folders, `StringValue` chunks, attributes, `EncodingService`, and `loadstring`. The helper is a repository example, not an npm package export. Use a current Node.js release (22 or newer) to run it.

## Limits are encoded bytes, not source characters

| Configured admission limit | Bytes | What is counted |
| --- | ---: | --- |
| Incoming stdio JSON-RPC line | 83,886,080 (80 MiB) | Entire UTF-8 JSON line, excluding the terminating LF; a CR in CRLF counts |
| Local HTTP request body, including HTTP proxy requests | 52,428,800 (50 MiB) | Entire serialized UTF-8 JSON body, not just `code` |
| Studio transport request/frame and retained response ceiling | 67,108,864 (64 MiB) | Encoded transport payload, including its envelope |

A source string below a limit can still exceed it after JSON escaping and envelope overhead. A source that returns or prints a huge value can exceed the **response** limit even when its request is tiny. Successful execution and successful result delivery are separate facts. Keep mutation responses small and verify effects with a separate small readback. `set_properties` with `operation_id` can also write staged text, but it still needs ownership, readback, and final assembly checks; splitting calls alone is not a transaction.

For `set_properties`, **HTTP 200 or a normal MCP result is not all-writes success**. Require `summary.failed === 0` and inspect every per-property entry in `results`, then read back the intended values. Successful writes in a partially failing batch are preserved; a known property error can therefore coexist with side effects. Native property-size failures expose `results[].details` with `stage: "property_write"`, actual `bytes`, and `limitBytes: 199999`. Even when every property write fails, rejection does not roll back earlier unrelated `execute_luau` edits. Do not retry the whole batch blindly.

The stdio adapter rejects an oversized line with a protocol-level JSON-RPC `-32600` error (`id: null`, `code: "stdio_request_too_large"`, actual `bytes`, `limitBytes`, `transportStage: "stdio_receive"`, and `executionOutcome: "not_executed"`). It discards through that line's LF and can accept the next valid line instead of poisoning the stream. There is no recoverable operation ID for this unparsed input; a client SDK may not correlate the `id: null` diagnostic to its pending tool call, so inspect protocol errors as well as tool timeouts. Malformed UTF-8/JSON or truncated input at EOF produces `-32700`. This is an outer stdio admission limit, **not** permission to exceed the inner 64 MiB Studio frame limit. Sustained stdout backpressure has a separate 256 MiB aggregate serialized-output budget; exceeding that closes the transport rather than retaining unbounded queued responses.

Storage properties have their **own** limits, independent of transport admission. [Roblox documents `StringValue.Value`](https://github.com/Roblox/creator-docs/blob/main/content/en-us/reference/engine/classes/StringValue.yaml) as limited to 200,000 characters, with `String too long` above that. Native Studio build **0.737.0.7371584** instead rejected a provided string length **greater than or equal to 200,000**: both 199,999 ASCII bytes and 99,999 copies of `é` plus one ASCII byte succeeded; 200,000/200,001 ASCII bytes and 100,000 copies of `é` (200,000 UTF-8 bytes) failed. Treat the observed property ceiling as **199,999 UTF-8 bytes**, not 200,000 Unicode characters. This helper caps each `StringValue` at a conservative 16 KiB of UTF-8 source bytes and stores only compact manifest metadata/digests in attributes, not the entire large source or manifest string.

The [strict native boundary regression](../tests/studio-payload-boundaries.mjs) passed on Windows Studio build **0.737.0.7371584** with the matching server/plugin. These measurements establish the exercised routes and encoded envelopes, not a guarantee for every engine build, source program, or system load:

| Exercised path | Observed result |
| --- | --- |
| `execute_luau`, primary stdio to native Studio | Exact 1 MiB, 16 MiB, 50 MiB + 1 byte, and 64 MiB Studio request frames executed successfully with verified effects. The 64 MiB case took 4,075 ms. |
| `set_properties`, primary stdio to native Studio | Those same frame sizes reached native property validation; oversized `StringValue.Value` writes correctly failed at `property_write`, without rolling back earlier Luau effects. |
| Studio request admission, both tools | A 67,108,865-byte (64 MiB + 1) frame was rejected at `server_send` with actual bytes, the 67,108,864-byte limit, and `not_executed`; no frame was dispatched. |
| `execute_luau` through the authenticated HTTP bridge | An actual 52,428,800-byte HTTP body succeeded (2,907 ms). |
| `set_properties` through the authenticated HTTP bridge | A 52,428,800-byte body was admitted (HTTP 200) and reached the expected native property-size rejection. |
| HTTP admission for `execute_luau` and `set_properties` | 52,428,801-byte bodies returned HTTP 413 with actual bytes, limit, and `http_receive` diagnostics; neither dispatched to Studio. |
| Native Studio response delivery through primary stdio | Exact 1 MiB and 64 MiB ASCII response frames succeeded; a separately calibrated quote-rich response also produced an exact 64 MiB frame and reached the client (2,925 ms). |
| Native Studio response encoding | A would-be 67,108,865-byte response produced a bounded `response_encode` size error instead of a timeout; status retained `executionOutcome: "success"` and effect readback proved one execution. |
| Same-folder staging | Four 65,536-byte chunks assembled to 262,144 bytes with matching SHA-256. This separate capacity probe does not change the workflow helper's conservative 16 KiB chunk ceiling. |

The strict run reported no unexpected failures or cleanup errors and confirmed managed Studio closure. Exact 64 MiB responses could be delivered while their retained result payloads were subsequently evicted for capacity; successful delivery is not a promise of indefinite result availability. Separate non-native stdio regressions exercised the actual inclusive 80 MiB input-line cap and cap + 1 rejection/recovery. The workflow defaults to **16 KiB of source UTF-8 per chunk**, intentionally far below admission/property ceilings; that is a conservative recipe ceiling, not a transport maximum or a promise about HTTP quotas. Send chunks sequentially; don't flood Studio with concurrent edits or retry loops.

## Transfer identity and ownership

Choose one fresh random `transferId` for the whole transfer. Choose a fresh `operation_id` for **each distinct step** (begin, chunk write, chunk readback, finalization, inspection, abort). The helper generates these IDs. Save each returned argument object before sending it. Reuse an operation ID only with the **identical tool, arguments, target, and instance** when recovering that exact call; never change the code under an old ID.

The helper creates `ServerStorage.__RSMCP_Transfer_<transferId>` with:

- `Archivable = false`, an `Owner` attribute equal to the transfer ID, and an immutable SHA-256 fingerprint of the exact serialized manifest;
- expected chunk count, total UTF-8 bytes, and whole-source SHA-256 as compact attributes; the client journal and generated steps retain the manifest's ordered per-chunk byte count/SHA-256 list;
- an owned, nonarchivable `Chunks` folder of owned, nonarchivable `StringValue`s, each with an explicit 1-based index;
- a state of `uploading`, `executing`, `failed`, or `completed` and, on completion, a compact cached result.

It refuses an unowned root/name collision. Destructive cleanup checks the owner and nonarchivable flag of **every descendant first**, not just the root. A name prefix is not ownership. These attributes prevent accidental deletion, not hostile code in the same DataModel from impersonating an owner. Do not put unrelated objects in staging folders.

`Archivable = false` prevents staging from being saved/cloned; it does not make staging survive closing Studio. Completion markers intentionally remain in the current edit DataModel after chunk cleanup. Deleting a marker, reloading the place, using another DataModel, or losing the client journal removes evidence; none proves the recipe did not execute.

## Copyable deterministic Parts example

Start the matching MCP server/plugin, select an edit instance with `get_connected_instances`, then run this **once from the repository root**. Set `MCP_INSTANCE_ID` to that exact ID. The example talks to the authenticated HTTP bridge on `ROBLOX_STUDIO_PORT` (default 58741), using `ROBLOX_STUDIO_AUTH_TOKEN` or the usual token file. Keep the generated journal private: it contains your source.

```bash
export MCP_INSTANCE_ID='instance:replace-with-the-selected-edit-instance'
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLargeInputTransfer, deterministicPartsRecipe } from './tests/lib/large-input-workflow.mjs';
import { callMcpHttpTool } from './tests/lib/mcp-http-client.mjs';

const instanceId = process.env.MCP_INSTANCE_ID;
assert.ok(instanceId, 'Select and set MCP_INSTANCE_ID first');
const transferId = randomUUID();
const recipe = deterministicPartsRecipe(transferId, 40);
// For a real large program, replace recipe.source with readFileSync(path, 'utf8')
// and provide an independent recipe.verification program returning true only
// when the intended effects are correct. Do not normalize or trim the source.
const options = { instanceId, transferId, ...recipe, chunkBytes: 16 * 1024 };
const transfer = createLargeInputTransfer(options);
const port = Number(process.env.ROBLOX_STUDIO_PORT ?? 58741);
const env = {
  ...process.env,
  ROBLOX_STUDIO_AUTH_TOKEN: process.env.ROBLOX_STUDIO_AUTH_TOKEN
    ?? readFileSync(join(homedir(), '.robloxstudio-mcp/auth-token'), 'utf8').trim(),
};
// Exclusive creation prevents blindly rerunning this script after a lost response.
writeFileSync('transfer-plan.json', JSON.stringify(options), { flag: 'wx', mode: 0o600 });
async function send(label, args) {
  appendFileSync('transfer-steps.jsonl', JSON.stringify({ label, args }) + '\n', { mode: 0o600 });
  const result = await callMcpHttpTool('execute_luau', args, { port, env });
  assert.equal(result.success, true, JSON.stringify(result));
  console.log(label, result.returnValue);
  return String(result.returnValue);
}
await send('begin', transfer.begin());
for (let i = 0; i < transfer.chunkCount; i++) {
  await send(`write-${i}`, transfer.writeChunk(i));
  assert.equal(await send(`read-${i}`, transfer.readChunk(i)), 'true');
}
assert.equal(await send('finalize', transfer.finalize()), 'complete');
assert.equal(await send('inspect', transfer.inspect()), 'completed');
// Independent verification remains possible after all source chunks are removed.
assert.equal(await send('verify-geometry', {
  instance_id: instanceId, target: 'edit', operation_id: randomUUID(),
  code: recipe.verification,
}), 'true');
console.log('Verified 40 anchored 1x2x3 Parts in', recipe.outputName);
JS
```

The recipe creates exactly 40 uniquely named anchored Parts in a model with transfer ownership attributes, a 10-column grid spaced 4 studs apart, fixed dimensions, color, and material. Verification checks every part's type, name, owner, size, full CFrame, color, material, and the exact child count. An existing output name is an error, not permission to delete or duplicate it. Use a fresh transfer/output identity for a genuinely new operation; retain the previous journal until recovery is resolved.

### What finalization guarantees

1. Chunk splitting iterates Unicode code points while counting their UTF-8 bytes; it never splits a multi-byte character or silently accepts lone surrogates. Luau string escaping preserves quotes, control characters, and newlines. Do not slice JavaScript strings by arbitrary UTF-16 offsets or independently decode arbitrary byte slices.
2. Each write validates its index-specific bytes and hash. A duplicate write is accepted only when the existing value and ownership agree. A separate readback recomputes bytes and hash; only `true` permits the next step.
3. Finalization requires the exact child count and indexed names, checks ownership, rejects missing/extra/malformed chunks, and recomputes every per-index digest in numeric order. Swapped contents fail their per-index hashes. It then checks the **assembled source's total bytes and SHA-256 before calling `loadstring`**. Identical chunks are interchangeable only where doing so leaves exactly the same source bytes.
4. Both execution and independent verification programs must compile before the marker changes to `executing`. A compile failure or corrupt/incomplete transfer remains `uploading` and executes zero source. No yielding occurs between the state check and the `executing` marker.
5. After execution, verification must return `true`. Any execution/verification error records `failed`; this means effects may already exist. Neither `executing` nor `failed` is replayable.
6. It records `Result = "complete"` and `State = "completed"` **before deleting owned chunks**. Repeated finalization returns that marker without running the source again, even with a new transport operation ID. If cleanup itself fails, completion is still recorded; inspect the unexpected descendant instead of rerunning the recipe. A repeated finalization is a cached result, not a fresh geometry verification.

Hash representation is explicit: [Roblox's official `EncodingService:ComputeStringHash` contract](https://github.com/Roblox/creator-docs/blob/main/content/en-us/reference/engine/classes/EncodingService.yaml) returns a string of **binary digest bytes**, not hex. The helper asserts 32 bytes for SHA-256, formats every byte as two lowercase hex digits, and compares that with Node's `createHash('sha256').update(source, 'utf8').digest('hex')`. It does not guess the engine's text encoding.

## Timeouts, connection loss, and bounded recovery

A timeout is a request-lifecycle event, not evidence that Luau failed or rolled back. Check the original ID:

```text
get_request_status({"request_id":"the-saved-operation_id"})
```

Do not confuse request `state`/`outcome` with the last observed execution phase:

| Observed stage | What it establishes |
| --- | --- |
| `queued` | Not dispatched yet; a terminal `not_executed` admission/queue failure is safe evidence that this call did not execute. |
| `dispatched` | Delivered to a transport, but no observed proof that execution started. Losing this connection leaves execution unknown. |
| `executing` | Studio reported plugin handler entry (`executionStartedAt`); no observed handler return yet. |
| `response_delivery` | Studio is preparing/delivering its response. An observed handler return sets `executionCompletedAt`; an admission rejection can reach this stage with `executionOutcome: "not_executed"` and no handler timestamps. |

These timestamps are **server observations of plugin handler entry/return**, which can include broker dispatch; they do not prove that particular user Luau instructions ran. Use the staged recipe's own marker and independent effect verification for application-level evidence. `executionOutcome` is separate from the request result: an encoding/retention rejection can have request `outcome: "error"` while `executionOutcome: "success"`.

Connection observations are separate again: `connectionLostAt` and `connectionRestoredAt` report transport loss/restoration. If the waiter expires while the socket is still absent, `request_connection_lost` identifies that failure while request `state` remains `timed_out`. Reconnecting does not replay commands. Waiter timeouts are **not execution deadlines** or rollback.

Progress that never reached the server cannot be reconstructed by guessing. A connection loss, cancellation, timeout, response-size rejection, or missing/evicted result can coexist with successful execution. In particular, `executionOutcome: "error"` can have partial effects, and `executionOutcome: "unknown"` is never equivalent to `not_executed`. Cancellation does **not** roll back Studio mutations or guarantee an already-running script stopped.

Recovery is **bounded to the current server session**, with a five-minute retention window for finished operation records, plus capacity eviction. Result payloads can be evicted independently of status (`resultUnavailable`). A server restart loses the ledger; a missing record returns an unknown outcome, not permission to replay. Retrying identical arguments under the same `operation_id` within retained history joins/recovers that operation rather than issuing a second mutation. This is not durable or permanent exactly-once execution.

Use a finite recovery policy, for example at most three `get_request_status` checks with delays of 1, 2, and 4 seconds. Stop when the result is known. If it remains pending/unknown, keep the journal and inspect the transfer with a **new read-only** `transfer.inspect()` step in the same instance. Do not loop indefinitely, reconnect to an arbitrary instance, or reissue a mutation under a fresh ID to make a timeout disappear.

- **`completed` marker:** use the cached completion and independently verify geometry; do not replay source. A lost response needs no re-execution.
- **`uploading` marker:** source has not been marked executing. Check the original write's status and read back its chunk. A confirmed stored chunk needs no rewrite. Only resume a missing upload step once the previous attempt is no longer in flight; use its saved identical arguments for bounded recovery while that record is retained. Never race an unresolved finalization with cleanup or a new finalization.
- **`executing`, `failed`, absent marker, or lost ownership:** stop automatic execution. Inspect actual effects, original status, and journal; decide an explicit application-specific repair. Known errors may have mutated half the scene. Unknown does not mean unexecuted.
- **Explicit terminal `not_executed`:** after fixing the admission/targeting/size problem, a deliberate new operation may be appropriate. If arguments change, assign a new operation ID. Do not infer `not_executed` solely from lack of a progress event.

## Intentional abort and cleanup

Abort only an incomplete, confirmed non-running transfer that you own. Reconstruct the helper using the saved manifest inputs, not a new transfer ID, and generate the exact cleanup call:

```bash
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { createLargeInputTransfer } from './tests/lib/large-input-workflow.mjs';
const transfer = createLargeInputTransfer(JSON.parse(readFileSync('transfer-plan.json', 'utf8')));
// Inspect first. Save and send this argument object to execute_luau.
console.log(JSON.stringify(transfer.inspect()));
// ONLY after confirming uploading and no original operation still in flight:
// console.log(JSON.stringify(transfer.abort()));
JS
```

`abort()` refuses `executing`, `failed`, and `completed`, checks the exact root manifest and ownership/nonarchivability of every descendant, then destroys only that staging root. It never destroys the output model, never clears objects by prefix, and never deletes an unowned name collision. Verify removal with a separate `execute_luau` readback (explicit same `instance_id` and new `operation_id`):

```lua
-- Substitute the exact rootName from the saved transfer, not a broad prefix.
return game:GetService('ServerStorage'):FindFirstChild('__RSMCP_Transfer_YOUR_TRANSFER_ID') == nil
```

Keep completed markers until the caller has reconciled the result and intentionally ended the recovery window. Any later manual marker/output removal must independently check the exact owner on the root and every descendant; remove nothing if ownership is ambiguous. Do not turn the native test's final disposal into a production retry policy. Saving/reloading a place removes nonarchivable markers, so verify effects and record completion outside Studio before closing the place.

## Native regression

After building the matching core/server, run the managed native command (it builds the bundled plugin and uses an isolated test-port wrapper):

```bash
npm run test:studio:large-input-workflow
```

Separate transport-boundary and fault-recovery probes are available as `npm run test:studio:payload-boundaries`, `npm run test:studio:websocket-recovery`, and `npm run test:studio:websocket-capacity`. These manage their own native Studio lifecycle; do not run competing suites against the same Studio edit session.

The regression uses the helper above against native Studio. Its successful transfer stages 54,000 bytes of non-ASCII comment content plus the 40-Part recipe through the helper's default 16 KiB chunks and the same authenticated HTTP wrapper as the example, then verifies repeated finalization under a fresh operation ID. Negative cases use deliberately small 127-byte chunks with repeated multi-byte characters crossing several boundaries. Missing/tampered/reordered chunks and compile failures execute zero source. Runtime and post-execution verification failures preserve partial effects and refuse re-execution, with an attempt counter proving no replay. It also checks incomplete-transfer abort/removal and preservation of unowned roots/descendants. It cleans up only its own test objects after observations. It is not a mock/hash-only test, nor proof of the configured 50/64 MiB transport boundaries.
