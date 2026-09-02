#!/usr/bin/env node

import { setTimeout as delay } from 'node:timers/promises';
import {
  McpClient,
  runTest,
  assert,
  selectEditInstance,
  waitForEditPeer,
} from './lib/mcp-client.mjs';

const NETWORK_KEYS = [
  'InboundNetworkMinDelayMs',
  'OutboundNetworkMinDelayMs',
  'InboundNetworkJitterMs',
  'OutboundNetworkJitterMs',
  'InboundNetworkLossPercent',
  'OutboundNetworkLossPercent',
];

function roleKeys(result) {
  return Object.keys(result.roles ?? {}).sort();
}

function networkState(roleState) {
  return roleState?.network?.state ?? roleState?.network?.after;
}

function assertNetworkValues(roleState, expected, label) {
  const state = networkState(roleState);
  for (const key of NETWORK_KEYS) {
    assert(state?.[key] === expected[key], `${label} ${key} is ${expected[key]} (got ${state?.[key]})`);
  }
}

function assertDeviceDefault(roleState, label) {
  assert(roleState?.deviceSimulator?.activeDeviceId === 'default', `${label} device simulator is default`);
  assert(roleState?.deviceSimulator?.isSimulating === false, `${label} device simulator is stopped`);
}

function assertDeviceActive(roleState, deviceId, label) {
  assert(roleState?.deviceSimulator?.activeDeviceId === deviceId, `${label} device simulator is ${deviceId}`);
  assert(roleState?.deviceSimulator?.isSimulating === true, `${label} device simulator is active`);
}

async function expectToolFailure(fn, expectedSubstring, label) {
  try {
    await fn();
    throw new Error(`Expected ${label} to reject with ${expectedSubstring}`);
  } catch (err) {
    if (err.message.startsWith('Expected ')) throw err;
    assert(err.message.includes(expectedSubstring), `${label} rejects with ${expectedSubstring}`);
  }
}

await runTest('simulation state tools reset network and device simulator deterministically', async ({ track }) => {
  const client = track(new McpClient('simulation-state-lifecycle', { startupTimeoutMs: 10000 }));
  let instanceId;
  let playStarted = false;
  let multiplayerStarted = false;

  try {
    await client.start();
    await client.initialize();
    await waitForEditPeer(client, { timeoutMs: 30000 });

    const connected = await client.callTool('get_connected_instances', {});
    const edit = selectEditInstance(connected);
    assert(!!edit, 'edit peer is connected');
    instanceId = edit.id;

    const listed = await client.rpc('tools/list', {});
    const names = new Set((listed.tools ?? []).map((tool) => tool.name));
    for (const tool of [
      'solo_playtest',
      'get_simulation_state',
      'reset_simulation_state',
      'set_network_profile',
      'get_device_simulator_state',
      'set_device_simulator',
      'capture_device_matrix',
    ]) {
      assert(names.has(tool), `tools/list exposes ${tool}`);
    }

    await client.callTool('reset_simulation_state', { target: 'edit', instance_id: instanceId });
    let state = await client.callTool('get_simulation_state', { target: 'edit', include: 'both', instance_id: instanceId });
    assertNetworkValues(state.roles.edit, Object.fromEntries(NETWORK_KEYS.map((key) => [key, 0])), 'edit baseline');
    assertDeviceDefault(state.roles.edit, 'edit baseline');

    const matrix = await client.callTool('capture_device_matrix', {
      target: 'edit',
      entries: [{ label: 'phone', deviceId: 'iphone_XR', orientation: 'LandscapeRight' }],
      format: 'jpeg',
      quality: 40,
      settleSeconds: 0,
      restoreAfter: true,
      instance_id: instanceId,
    });
    assert(matrix.entries?.[0]?.screenshot?.width > 0, 'capture_device_matrix captures an edit screenshot');
    state = await client.callTool('get_simulation_state', { target: 'edit', include: 'deviceSimulator', instance_id: instanceId });
    assertDeviceDefault(state.roles.edit, 'edit after matrix restore');

    const playStart = await client.callTool('solo_playtest', { action: 'start', mode: 'play', instance_id: instanceId });
    playStarted = true;
    assert(playStart.success === true, 'normal Play starts');
    assert(playStart.roles.includes('client-1'), 'normal Play registers client-1');

    const playReset = await client.callTool('reset_simulation_state', { target: 'edit-and-clients', instance_id: instanceId });
    assert(roleKeys(playReset).includes('edit'), 'normal Play reset includes edit');
    assert(roleKeys(playReset).includes('client-1'), 'normal Play reset includes client-1');
    assert(!roleKeys(playReset).includes('server'), 'normal Play reset skips server');

    await client.callTool('set_network_profile', { target: 'client-1', profile: 'good', instance_id: instanceId });
    await client.callTool('set_device_simulator', {
      target: 'client-1',
      deviceId: 'iphone_XR',
      orientation: 'LandscapeRight',
      instance_id: instanceId,
    });
    state = await client.callTool('get_simulation_state', { target: 'edit-and-clients', include: 'both', instance_id: instanceId });
    assertNetworkValues(state.roles['client-1'], {
      InboundNetworkMinDelayMs: 50,
      OutboundNetworkMinDelayMs: 50,
      InboundNetworkJitterMs: 10,
      OutboundNetworkJitterMs: 10,
      InboundNetworkLossPercent: 0,
      OutboundNetworkLossPercent: 0,
    }, 'normal Play client');
    assertDeviceActive(state.roles['client-1'], 'iphone_XR', 'normal Play client');

    await expectToolFailure(
      () => client.callTool('set_network_profile', {
        target: 'client-1',
        profile: 'custom',
        overrides: { InboundNetworkLossPercent: 0.5001 },
        instance_id: instanceId,
      }),
      'must be <= 0.5',
      'packet-loss over engine limit',
    );

    await client.callTool('reset_simulation_state', { target: 'edit-and-clients', instance_id: instanceId });
    await client.callTool('solo_playtest', { action: 'stop', instance_id: instanceId });
    playStarted = false;
    await delay(1000);
    await client.callTool('reset_simulation_state', { target: 'edit', instance_id: instanceId });

    const multiplayerStart = await client.callTool('multiplayer_playtest', {
      action: 'start',
      numPlayers: 2,
      timeout: 45,
      instance_id: instanceId,
    });
    multiplayerStarted = true;
    assert(multiplayerStart.success === true, 'multiplayer test starts');
    assert(multiplayerStart.roles.includes('client-1'), 'multiplayer registers client-1');
    assert(multiplayerStart.roles.includes('client-2'), 'multiplayer registers client-2');

    const multiplayerReset = await client.callTool('reset_simulation_state', { target: 'edit-and-clients', instance_id: instanceId });
    assert(roleKeys(multiplayerReset).includes('edit'), 'multiplayer reset includes edit');
    assert(roleKeys(multiplayerReset).includes('client-1'), 'multiplayer reset includes client-1');
    assert(roleKeys(multiplayerReset).includes('client-2'), 'multiplayer reset includes client-2');
    assert(!roleKeys(multiplayerReset).includes('server'), 'multiplayer reset skips server');

    state = await client.callTool('get_simulation_state', { target: 'all-clients', include: 'both', instance_id: instanceId });
    assertNetworkValues(state.roles['client-1'], Object.fromEntries(NETWORK_KEYS.map((key) => [key, 0])), 'multiplayer client-1 after reset');
    assertNetworkValues(state.roles['client-2'], Object.fromEntries(NETWORK_KEYS.map((key) => [key, 0])), 'multiplayer client-2 after reset');
    assertDeviceDefault(state.roles['client-1'], 'multiplayer client-1 after reset');
    assertDeviceDefault(state.roles['client-2'], 'multiplayer client-2 after reset');

    await client.callTool('set_network_profile', { target: 'all-clients', profile: 'poor', instance_id: instanceId });
    await client.callTool('set_device_simulator', {
      target: 'all-clients',
      deviceId: 'iphone_XR',
      orientation: 'LandscapeRight',
      instance_id: instanceId,
    });
    state = await client.callTool('get_simulation_state', { target: 'all-clients', include: 'both', instance_id: instanceId });
    for (const role of ['client-1', 'client-2']) {
      assertNetworkValues(state.roles[role], {
        InboundNetworkMinDelayMs: 150,
        OutboundNetworkMinDelayMs: 150,
        InboundNetworkJitterMs: 100,
        OutboundNetworkJitterMs: 100,
        InboundNetworkLossPercent: 0.5,
        OutboundNetworkLossPercent: 0.5,
      }, `multiplayer ${role}`);
      assertDeviceActive(state.roles[role], 'iphone_XR', `multiplayer ${role}`);
    }

    const editState = await client.callTool('get_simulation_state', { target: 'edit', include: 'both', instance_id: instanceId });
    assertNetworkValues(editState.roles.edit, Object.fromEntries(NETWORK_KEYS.map((key) => [key, 0])), 'edit during multiplayer client mutations');
    assertDeviceDefault(editState.roles.edit, 'edit during multiplayer client mutations');

    await expectToolFailure(
      () => client.callTool('capture_device_matrix', {
        target: 'client-1',
        entries: [{ label: 'mp-client', deviceId: 'iphone_XR' }],
        settleSeconds: 0,
        instance_id: instanceId,
      }),
      'does not support StudioTestService multiplayer client targets',
      'multiplayer client matrix capture',
    );

    await client.callTool('reset_simulation_state', { target: 'edit-and-clients', instance_id: instanceId });
    await client.callTool('multiplayer_playtest', { action: 'end', timeout: 45, instance_id: instanceId });
    multiplayerStarted = false;
    await delay(1000);
    await client.callTool('reset_simulation_state', { target: 'edit', instance_id: instanceId });

    const finalState = await client.callTool('get_simulation_state', { target: 'edit', include: 'both', instance_id: instanceId });
    assertNetworkValues(finalState.roles.edit, Object.fromEntries(NETWORK_KEYS.map((key) => [key, 0])), 'final edit');
    assertDeviceDefault(finalState.roles.edit, 'final edit');
  } finally {
    if (instanceId) {
      if (multiplayerStarted) {
        try {
          await client.callTool('reset_simulation_state', { target: 'edit-and-clients', instance_id: instanceId });
        } catch {
          // Best-effort cleanup.
        }
        try {
          await client.callTool('multiplayer_playtest', { action: 'end', timeout: 45, instance_id: instanceId });
        } catch {
          // Best-effort cleanup.
        }
      }
      if (playStarted) {
        try {
          await client.callTool('reset_simulation_state', { target: 'edit-and-clients', instance_id: instanceId });
        } catch {
          // Best-effort cleanup.
        }
        try {
        await client.callTool('solo_playtest', { action: 'stop', instance_id: instanceId });
        } catch {
          // Best-effort cleanup.
        }
      }
      try {
        await client.callTool('reset_simulation_state', { target: 'edit', instance_id: instanceId });
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}).then((ok) => process.exit(ok ? 0 : 1));
