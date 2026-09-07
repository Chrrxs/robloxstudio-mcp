#!/usr/bin/env node

import { setTimeout as delay } from 'node:timers/promises';
import {
  BASE_PORT,
  McpClient,
  assert,
  runTest,
  routingPeers,
  safeStopPlaytest,
  selectEditInstance,
  startPlaytestAndWait,
  waitForEditPeer,
} from './lib/mcp-client.mjs';
import { callMcpHttpTool } from './lib/mcp-http-client.mjs';

const PLAY_CYCLES = Number.parseInt(process.env.RSMCP_PLAY_CYCLES ?? '8', 10);
if (!Number.isSafeInteger(PLAY_CYCLES) || PLAY_CYCLES < 1 || PLAY_CYCLES > 100) {
  throw new Error('RSMCP_PLAY_CYCLES must be an integer from 1 through 100');
}
const RUNTIME_DRAIN_TIMEOUT_MS = 30_000;
const EDIT_MODE_SETTLE_TIMEOUT_MS = 15_000;
const HTTP_ROUTED_TOOLS = new Set([
  'eval_server_runtime',
  'execute_luau',
  'solo_playtest',
]);

function httpToolClient() {
  return {
    callTool(name, args = {}, timeoutMs = 30_000) {
      const instanceId = process.env.MCP_INSTANCE_ID;
      const routedArgs = instanceId && HTTP_ROUTED_TOOLS.has(name) && args.instance_id === undefined
        ? { ...args, instance_id: instanceId }
        : args;
      return callMcpHttpTool(name, routedArgs, {
        port: BASE_PORT,
        env: process.env,
        timeoutMs,
      });
    },
  };
}

function rolesForInstance(connected) {
  return routingPeers(connected).map((peer) => peer.role);
}

async function waitForRuntimePeersToDrain(client) {
  const deadline = Date.now() + RUNTIME_DRAIN_TIMEOUT_MS;
  let lastRoles = [];
  while (Date.now() < deadline) {
    const connected = await client.callTool('get_connected_instances', {});
    lastRoles = rolesForInstance(connected);
    if (!lastRoles.some((role) => role === 'server' || role.startsWith('client-'))) return;
    await delay(250);
  }
  throw new Error(`Runtime peers did not drain after stop. Last roles: ${JSON.stringify(lastRoles)}`);
}

async function waitForEditModeToSettle(client) {
  const deadline = Date.now() + EDIT_MODE_SETTLE_TIMEOUT_MS;
  let lastState;
  while (Date.now() < deadline) {
    try {
      const result = await client.callTool('execute_luau', {
        target: 'edit',
        code: 'return tostring(game:GetService("StudioTestService").EditModeActive)',
      }, 5_000);
      lastState = result.returnValue;
      if (result.success === true && result.returnValue === 'true') return;
    } catch (error) {
      lastState = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(`Studio did not settle in edit mode after stop. Last state: ${JSON.stringify(lastState)}`);
}

async function activeEventStreamCount() {
  const response = await fetch(`http://127.0.0.1:${BASE_PORT}/health`);
  if (!response.ok) throw new Error(`/health returned HTTP ${response.status}`);
  const health = await response.json();
  return health.activeEventStreams;
}

async function waitForActiveEventStreamCount(expected, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let count = await activeEventStreamCount();
  while (count !== expected && Date.now() < deadline) {
    await delay(100);
    count = await activeEventStreamCount();
  }
  return count;
}

async function assertEditStreamResponds(client, cycle) {
  const marker = `event-stream-cycle-${cycle}`;
  const result = await client.callTool('execute_luau', {
    target: 'edit',
    code: `return ${JSON.stringify(marker)}`,
  });
  assert(
    result.success === true && result.returnValue === marker,
    `cycle ${cycle}: edit event stream responds after runtime teardown`,
  );
}

async function assertRuntimeLogsRespond(client, query, label) {
  const startedAt = Date.now();
  const logs = await client.callTool('get_runtime_logs', query, 10_000);
  assert(Date.now() - startedAt < 10_000, `${label}: bounded log read beats the MCP deadline`);
  assert(logs.instanceId === query.instance_id, `${label}: log read stays on the selected Instance`);
  assert(Array.isArray(logs.entries) && logs.entries.length === 0,
    `${label}: unmatched small filtered query returns an empty buffer`);
  assert(!logs.peerErrors?.length, `${label}: every live Peer answers: ${JSON.stringify(logs.peerErrors)}`);
  assert(typeof logs.nextCursor === 'string', `${label}: log read returns a cursor`);
  const cursor = JSON.parse(Buffer.from(logs.nextCursor, 'base64url').toString('utf8'));
  assert(cursor.instanceId === query.instance_id && cursor.version === 1,
    `${label}: cursor belongs to the selected Instance`);
}

await runTest('event stream survives repeated play cycles', async ({ track }) => {
  // Keep a normal MCP client connected while a second authenticated client
  // drives POST /mcp/<tool>, matching the original report's topology.
  const mcpClient = track(new McpClient('play-cycle-event-stream'));
  await mcpClient.start();
  await mcpClient.initialize();
  const client = httpToolClient();
  await waitForEditPeer(client, { timeoutMs: 120_000 });
  const connected = await mcpClient.callTool('get_connected_instances', {});
  const instanceId = process.env.MCP_INSTANCE_ID ?? selectEditInstance(connected)?.id;
  assert(typeof instanceId === 'string', 'log regression has an explicit Instance selection');
  const logQuery = {
    instance_id: instanceId,
    tail: 10,
    filter: `__MCP_LOG_TIMEOUT_PROBE_${Date.now()}__`,
  };

  let playRunning = false;

  try {
    assert(await activeEventStreamCount() === 1, 'baseline has only the edit event stream');

    for (let cycle = 1; cycle <= PLAY_CYCLES; cycle += 1) {
      await assertRuntimeLogsRespond(mcpClient, logQuery, `cycle ${cycle}: before Play`);
      playRunning = true;
      await startPlaytestAndWait(client, { timeoutSec: 45, pollMs: 250 });
      assert(
        await waitForActiveEventStreamCount(2) === 2,
        `cycle ${cycle}: edit and server event streams are active`,
      );

      const runtimeMarker = `runtime-cycle-${cycle}`;
      const runtime = await client.callTool('eval_server_runtime', {
        code: `return { marker = ${JSON.stringify(runtimeMarker)} }`,
      });
      const runtimeResult = JSON.parse(runtime.result);
      assert(
        runtime.ok === true && runtime.bridge === 'ok' && runtimeResult.marker === runtimeMarker,
        `cycle ${cycle}: server eval crosses the runtime event stream`,
      );
      await assertRuntimeLogsRespond(mcpClient, logQuery, `cycle ${cycle}: during Play`);

      const stopped = await client.callTool('solo_playtest', { action: 'stop' }, 45_000);
      assert(stopped.success === true, `cycle ${cycle}: playtest stops cleanly`);
      assert(
        await activeEventStreamCount() === 1,
        `cycle ${cycle}: server event stream is released before stop returns`,
      );
      playRunning = false;
      await waitForRuntimePeersToDrain(client);
      await waitForEditModeToSettle(client);
      assert(true, `cycle ${cycle}: Studio settles fully in edit mode`);

      assert(await activeEventStreamCount() === 1, `cycle ${cycle}: server event stream is released`);
      await assertEditStreamResponds(client, cycle);
      await assertRuntimeLogsRespond(mcpClient, logQuery, `cycle ${cycle}: after Play`);
    }
  } finally {
    if (playRunning) await safeStopPlaytest(client);
  }
}).then((ok) => process.exit(ok ? 0 : 1));
