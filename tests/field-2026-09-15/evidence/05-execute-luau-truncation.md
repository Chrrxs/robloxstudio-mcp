# 05 — `execute_luau` large return values: measurement, `truncated`/`totalBytes`/`returnedBytes`, `max_output_bytes`

Field report item 5. Studio evidence comes from a separate managed baseplate opened by the test
runner; the user's own Studio instances were not touched.

## Symptom / reproduction

Command (in the worktree):

```
npm run build:plugin:artifact && node tests/run-with-test-port.mjs tests/run-all.mjs --managed --test field-2026-09-15/05-execute-luau-truncation.mjs
```

### Measurement before the fix — which layer cuts the value?

The measurement section of the same test sends `return string.rep("x", N)` and a 30,000-element
`table.concat` through `execute_luau target=edit`:

| Request | returnValue length | bytes | MCP result body (bytes) | `truncated` field |
|---|---|---|---|---|
| `string.rep("x", 30000)` | 30,000 | 30,000 | 30,084 | absent |
| `string.rep("x", 200000)` | 200,000 | 200,000 | 200,084 | absent |
| `string.rep("x", 2000000)` | 2,000,000 | 2,000,000 | 2,000,084 | absent |
| `table.concat` 30,000 x "y" | 30,000 | 30,000 | 30,084 | absent |

Conclusion: no layer of the chain **plugin (LuauExec) → WebSocket (64 MiB frame) → primary
server → proxy HTTP (50 MiB body) → stdio** truncates anything up to 2 MB; the test client runs in
proxy mode, so the HTTP proxy hop is part of the measurement. The "tail cut off above ~30k
characters" seen in the field does not come from this repository. The only remaining candidate is
the MCP client's tool-result budget (typically about 25,000 tokens by default; above it the
whole result is replaced by an error text or visibly clipped). Because nothing on
this side said "truncated", agents could not tell the difference. The fix is therefore an
**explicit server-side budget with accounting**: the plugin still produces the full result, the
server applies `max_output_bytes` (default 65,536 = 64 KiB — chosen to stay under the ~25,000-token
client budget at roughly 3 bytes per token, i.e. below the ~75 kB mark) and reports `totalBytes`.
The upper bound is `EXECUTE_LUAU_MAX_OUTPUT_BYTES = HTTP_BODY_LIMIT_BYTES` (52,428,800), the same
as the proxy HTTP body limit.

### Red raw output (before the fix)

```
=== TODO#5 execute_luau large return truncation contract ===
--- measurement: raw lengths layer by layer (same commands before and after the fix) ---
{"label":"string.rep 30000","timestamp":"2026-09-15T08:21:47.009Z","tool":"execute_luau","args":{"code":"return string.rep(\"x\", 30000)"},"isError":false,"success":true,"returnValueLength":30000,"returnValueBytes":30000,"responseBytes":30084}
{"label":"string.rep 200000","timestamp":"2026-09-15T08:21:47.046Z","tool":"execute_luau","args":{"code":"return string.rep(\"x\", 200000)"},"isError":false,"success":true,"returnValueLength":200000,"returnValueBytes":200000,"responseBytes":200084}
{"label":"string.rep 2000000","timestamp":"2026-09-15T08:21:47.119Z","tool":"execute_luau","args":{"code":"return string.rep(\"x\", 2000000)"},"isError":false,"success":true,"returnValueLength":2000000,"returnValueBytes":2000000,"responseBytes":2000084}
{"label":"table.concat 30000","timestamp":"2026-09-15T08:21:47.140Z","tool":"execute_luau","args":{"code":"local t = {} for i = 1, 30000 do t[i] = \"y\" end return table.concat(t)"},"isError":false,"success":true,"returnValueLength":30000,"returnValueBytes":30000,"responseBytes":30084}
--- contract ---
❌ TODO#5 execute_luau large return truncation contract FAILED: a small return value carries truncated:false
+ actual - expected
+ undefined
- false
Closed managed Studio instance instance:gok-t2v
========== SUMMARY ==========
  ❌ FAIL  todo-2026-09-15/05-execute-luau-truncation.mjs
0/1 passed.
=== 05 exit=1
```

(Section labels and assertion messages were translated; the tool output lines are verbatim from
the original run.)

## Fix

- `packages/core/src/http-body-limits.ts`: `EXECUTE_LUAU_DEFAULT_OUTPUT_BYTES` (65,536),
  `EXECUTE_LUAU_MAX_OUTPUT_BYTES` (= `HTTP_BODY_LIMIT_BYTES`), `resolveExecuteLuauOutputLimit`
  (validation: positive integer, upper bound), `truncateUtf8` (never splits a multibyte
  character), `applyExecuteLuauOutputLimit` (returnValue → `truncated`, `totalBytes`,
  `returnedBytes`, `maxOutputBytes`; `print` output shares the budget and is cut by whole lines →
  `outputTruncated`, `outputTotalBytes`, `outputReturnedBytes`).
- `packages/core/src/tools/index.ts` `executeLuau`: new `max_output_bytes` parameter; the plugin
  response is wrapped with the accounting before `_textResult`.
- `packages/core/src/tools/definitions.ts` `execute_luau` schema: `max_output_bytes` (integer,
  1..52428800).
- `packages/core/src/http-server.ts`: `body.max_output_bytes` is passed through (one line).
- The plugin side (LuauExec) is unchanged: the measurement showed the plugin does not truncate,
  carrying the full result over the local socket is cheap (2 MB → 73 ms), and `totalBytes` needs
  the full size.

## Green

Same command after the fix (managed baseplate `instance:13z-fca`, 2026-09-15 10:46 UTC, third attempt — the first two launches did not connect within 120 s because five other managed Studio sessions were running on the machine at the time):

```
=== field #5 execute_luau large return truncation contract ===
--- measurement: raw lengths layer by layer (same commands before and after the fix) ---
{"label":"string.rep 30000","timestamp":"2026-09-15T10:46:45.224Z","tool":"execute_luau","args":{"code":"return string.rep(\"x\", 30000)"},"isError":false,"success":true,"returnValueLength":30000,"returnValueBytes":30000,"truncated":false,"totalBytes":30000,"returnedBytes":30000,"maxOutputBytes":65536,"responseBytes":30298}
{"label":"string.rep 200000","timestamp":"2026-09-15T10:46:45.245Z","tool":"execute_luau","args":{"code":"return string.rep(\"x\", 200000)"},"isError":false,"success":true,"returnValueLength":65536,"returnValueBytes":65536,"truncated":true,"totalBytes":200000,"returnedBytes":65536,"maxOutputBytes":65536,"responseBytes":65834}
{"label":"string.rep 2000000","timestamp":"2026-09-15T10:46:45.316Z","tool":"execute_luau","args":{"code":"return string.rep(\"x\", 2000000)"},"isError":false,"success":true,"returnValueLength":65536,"returnValueBytes":65536,"truncated":true,"totalBytes":2000000,"returnedBytes":65536,"maxOutputBytes":65536,"responseBytes":65836}
{"label":"table.concat 30000","timestamp":"2026-09-15T10:46:45.337Z","tool":"execute_luau","args":{"code":"local t = {} for i = 1, 30000 do t[i] = \"y\" end return table.concat(t)"},"isError":false,"success":true,"returnValueLength":30000,"returnValueBytes":30000,"truncated":false,"totalBytes":30000,"returnedBytes":30000,"maxOutputBytes":65536,"responseBytes":30299}
--- contract ---
{"label":"200 kB, max_output_bytes=1000","timestamp":"2026-09-15T10:46:45.373Z","tool":"execute_luau","args":{"code":"string.rep 200000","max_output_bytes":1000},"isError":false,"success":true,"returnValueLength":1000,"returnValueBytes":1000,"truncated":true,"totalBytes":200000,"returnedBytes":1000,"maxOutputBytes":1000,"responseBytes":1298}
{"label":"200 kB, max_output_bytes=300000","timestamp":"2026-09-15T10:46:45.395Z","tool":"execute_luau","args":{"code":"string.rep 200000","max_output_bytes":300000},"isError":false,"success":true,"returnValueLength":200000,"returnValueBytes":200000,"truncated":false,"totalBytes":200000,"returnedBytes":200000,"maxOutputBytes":300000,"responseBytes":200303}
{"label":"2 MB, max_output_bytes=2100000","timestamp":"2026-09-15T10:46:45.482Z","tool":"execute_luau","args":{"code":"string.rep 2000000","max_output_bytes":2100000},"isError":false,"success":true,"returnValueLength":2000000,"returnValueBytes":2000000,"truncated":false,"totalBytes":2000000,"returnedBytes":2000000,"maxOutputBytes":2100000,"responseBytes":2000306}
{"label":"max_output_bytes upper bound","timestamp":"2026-09-15T10:46:45.485Z","tool":"execute_luau","args":{"code":"return 1","max_output_bytes":1000000000000},"isError":true,"responseBytes":108}
{"label":"print output 50 x 1000 B, max_output_bytes=5000","timestamp":"2026-09-15T10:46:45.507Z","tool":"execute_luau","args":{"code":"print loop","max_output_bytes":5000},"isError":false,"success":true,"returnValueLength":4,"returnValueBytes":4,"truncated":false,"totalBytes":4,"returnedBytes":4,"maxOutputBytes":5000,"responseBytes":4380}
--- regression: HttpService:GetAsync http://127.0.0.1 (edit context) ---
{"label":"HttpEnabled before","returnValue":"false"}
{"label":"HttpEnabled set attempt","returnValue":"false:The current thread cannot write 'HttpEnabled' (lacking capability LocalUser)"}
{"label":"HttpService:GetAsync 127.0.0.1","timestamp":"2026-09-15T10:46:45.586Z","tool":"execute_luau","args":{"code":"GetAsync http://127.0.0.1:55959/field05"},"isError":false,"success":true,"returnValueLength":18,"returnValueBytes":18,"truncated":false,"totalBytes":18,"returnedBytes":18,"maxOutputBytes":65536,"responseBytes":311}
  ✓ execute_luau reaches localhost HTTP from the edit context

✅ field #5 execute_luau large return truncation contract PASSED
Closed managed Studio instance instance:13z-fca

========== SUMMARY ==========
  ✅ PASS  field-2026-09-15/05-execute-luau-truncation.mjs

1/1 passed.
```

Summary: with the default budget 200 kB → `returnedBytes 65536`, `truncated:true`,
`totalBytes 200000`; with `max_output_bytes: 300000` the 200 kB value is complete; with
`max_output_bytes: 2100000` the 2 MB value is complete; `10^12` → error
(`max_output_bytes must be at most 52428800`); `print` 50 x 1000 B with budget 5000 → `output`
keeps 4 lines, `outputTotalBytes 50049`.

### Regression: `execute_luau` in the edit context calling `HttpService:GetAsync("http://127.0.0.1:<port>/…")`

The test opens a local Node HTTP server. On the baseplate `HttpService.HttpEnabled` is **false**
and the plugin cannot write it (`The current thread cannot write 'HttpEnabled' (lacking capability
LocalUser)`); `GetAsync` from the plugin context **still works**: `returnValue =
"true|pong:/field05"`. The local dev-server bridge does not depend on `HttpEnabled`; the behavior
is preserved.

## Regression (unit / static)

- `npm run typecheck`: green.
- `npm run lint`: 7 pre-existing errors (install-plugin-helpers.ts:254–257,
  opencloud-client.ts:445, install-plugin.ts `_chunk` x2) — no new ones.
- `npm test -w packages/core`: green; `field-05-execute-luau-output-budget.test.ts` adds 5 tests
  ("field #5 execute_luau output budget").
