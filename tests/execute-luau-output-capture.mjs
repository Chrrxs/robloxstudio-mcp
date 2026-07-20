#!/usr/bin/env node
// execute_luau must return user print()/warn() calls in the response
// output array on every target, including target=server. The
// ModuleScript-fallback path used when LoadStringEnabled=false runs user
// code in its own environment, so a plugin-side getfenv override is
// invisible there; instead, the wrapper declares lexical local print/warn
// inside the IIFE so user calls bind to a capturing function regardless of
// execution path.
//
// Regression test for the execute_luau output-capture bug fixed in v2.11.3.

import { McpClient, runTest, assert, assertContains, startPlaytestAndWait, safeStopPlaytest } from './lib/mcp-client.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const M1 = 'OUTPUT_PRINT_a1';
const M2 = 'OUTPUT_WARN_b2';
const M3 = 'OUTPUT_BASELINE_c3';
const M4 = 'STRUCTURED_LOG_CONTEXT_d4';

await runTest('execute_luau target=server captures print/warn output', async ({ track }) => {
  const client = track(new McpClient('A'));
  await client.start();
  await client.initialize();

  await startPlaytestAndWait(client);

  try {
    // Case 1: print() on server target — currently empty, should be captured
    const r1 = await client.callTool('execute_luau', {
      target: 'server',
      code: `print("${M1}")\nreturn "done"`,
    });
    assert(r1.success === true, 'execute_luau target=server succeeds');
    const output1 = Array.isArray(r1.output) ? r1.output : [];
    assert(output1.length > 0,
      `target=server output array non-empty (got ${output1.length} entries)`);
    assertContains(JSON.stringify(output1), M1,
      'output captures user print');

    // Case 2: warn() also captured
    const r2 = await client.callTool('execute_luau', {
      target: 'server',
      code: `warn("${M2}")\nreturn "done"`,
    });
    const output2 = Array.isArray(r2.output) ? r2.output : [];
    assertContains(JSON.stringify(output2), M2,
      'output captures user warn');

    // Case 3: target=edit baseline — already works via loadstring path
    const r3 = await client.callTool('execute_luau', {
      target: 'edit',
      code: `print("${M3}")\nreturn "done"`,
    });
    assert(r3.success === true, 'execute_luau target=edit succeeds');
    const output3 = Array.isArray(r3.output) ? r3.output : [];
    assertContains(JSON.stringify(output3), M3,
      'edit baseline: print captured (sanity)');

    // Case 4: LogService structured context survives the plugin buffer and
    // MCP response as optional entry.data.
    const r4 = await client.callTool('execute_luau', {
      target: 'server',
      code: `game:GetService("LogService"):Info("${M4}", { durationMilliseconds = 0.0037, moduleName = "MenuController", rank = 13 })\nreturn "done"`,
    });
    assert(r4.success === true, 'structured LogService output succeeds');
    await delay(100);

    const logs = await client.callTool('get_runtime_logs', {
      target: 'server',
      filter: M4,
      tail: 10,
    });
    const structured = (logs.entries ?? []).find((entry) => entry.message.includes(M4));
    assert(structured !== undefined, 'get_runtime_logs returns the structured log entry');
    assert(structured.data?.durationMilliseconds === 0.0037,
      'structured log data preserves durationMilliseconds');
    assert(structured.data?.moduleName === 'MenuController',
      'structured log data preserves moduleName');
    assert(structured.data?.rank === 13,
      'structured log data preserves rank');
  } finally {
    await safeStopPlaytest(client);
  }
}).then((ok) => process.exit(ok ? 0 : 1));
