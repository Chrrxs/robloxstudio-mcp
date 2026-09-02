#!/usr/bin/env node
// Verifies eval runtime bridges are created inside play DataModels, not edit
// mode, and still work for MCP-managed solo and multiplayer playtests.

import { setTimeout as delay } from 'node:timers/promises';
import {
  McpClient,
  runTest,
  assert,
  routingPeers,
  safeStopPlaytest,
  selectEditInstance,
  startPlaytestAndWait,
} from './lib/mcp-client.mjs';

function routedRoles(connected) {
  return routingPeers(connected).map((peer) => peer.role);
}
function assertCompactTopologyIds(connected) {
  const instances = Array.isArray(connected?.instances) ? connected.instances : [];
  assert(
    instances.length > 0 &&
      instances.every((instance) => /^instance:[0-9a-z]{3}-[0-9a-z]{3}$/u.test(instance.id)),
    'connected standalone and edit processes use compact typed Instance IDs',
  );
  assert(
    instances.every((instance) =>
      !Array.isArray(instance.peers) &&
      instance.peers !== null &&
      typeof instance.peers === 'object'),
    'connected standalone and edit processes expose Peers only as role-keyed maps',
  );
  const groups = Array.isArray(connected?.multiplayerGroups)
    ? connected.multiplayerGroups
    : [];
  const groupedInstances = groups.flatMap((group) =>
    group.instances !== null &&
    typeof group.instances === 'object' &&
    !Array.isArray(group.instances)
      ? Object.entries(group.instances)
      : []);
  assert(
    groupedInstances.length > 0 &&
      groupedInstances.every(([instanceId]) =>
        /^instance:[0-9a-z]{3}-[0-9a-z]{3}-(server|client-\d+)$/u.test(instanceId)),
    'temporary multiplayer processes use role-suffixed compact Instance IDs',
  );
  const peerIds = [
    ...instances.flatMap((instance) => Object.values(instance.peers)),
    ...groupedInstances.map(([, peerId]) => peerId),
  ];
  assert(
    peerIds.length > 0 &&
      peerIds.every((peerId) => /^peer:[0-9a-z]{3}-[0-9a-z]{3}$/u.test(peerId)),
    'connected roles map to compact typed Peer IDs',
  );
}


async function waitForRoles(client, requiredRoles, { timeoutSec = 30, pollMs = 500 } = {}) {
  const deadline = Date.now() + timeoutSec * 1000;
  let last;
  while (Date.now() < deadline) {
    const connected = await client.callTool('get_connected_instances', {});
    const roles = routedRoles(connected);
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
    const roles = routedRoles(connected);
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

async function assertSharedSoloProcessLogs(client) {
  const connected = await client.callTool('get_connected_instances', {});
  const editInstance = selectEditInstance(connected);
  if (!editInstance) {
    throw new Error(`Managed solo topology has no edit Instance: ${JSON.stringify(connected)}`);
  }
  const peers = routingPeers(connected, editInstance.id);
  const expectedRoles = ['edit', 'server', 'client-1'];
  assert(expectedRoles.every((role) => peers.some((peer) => peer.role === role)),
    'managed solo Instance exposes edit, server, and client Peers');
  assert(peers.every((peer) => peer.instanceId === editInstance.id),
    'managed solo Peers share one Studio process Instance');

  const marker = `__MCP_RUNTIME_BRIDGE_MANAGED_SOLO_${Date.now()}`;
  const markersByRole = {
    edit: `${marker}_EDIT`,
    server: `${marker}_SERVER`,
    'client-1': `${marker}_CLIENT_1`,
  };
  for (const [role, roleMarker] of Object.entries(markersByRole)) {
    await client.callTool('execute_luau', {
      target: role,
      code: `print("${roleMarker}") return true`,
    });
  }

  const deadline = Date.now() + 5_000;
  let logs;
  while (Date.now() < deadline) {
    logs = await client.callTool('get_runtime_logs', {
      instance_id: editInstance.id,
      filter: marker,
      tail: 20,
    });
    const messages = (logs.entries ?? []).map((entry) => entry.message);
    if (Object.values(markersByRole).every(
      (roleMarker) => messages.some((message) => message.includes(roleMarker)))) {
      break;
    }
    await delay(100);
  }

  assert(logs?.instanceId === editInstance.id,
    'managed solo logs identify their exact process Instance');
  assert(!('instances' in logs),
    'single-Instance runtime logs do not return a synthetic merged collection');
  const entries = logs.entries ?? [];
  for (const [role, roleMarker] of Object.entries(markersByRole)) {
    assert(entries.some((entry) => entry.message.includes(roleMarker)),
      `one Instance log buffer includes output from its ${role} Peer`);
  }
  assert(entries.every((entry) =>
    !('peer' in entry) && !('capturedBy' in entry) && !('instanceId' in entry)),
  'single-Instance runtime-log entries do not synthesize observer attribution');
}


async function startManagedMultiplayer(client) {
  const started = await client.callTool('multiplayer_playtest', {
    action: 'start',
    numPlayers: 2,
    timeout: 120,
  }, 150_000);
  if (started.success !== true) {
    const connected = await client.callTool('get_connected_instances', {});
    const editInstance = selectEditInstance(connected);
    const [state, logs] = await Promise.all([
      client.callTool('multiplayer_playtest', {
        action: 'status',
        instance_id: editInstance?.id,
      }),
      client.callTool('get_runtime_logs', {
        instance_id: editInstance?.id,
        tail: 100,
      }),
    ]);
    throw new Error(`managed multiplayer start failed: ${JSON.stringify({ started, connected, state, logs })}`);
  }
  assert(typeof started.multiplayerGroupId === 'string' && started.multiplayerGroupId.length > 0,
    'managed multiplayer start returns an explicit group ID');
  return started.multiplayerGroupId;
}


await runTest('runtime eval bridges stay out of edit mode', async ({ track }) => {
  const client = track(new McpClient('runtime-bridge'));
  await client.start();
  await client.initialize();
  await waitForRoles(client, ['edit'], { timeoutSec: 120 });

  await assertEditBridgesAbsent(client, 'initial state');

  await startPlaytestAndWait(client);
  try {
    await assertSharedSoloProcessLogs(client);
    await assertRuntimeEvalWorks(client);
  } finally {
    await safeStopPlaytest(client);
    await waitForNoRuntime(client).catch(() => {});
  }
  await assertEditBridgesAbsent(client, 'after managed playtest');


  const startedMultiplayerGroupId = await startManagedMultiplayer(client);
  try {
    await assertRuntimeEvalWorks(client, 'client-1');
    await assertRuntimeEvalWorks(client, 'client-2');

    const marker = `__MCP_RUNTIME_BRIDGE_MANAGED_MP_${Date.now()}`;
    const markersByRole = {
      server: `${marker}_SERVER`,
      'client-1': `${marker}_CLIENT_1`,
      'client-2': `${marker}_CLIENT_2`,
    };
    for (const [role, roleMarker] of Object.entries(markersByRole)) {
      await client.callTool('execute_luau', {
        target: role,
        code: `print("${roleMarker}") return true`,
      });
    }
    await delay(500);

    const connected = await client.callTool('get_connected_instances', {});
    assertCompactTopologyIds(connected);
    const editInstance = selectEditInstance(connected);
    const multiplayerGroupId = editInstance?.multiplayerGroupId;
    assert(multiplayerGroupId === startedMultiplayerGroupId,
      'connected edit Instance belongs to the started MultiplayerGroup');
    const group = (connected.multiplayerGroups ?? []).find(
      (candidate) => candidate.id === multiplayerGroupId);
    assert(!!group, 'connected topology exposes the started MultiplayerGroup');
    const scopedPeers = routingPeers(connected, editInstance.id);
    const instanceIdsByRole = new Map(
      Object.keys(markersByRole).map((role) => {
        const peer = scopedPeers.find((candidate) => candidate.role === role);
        if (!peer) {
          throw new Error(`Managed multiplayer topology has no ${role} Peer: ${JSON.stringify(connected)}`);
        }
        return [role, peer.instanceId];
      }),
    );
    assert(new Set(instanceIdsByRole.values()).size === 3,
      'managed multiplayer server and clients run in three distinct process Instances');
    const logs = await client.callTool('get_runtime_logs', {
      multiplayer_group_id: multiplayerGroupId,
      filter: marker,
      tail: 20,
    });
    assert(logs.multiplayerGroupId === multiplayerGroupId,
      'managed multiplayer logs identify the selected MultiplayerGroup');
    assert(logs.instances?.length === new Set(scopedPeers.map((peer) => peer.instanceId)).size,
      'managed multiplayer logs return one result for every grouped Instance');
    for (const [role, instanceId] of instanceIdsByRole) {
      const processLogs = logs.instances.find((row) => row.instanceId === instanceId);
      assert(!!processLogs && !('error' in processLogs),
        `managed multiplayer logs read process ${instanceId}`);
      assert(typeof logs.nextCursorByInstance?.[instanceId] === 'string',
        `process ${instanceId} has an independent opaque runtime-log cursor`);
      const entries = processLogs.entries ?? [];
      assert(entries.some((entry) => entry.message.includes(markersByRole[role])),
        `process ${instanceId} contains only its ${role} marker`);
      const foreignMarkers = Object.entries(markersByRole)
        .filter(([otherRole]) => otherRole !== role)
        .map(([, roleMarker]) => roleMarker);
      assert(entries.every((entry) =>
        foreignMarkers.every((roleMarker) => !entry.message.includes(roleMarker))),
      `process ${instanceId} excludes markers emitted by other Studio processes`);
      assert(entries.every((entry) =>
        !('peer' in entry) && !('capturedBy' in entry) && !('instanceId' in entry)),
      'runtime-log entries do not synthesize observer attribution');
    }
  } finally {
    await client.callTool('multiplayer_playtest', {
      action: 'end',
      timeout: 45,
    }, 60_000).catch(() => endDirectTest(client));
    await waitForNoRuntime(client).catch(() => {});
  }
  await assertEditBridgesAbsent(client, 'after managed multiplayer test');
}).then((ok) => process.exit(ok ? 0 : 1));
