#!/usr/bin/env node
// One MCP session discovers/inspects a live grouped runtime. A second session
// attempts teardown with a pre-runtime topology cache. Both WebSockets stay live.
// Run after npm run build. --race-refresh places runtime registration between
// a fresh topology snapshot and removal. Both modes must preserve the live ID.
// ISSUE80_SERVER may point at an older controller bundle to verify that the
// guarded primary also protects sessions from stale, older controllers.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import WebSocket from 'ws';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { BridgeService } from '../packages/core/dist/bridge-service.js';
import { RobloxStudioTools } from '../packages/core/dist/tools/index.js';
import { createHttpServer, listenWithRetry, TOOL_HANDLERS } from '../packages/core/dist/http-server.js';
import { createToolServer } from '../packages/core/dist/mcp-runtime.js';
import { TOOL_DEFINITIONS } from '../packages/core/dist/tools/definitions.js';

class ProtocolBridge extends BridgeService {
  notifyPeerRegistered() {} // Fake peers have no native Studio processes to associate.
}
const scratch = await mkdtemp(join(tmpdir(), 'rsmcp-stale-teardown-'));
const definitions = TOOL_DEFINITIONS.filter(({ name }) => ['get_connected_instances', 'get_memory_breakdown'].includes(name));
const config = { name: 'issue-80-alias-repro', version: '3.1.3', tools: definitions };
const primary = new ProtocolBridge();
const tools = new RobloxStudioTools(primary);
const app = createHttpServer(tools, primary, undefined, config);
const { server } = await listenWithRetry(app, '127.0.0.1', 0, 1);
const base = `http://127.0.0.1:${server.address().port}`;
const sockets = [];
const delivered = [];
const observer = new Client({ name: 'same-session-observer', version: '1' });
const controller = new Client({ name: 'stale-controller', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
const observerServer = createToolServer({
  config, getTools: () => tools, era: 'modern',
  invoke: (currentTools, name, args, context) => TOOL_HANDLERS[name](currentTools, args, context),
});
const groupId = 'test:issue-80';
const raceRefresh = process.argv.includes('--race-refresh');
const topologyCaptured = Promise.withResolvers();
const releaseTopology = Promise.withResolvers();
let endCall;
const decode = (result) => result.structuredContent ?? JSON.parse(result.content[0].text);

async function connect(name, role) {
  const peerId = `peer:${name}`;
  const response = await fetch(`${base}/ready`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      peerId, transportPeerId: peerId, instanceId: `instance:${name}`, role,
      multiplayerGroupId: groupId, placeId: 1, placeName: 'Test', dataModelName: role,
      isRunning: role === 'server', pluginVersion: '3.1.3', pluginVariant: 'main', timestamp: Date.now(),
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/studio?${new URLSearchParams({ peerId, protocolVersion: '1' })}`, {
    headers: { 'X-Studio-Token': body.transportToken },
  });
  sockets.push(socket);
  socket.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.kind !== 'request') return;
    delivered.push({ peerId, endpoint: frame.endpoint });
    // The fixed implementation should consult the live runtime, not delete its
    // group on a stale "already ended" assumption. Reject the actual stop so this
    // fixture can check identity without simulating Roblox playtest teardown.
    const result = frame.endpoint === '/api/multiplayer-test-end'
      ? { error: 'probe_refuses_to_end_live_runtime' }
      : { servedBy: peerId };
    socket.send(JSON.stringify({ kind: 'response', requestId: frame.requestId, response: result }));
  });
  await once(socket, 'message');
}

try {
  await connect('aaa-111', 'edit');
  // This is the edit-controller-only topology that can exist during startup.
  primary.createMultiplayerGroup(groupId, 'instance:aaa-111');
  const preload = join(scratch, 'clock.mjs');
  await writeFile(preload, "import { mock } from 'node:test';\nmock.timers.enable({ apis: ['setInterval'] });\n");
  const controllerTransport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', preload, resolve(process.env.ISSUE80_SERVER ?? 'packages/robloxstudio-mcp/dist/index.js')],
    env: {
      PATH: process.env.PATH, HOME: scratch, ROBLOX_STUDIO_PORT: String(server.address().port),
      ROBLOX_STUDIO_HOST: '127.0.0.1', ROBLOX_STUDIO_NO_AUTH: '1',
      ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR: join(scratch, 'registry'),
    }, stderr: 'pipe',
  });
  const proxyReady = Promise.withResolvers();
  let stderr = '';
  controllerTransport.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.includes('entering proxy mode')) proxyReady.resolve();
  });
  await controller.connect(controllerTransport);
  await proxyReady.promise;
  if (raceRefresh) {
    // Keep the primary handlers unchanged, but control delivery of exactly one
    // topology response to deterministically place registration between read
    // and group removal. All other requests use the real HTTP app.
    const [requestHandler] = server.listeners('request');
    server.removeListener('request', requestHandler);
    let captureNextTopology = true;
    server.on('request', (request, response) => {
      if (captureNextTopology && request.url === '/topology') {
        captureNextTopology = false;
        const snapshot = JSON.stringify(primary.getTopologySnapshot());
        topologyCaptured.resolve();
        void releaseTopology.promise.then(() => {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(snapshot);
        });
      } else {
        requestHandler(request, response);
      }
    });
    endCall = controller.callTool({
      name: 'multiplayer_playtest', arguments: { action: 'end', instance_id: 'instance:aaa-111' },
    });
    await topologyCaptured.promise;
  }
  // Do not advance the periodic poll. The reported version retains the earlier cache.
  await connect('bbb-222', 'server');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await observerServer.connect(serverSide);
  await observer.connect(clientSide);
  const before = decode(await observer.callTool({ name: 'get_connected_instances', arguments: {} }));
  const selectedId = Object.keys(before.multiplayerGroups[0].instances)[0];
  assert.equal(selectedId, 'instance:bbb-222-server');
  const inspect = () => observer.callTool({ name: 'get_memory_breakdown', arguments: { target: 'server', instance_id: selectedId } });
  assert.equal(decode(await inspect()).servedBy, 'peer:bbb-222');
  releaseTopology.resolve();
  const endResult = await (endCall ?? controller.callTool({
    name: 'multiplayer_playtest', arguments: { action: 'end', instance_id: 'instance:aaa-111' },
  }));
  const ended = decode(endResult);
  const after = await inspect(); // Same observer connection and exact same discovered ID.
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.instanceCount, 2);
  assert.equal(health.peerCount, 2);
  assert.equal(health.activeWebSockets, 2);
  assert(sockets.every((socket) => socket.readyState === WebSocket.OPEN));
  const stopRequests = delivered.filter(({ endpoint }) => endpoint === '/api/multiplayer-test-end');
  console.log(JSON.stringify({
    selectedId, raceRefresh, controllerResult: ended,
    observerResult: decode(after), observerIsError: after.isError ?? false,
    health: { instanceCount: health.instanceCount, peerCount: health.peerCount, activeWebSockets: health.activeWebSockets },
    remainingGroups: primary.getMultiplayerGroups().length, stopRequestsSentToStudio: stopRequests.length,
  }, null, 2));
  assert(!after.isError, 'a live discovered ID must remain routable when teardown is refused');
  assert.equal(decode(after).servedBy, 'peer:bbb-222');
  assert.equal(primary.getMultiplayerGroups().length, 1);
  if (raceRefresh) {
    assert(endResult.isError, 'a raced removal must be reported as a refusal, not already ended');
    assert.equal(ended.error, 'multiplayer_group_in_use');
    assert.equal(ended.multiplayer_group_id, groupId);
    assert.equal(stopRequests.length, 0);
  } else if (endResult.isError) {
    // An older controller cannot reconstruct the new error type, but must still
    // report failure when the primary refuses its stale removal.
    assert(process.env.ISSUE80_SERVER, 'current non-racing controller should consult the live runtime');
    assert.equal(stopRequests.length, 0);
  } else {
    assert.equal(stopRequests.length, 1);
    assert.equal(ended.success, false);
  }
  console.log('FIX VERIFIED: refused teardown preserves the live group and the same-session discovered ID.');
} finally {
  releaseTopology.resolve();
  await observer.close();
  await observerServer.close();
  await controller.close();
  for (const socket of sockets) socket.terminate();
  primary.clearAllPendingRequests();
  await app.cleanup();
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await closed;
  await rm(scratch, { recursive: true, force: true });
}
