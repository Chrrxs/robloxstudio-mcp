#!/usr/bin/env node
// Investigation: one real MCP protocol connection, real primary HTTP + Studio
// WebSockets. No Studio application or live user server is touched.
// Run after npm run build -w packages/core; --proxy exercises the proxy bridge.
// --promotion uses one actual stdio MCP subprocess and drives its promotion clock.
// ISSUE80_SERVER can point at the published v3.1.3 bundle for release replay.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mock } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import WebSocket from 'ws';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { BridgeService } from '../packages/core/dist/bridge-service.js';
import { ProxyBridgeService } from '../packages/core/dist/proxy-bridge-service.js';
import { RobloxStudioTools } from '../packages/core/dist/tools/index.js';
import { createHttpServer, listenWithRetry, TOOL_HANDLERS } from '../packages/core/dist/http-server.js';
import { createToolServer } from '../packages/core/dist/mcp-runtime.js';
import { TOOL_DEFINITIONS } from '../packages/core/dist/tools/definitions.js';

// Simulated peers have no native Studio processes to associate. As in the HTTP
// security fixture, suppress only the native managed-process publication hook.
class ProtocolBridge extends BridgeService {
  notifyPeerRegistered() {}
}
class ProtocolProxyBridge extends ProxyBridgeService {
  notifyPeerRegistered() {}
}
const definitions = TOOL_DEFINITIONS.filter(({ name }) => ['get_connected_instances', 'get_place_info'].includes(name));
const config = { name: 'issue-80-same-session', version: '3.1.3', tools: definitions };
const primary = new ProtocolBridge();
const app = createHttpServer(new RobloxStudioTools(primary), primary, undefined, config);
const { server } = await listenWithRetry(app, '127.0.0.1', 0, 1);
const base = `http://127.0.0.1:${server.address().port}`;
const sockets = new Set();
const received = [];
let proxy;
let mcpServer;
let client;
const promotion = process.argv.includes('--promotion');
const mode = promotion ? 'stdio-proxy-promotion' : process.argv.includes('--proxy') ? 'proxy' : 'primary';
const scratch = promotion ? await mkdtemp(join(tmpdir(), 'rsmcp-session-')) : undefined;
let stdio;
let originalServerClosed = false;
const promoted = Promise.withResolvers();
const decode = (result) => result.structuredContent ?? JSON.parse(result.content[0].text);

async function ready(name, overrides = {}) {
  const peerId = `peer:${name}`;
  const response = await fetch(`${base}/ready`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      peerId, transportPeerId: peerId, instanceId: `instance:${name}`, role: 'edit',
      placeId: name === 'aaa-111' ? 1 : 2, placeName: name, dataModelName: name,
      isRunning: false, pluginVersion: '3.1.3', pluginVariant: 'main', timestamp: Date.now(),
      ...overrides,
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.transportToken;
}

async function connect(name, token) {
  const peerId = `peer:${name}`;
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/studio?${new URLSearchParams({ peerId, protocolVersion: '1' })}`, {
    headers: { 'X-Studio-Token': token ?? await ready(name) },
  });
  sockets.add(socket);
  socket.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.kind === 'request') {
      received.push({ peerId, requestId: frame.requestId });
      socket.send(JSON.stringify({ kind: 'response', requestId: frame.requestId, response: { servedBy: peerId } }));
    }
  });
  await once(socket, 'message');
  return socket;
}

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const body = decode(result);
  assert(!result.isError, JSON.stringify(body));
  return body;
}

async function check(label, discoveredId = 'instance:bbb-222') {
  const health = await (await fetch(`${base}/health`)).json();
  const discovery = await call('get_connected_instances');
  const result = await client.callTool({ name: 'get_place_info', arguments: { instance_id: discoveredId } });
  const body = decode(result);
  const evidence = {
    scenario: label, mode, healthInstances: health.instanceCount, healthPeers: health.peerCount,
    activeWebSockets: health.activeWebSockets,
    discovered: discovery.instances.map(({ id }) => id),
    requested: discoveredId, outcome: result.isError ? body.error : body.servedBy,
  };
  console.log(JSON.stringify(evidence));
  assert.equal(health.instanceCount, 2, label);
  assert.equal(health.activeWebSockets, 2, label);
  assert.deepEqual(evidence.discovered.sort(), ['instance:aaa-111', 'instance:bbb-222'], label);
  assert(!result.isError, `${label}: ${JSON.stringify(body)}`);
  assert.equal(body.servedBy, discoveredId.replace('instance:', 'peer:'), label);
}

async function closeOriginalServer() {
  if (originalServerClosed) return;
  originalServerClosed = true;
  await app.cleanup();
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await closed;
}

try {
  mock.timers.enable({ apis: ['setInterval', 'Date'] });
  await connect('aaa-111');
  let selectedSocket = await connect('bbb-222');
  client = new Client(
    { name: 'same-session-investigation', version: '1' },
    promotion ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined,
  );
  if (promotion) {
    const preload = join(scratch, 'clock.mjs');
    await writeFile(preload, [
      "import { mock } from 'node:test';",
      "mock.timers.enable({ apis: ['setInterval'] });",
      "process.on('SIGUSR2', () => mock.timers.tick(5000));",
    ].join('\n'));
    stdio = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', preload, resolve(process.env.ISSUE80_SERVER ?? 'packages/robloxstudio-mcp/dist/index.js')],
      env: {
        PATH: process.env.PATH, HOME: scratch,
        ROBLOX_STUDIO_PORT: String(server.address().port),
        ROBLOX_STUDIO_HOST: '127.0.0.1', ROBLOX_STUDIO_NO_AUTH: '1',
        ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR: join(scratch, 'registry'),
      },
      stderr: 'pipe',
    });
    const proxyReady = Promise.withResolvers();
    let stderr = '';
    stdio.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.includes('Promoted from proxy to primary')) promoted.resolve();
      if (stderr.includes('entering proxy mode')) proxyReady.resolve();
      if (stderr.includes('(primary mode)')) proxyReady.reject(new Error('subprocess unexpectedly became primary'));
    });
    await client.connect(stdio);
    await proxyReady.promise;
  } else {
    proxy = mode === 'proxy' ? new ProtocolProxyBridge(base) : undefined;
    await proxy?.waitForInitialRefresh();
    const tools = new RobloxStudioTools(proxy ?? primary);
    mcpServer = createToolServer({
      config, getTools: () => tools, era: 'modern',
      invoke: (currentTools, name, args, context) => TOOL_HANDLERS[name](currentTools, args, context),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
  }
  await check('baseline');
  const originallyDiscovered = await call('get_connected_instances');
  const selectedId = originallyDiscovered.instances.find(({ id }) => id === 'instance:bbb-222').id;

  for (let iteration = 0; iteration < 20; iteration += 1) {
    await call('get_place_info', { instance_id: selectedId });
    await ready('bbb-222', { placeName: `updated-${iteration}`, placeId: 200 + iteration });
  }
  await check('20 repeated ready/metadata updates, original ID', selectedId);

  // A fresh socket for the same peer must supersede the old socket without
  // changing its process identity or letting the old close remove the new peer.
  const oldClosed = once(selectedSocket, 'close');
  selectedSocket = await connect('bbb-222');
  await oldClosed;
  await check('same-peer socket replacement, original ID', selectedId);

  // Advance only wall-clock age: active transports should protect quiet Studios
  // from stale-peer cleanup even without any tool traffic.
  mock.timers.setTime(Date.now() + 120_000);
  primary.cleanupStalePeers();
  proxy?.cleanupStalePeers();
  await check('120s idle age and stale-peer cleanup, original ID', selectedId);
  console.log(`PASS: one ${mode} MCP connection retained the original discovered ID across all scenarios; ${received.length} requests delivered.`);
  if (promotion) {
    const pid = stdio.pid;
    // End only the fixture-owned primary. This intentionally interrupts both
    // Studio transports but does not close or reinitialize the MCP connection.
    const disconnected = [...sockets].filter((socket) => socket.readyState === WebSocket.OPEN)
      .map((socket) => once(socket, 'close'));
    await closeOriginalServer();
    await Promise.all(disconnected);
    process.kill(pid, 'SIGUSR2'); // Advance the owned child's 5s promotion timer.
    await promoted.promise;
    assert.equal(stdio.pid, pid);
    const afterPromotion = await call('get_connected_instances');
    const rejection = await client.callTool({ name: 'get_place_info', arguments: { instance_id: selectedId } });
    assert.equal(afterPromotion.instances.length, 0);
    assert.equal(decode(rejection).error, 'unrecognized_instance_id');
    const health = await (await fetch(`${base}/health`)).json();
    console.log(JSON.stringify({
      scenario: 'same stdio session after primary exits and proxy promotes', pid,
      requested: selectedId, error: decode(rejection).error,
      discovered: afterPromotion.instances, healthInstances: health.instanceCount,
      activeWebSockets: health.activeWebSockets,
    }));
    await connect('aaa-111');
    const partial = await call('get_connected_instances');
    assert.deepEqual(partial.instances.map(({ id }) => id), ['instance:aaa-111']);
    console.log('same session after only the other Studio reconnects:', partial.instances.map(({ id }) => id));
    await connect('bbb-222');
    assert.equal(stdio.pid, pid);
    await check('both Studios re-register original IDs after promotion', selectedId);
    console.log('REPRODUCED: same-session success -> unrecognized_instance_id -> recovery; requires a primary/Studio transport interruption.');
  }
} finally {
  await client?.close();
  await mcpServer?.close();
  proxy?.stop();
  mock.timers.reset();
  for (const socket of sockets) socket.terminate();
  primary.clearAllPendingRequests();
  await closeOriginalServer();
  if (scratch) await rm(scratch, { recursive: true, force: true });
}
