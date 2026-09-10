#!/usr/bin/env node
// eval_server_runtime / eval_client_runtime must surface the actual user
// error, not Roblox's generic "Requested module experienced an error while
// loading" wrapper. The Studio plugin's LuauExec wrapper is the single source
// of truth for preserving explicit runtime errors, parser errors, and nested
// require() module-load failures across execute_luau and eval_*_runtime.
//
// Regression test for the eval-bridge error-swallow bug fixed in v2.11.3.

import { McpClient, runTest, assert, assertContains, assertNotContains, startPlaytestAndWait, safeStopPlaytest } from './lib/mcp-client.mjs';

const MARKER = 'EVAL_ERR_MARKER_3f4a9c';
const NESTED_SERVER_MARKER = 'EVAL_NESTED_REQUIRE_MARKER_server';
const NESTED_CLIENT_MARKER = 'EVAL_NESTED_REQUIRE_MARKER_client';
const GENERIC = 'Requested module experienced an error while loading';

await runTest('eval_server_runtime preserves user error', async ({ track }) => {
  const client = track(new McpClient('A'));
  await client.start();
  await client.initialize();

  await startPlaytestAndWait(client);

  try {
    // Case 1: explicit error() with distinctive message
    const r1 = await client.callToolError('eval_server_runtime', {
      code: `error("${MARKER}-explicit-error")`,
    });
    assert(r1.ok === false, 'eval_server_runtime reports ok=false on error');
    assert(r1.bridge === 'ok', 'bridge reached server peer');
    assertContains(JSON.stringify(r1), `${MARKER}-explicit-error`,
      'response carries the actual user error message');
    assertNotContains(JSON.stringify(r1), GENERIC,
      'response does NOT carry the generic require wrapper message');

    // Case 2: nil deref (different error class)
    const r2 = await client.callToolError('eval_server_runtime', {
      code: `local x = nil\nreturn x.${MARKER}_field`,
    });
    assert(r2.ok === false, 'nil deref reports ok=false');
    assertContains(JSON.stringify(r2), `${MARKER}_field`,
      'response surfaces the nil-deref field name');
    assertNotContains(JSON.stringify(r2), GENERIC,
      'nil deref does NOT use the generic wrapper');

    // Case 3: nested ModuleScript load failures also go through require().
    // Create the failing modules from plugin context so Source assignment
    // permissions do not affect the Script/LocalScript VM behavior under test.
    await client.callTool('execute_luau', {
      target: 'server',
      code: `
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local oldServer = workspace:FindFirstChild("__MCPEvalNestedServerFailure")
if oldServer then oldServer:Destroy() end
local oldClient = ReplicatedStorage:FindFirstChild("__MCPEvalNestedClientFailure")
if oldClient then oldClient:Destroy() end

local serverModule = Instance.new("ModuleScript")
serverModule.Name = "__MCPEvalNestedServerFailure"
serverModule.Source = [[
local missing = script.Parent.${NESTED_SERVER_MARKER}
return missing
]]
serverModule.Parent = workspace

local clientModule = Instance.new("ModuleScript")
clientModule.Name = "__MCPEvalNestedClientFailure"
clientModule.Source = [[
local missing = script.Parent.${NESTED_CLIENT_MARKER}
return missing
]]
clientModule.Parent = ReplicatedStorage
return true
`,
    });

    const r3 = await client.callToolError('eval_server_runtime', {
      code: `require(workspace.__MCPEvalNestedServerFailure)`,
    });
    assert(r3.ok === false, 'eval_server_runtime nested require reports failure');
    assertContains(r3.error || '', NESTED_SERVER_MARKER,
      'server nested require response carries the actual module-load error');
    assertNotContains(r3.error || '', GENERIC,
      'server nested require response does NOT use the generic require wrapper');

    const r3Cached = await client.callToolError('eval_server_runtime', {
      code: `require(workspace.__MCPEvalNestedServerFailure)`,
    });
    assert(r3Cached.ok === false, 'eval_server_runtime cached nested require reports failure');
    assertContains(r3Cached.error || '', NESTED_SERVER_MARKER,
      'server cached nested require response carries the earlier module-load error');
    assertNotContains(r3Cached.error || '', GENERIC,
      'server cached nested require response does NOT use the generic require wrapper');

    const r4 = await client.callToolError('eval_client_runtime', {
      target: 'client-1',
      code: `
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local module = ReplicatedStorage:WaitForChild("__MCPEvalNestedClientFailure", 5)
require(module)
`,
    });
    assert(r4.ok === false, 'eval_client_runtime nested require reports failure');
    assertContains(r4.error || '', NESTED_CLIENT_MARKER,
      'client nested require response carries the actual module-load error');
    assertNotContains(r4.error || '', GENERIC,
      'client nested require response does NOT use the generic require wrapper');

    const r4Cached = await client.callToolError('eval_client_runtime', {
      target: 'client-1',
      code: `
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local module = ReplicatedStorage:WaitForChild("__MCPEvalNestedClientFailure", 5)
require(module)
`,
    });
    assert(r4Cached.ok === false, 'eval_client_runtime cached nested require reports failure');
    assertContains(r4Cached.error || '', NESTED_CLIENT_MARKER,
      'client cached nested require response carries the earlier module-load error');
    assertNotContains(r4Cached.error || '', GENERIC,
      'client cached nested require response does NOT use the generic require wrapper');

    // Case 4: success path still works
    const r5 = await client.callTool('eval_server_runtime', {
      code: `return 6 * 7`,
    });
    assert(r5.ok === true, 'success path still returns ok=true');
    assertContains(JSON.stringify(r5), '42', 'success result preserved');

    // Case 5: parse/compile error — engine collapses these into GENERIC
    // from pcall(require, m). Wrapper must recover the real parser
    // diagnostic from LogService.
    const r6 = await client.callToolError('eval_server_runtime', {
      code: `this is not valid luau syntax @#$`,
    });
    assert(r6.ok === false, 'eval_server_runtime parse error reports ok=false');
    assertContains(r6.error || '', 'user_code:',
      'parse-error response carries the normalized user-code parser diagnostic');
    assertNotContains(r6.error || '', GENERIC,
      'parse-error response does NOT fall back to the generic require wrapper');

    // Case 6: parse error on client peer too
    const r7 = await client.callToolError('eval_client_runtime', {
      code: `!!! syntax error here`,
      target: 'client-1',
    });
    assert(r7.ok === false, 'eval_client_runtime parse error reports ok=false');
    assertContains(r7.error || '', 'user_code:',
      'client parse-error response carries the normalized user-code parser diagnostic');
    assertNotContains(r7.error || '', GENERIC,
      'client parse-error response does NOT fall back to the generic require wrapper');
  } finally {
    await safeStopPlaytest(client);
  }
}).then((ok) => process.exit(ok ? 0 : 1));
