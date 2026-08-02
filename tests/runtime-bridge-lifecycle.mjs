#!/usr/bin/env node
// Verifies eval runtime bridges are created inside play DataModels, not edit
// mode, and still work for MCP-managed and manually-started playtests.

import { setTimeout as delay } from 'node:timers/promises';
import { McpClient, runTest, assert, startPlaytestAndWait, safeStopPlaytest } from './lib/mcp-client.mjs';

async function waitForRoles(client, requiredRoles, { timeoutSec = 30, pollMs = 500 } = {}) {
  const deadline = Date.now() + timeoutSec * 1000;
  let last;
  while (Date.now() < deadline) {
    const connected = await client.callTool('get_connected_instances', {});
    const roles = (connected.instances ?? []).map((inst) => inst.role);
    last = roles;
    if (requiredRoles.every((role) => roles.includes(role))) return roles;
    await delay(pollMs);
  }
  throw new Error(`Timed out waiting for roles ${requiredRoles.join(', ')}. Last roles: ${JSON.stringify(last)}`);
}

async function waitForNoRuntime(client, { timeoutSec = 30, pollMs = 500 } = {}) {
  const deadline = Date.now() + timeoutSec * 1000;
  let last;
  while (Date.now() < deadline) {
    const connected = await client.callTool('get_connected_instances', {});
    const roles = (connected.instances ?? []).map((inst) => inst.role);
    last = roles;
    if (!roles.some((role) => role === 'server' || role.startsWith('client-'))) return roles;
    await delay(pollMs);
  }
  throw new Error(`Timed out waiting for runtime peers to disconnect. Last roles: ${JSON.stringify(last)}`);
}

async function assertEditBridgesAbsent(client, label) {
  const result = await client.callTool('execute_luau', {
    target: 'edit',
    code: `
local SSS = game:GetService("ServerScriptService")
local StarterPlayer = game:GetService("StarterPlayer")
local sps = StarterPlayer:FindFirstChild("StarterPlayerScripts")
return {
  serverBridge = SSS:FindFirstChild("__MCP_ServerEvalBridge") ~= nil,
  clientBridge = sps and sps:FindFirstChild("__MCP_ClientEvalBridge") ~= nil or false,
}
`,
  });
  assert(result.success === true, `${label}: edit bridge probe succeeds`);
  const state = JSON.parse(result.returnValue);
  assert(state.serverBridge === false, `${label}: no server eval bridge script in edit mode`);
  assert(state.clientBridge === false, `${label}: no client eval bridge script in edit mode`);
}

async function assertRuntimeEvalWorks(client, targetClient = 'client-1') {
  const server = await client.callTool('eval_server_runtime', {
    code: 'return { isServer = game:GetService("RunService"):IsServer(), marker = "server-runtime" }',
  });
  assert(server.ok === true && server.bridge === 'ok', 'eval_server_runtime reaches runtime bridge');
  const serverResult = JSON.parse(server.result);
  assert(serverResult.isServer === true, 'eval_server_runtime runs in server Script VM');

  const clientResult = await client.callTool('eval_client_runtime', {
    target: targetClient,
    code: 'return { isClient = game:GetService("RunService"):IsClient(), localPlayer = game:GetService("Players").LocalPlayer.Name }',
  });
  assert(clientResult.ok === true && clientResult.bridge === 'ok', `eval_client_runtime reaches ${targetClient} runtime bridge`);
  const parsedClient = JSON.parse(clientResult.result);
  assert(parsedClient.isClient === true, `eval_client_runtime runs in ${targetClient} LocalScript VM`);
}

async function startDirectPlay(client) {
  const started = await client.callTool('execute_luau', {
    target: 'edit',
    code: `
local StudioTestService = game:GetService("StudioTestService")
task.spawn(function()
  local ok, err = pcall(function()
    StudioTestService:ExecutePlayModeAsync({})
  end)
  if not ok then warn("__MCP_RUNTIME_BRIDGE_DIRECT_PLAY_ERROR", err) end
end)
return true
`,
  });
  assert(started.success === true, 'direct StudioTestService play start command succeeds');
  await waitForRoles(client, ['server', 'client-1']);
}

async function startDirectMultiplayer(client) {
  const started = await client.callTool('execute_luau', {
    target: 'edit',
    code: `
local StudioTestService = game:GetService("StudioTestService")
task.spawn(function()
  local ok, err = pcall(function()
    StudioTestService:ExecuteMultiplayerTestAsync(2, {})
  end)
  if not ok then warn("__MCP_RUNTIME_BRIDGE_DIRECT_MP_ERROR", err) end
end)
return true
`,
  });
  assert(started.success === true, 'direct StudioTestService multiplayer start command succeeds');
  await waitForRoles(client, ['server', 'client-1', 'client-2']);
}

async function endDirectTest(client) {
  const ended = await client.callTool('execute_luau', {
    target: 'server',
    code: `
local StudioTestService = game:GetService("StudioTestService")
local ok, err = pcall(function()
  StudioTestService:EndTest(true)
end)
return { ok = ok, err = ok and nil or tostring(err) }
`,
  });
  assert(ended.success === true, 'direct StudioTestService EndTest command executes');
  const result = JSON.parse(ended.returnValue);
  assert(result.ok === true, `direct StudioTestService EndTest succeeds${result.err ? ` (${result.err})` : ''}`);
  await waitForNoRuntime(client);
}

await runTest('runtime eval bridges stay out of edit mode', async ({ track }) => {
  const client = track(new McpClient('runtime-bridge'));
  await client.start();
  await client.initialize();
  await waitForRoles(client, ['edit'], { timeoutSec: 120 });

  await assertEditBridgesAbsent(client, 'initial state');

  await startPlaytestAndWait(client);
  try {
    await assertRuntimeEvalWorks(client);
  } finally {
    await safeStopPlaytest(client);
    await waitForNoRuntime(client).catch(() => {});
  }
  await assertEditBridgesAbsent(client, 'after managed playtest');

  await startDirectPlay(client);
  try {
    await assertRuntimeEvalWorks(client);
  } finally {
    await endDirectTest(client).catch(async () => {
      await safeStopPlaytest(client);
      await waitForNoRuntime(client).catch(() => {});
    });
  }
  await assertEditBridgesAbsent(client, 'after direct playtest');

  await startDirectMultiplayer(client);
  try {
    await assertRuntimeEvalWorks(client, 'client-1');
    await assertRuntimeEvalWorks(client, 'client-2');

    const marker = `__MCP_RUNTIME_BRIDGE_DIRECT_MP_ATTR_${Date.now()}`;
    await client.callTool('execute_luau', {
      target: 'server',
      code: `print("${marker}", "server", #game:GetService("Players"):GetPlayers()) return true`,
    });
    await client.callTool('execute_luau', {
      target: 'client-1',
      code: `print("${marker}", game:GetService("Players").LocalPlayer.Name) return true`,
    });
    await client.callTool('execute_luau', {
      target: 'client-2',
      code: `print("${marker}", game:GetService("Players").LocalPlayer.Name) return true`,
    });
    await delay(500);

    const logs = await client.callTool('get_runtime_logs', {
      target: 'all',
      filter: marker,
      tail: 20,
    });
    assert(logs.originPeerReliable === true, 'direct multiplayer runtime shape gets reliable peer attribution');
    const peers = new Set((logs.entries ?? []).map((entry) => entry.peer));
    assert(peers.has('server'), 'direct multiplayer logs include server peer attribution');
    assert(peers.has('client-1'), 'direct multiplayer logs include client-1 peer attribution');
    assert(peers.has('client-2'), 'direct multiplayer logs include client-2 peer attribution');
  } finally {
    await endDirectTest(client).catch(async () => {
      await safeStopPlaytest(client);
      await waitForNoRuntime(client).catch(() => {});
    });
  }
  await assertEditBridgesAbsent(client, 'after direct multiplayer test');
}).then((ok) => process.exit(ok ? 0 : 1));
