#!/usr/bin/env node
// Regression: npm run build -w packages/core && node tests/issue-80-routing-repro.mjs
// --warm-one starts the proxy with one known process instead of an empty cache.
// Only the proxy polling clock is frozen; HTTP, WebSockets, topology and routing are real.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mock } from 'node:test';
import WebSocket from 'ws';
import { BridgeService } from '../packages/core/dist/bridge-service.js';
import { ProxyBridgeService } from '../packages/core/dist/proxy-bridge-service.js';
import { RobloxStudioTools } from '../packages/core/dist/tools/index.js';
import { createHttpServer, listenWithRetry } from '../packages/core/dist/http-server.js';

const primary = new BridgeService();
const primaryTools = new RobloxStudioTools(primary);
const app = createHttpServer(primaryTools, primary, undefined, {
  name: 'issue-80-repro', version: '3.1.3', tools: [],
});
const { server } = await listenWithRetry(app, '127.0.0.1', 0, 1);
const base = `http://127.0.0.1:${server.address().port}`;
const sockets = [];
let proxy;
const warmOne = process.argv.includes('--warm-one');
const decode = (result) => JSON.parse(result.content[0].text);
async function connect(name) {
  const peerId = `peer:${name}`;
  const response = await fetch(`${base}/ready`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      peerId, transportPeerId: peerId, instanceId: `instance:${name}`, role: 'edit',
      placeId: name === 'aaa-111' ? 1 : 2, placeName: name, dataModelName: name,
      isRunning: false, pluginVersion: '3.1.3', pluginVariant: 'main', timestamp: Date.now(),
    }),
  });
  assert.equal(response.status, 200);
  const { transportToken } = await response.json();
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/studio?${new URLSearchParams({ peerId, protocolVersion: '1' })}`, {
    headers: { 'X-Studio-Token': transportToken },
  });
  sockets.push(socket);
  socket.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.kind === 'request') socket.send(JSON.stringify({
      kind: 'response', requestId: frame.requestId, response: { servedBy: peerId },
    }));
  });
  await once(socket, 'message'); // Server status proves transport has been registered.
}

try {
  // Model a poll before one or both processes connect. Freeze the interval clock
  // to hold the pre-next-poll window deterministically; no timing sleeps.
  if (warmOne) await connect('aaa-111');
  mock.timers.enable({ apis: ['setInterval'] });
  proxy = new ProxyBridgeService(base);
  await proxy.waitForInitialRefresh();
  const proxyTools = new RobloxStudioTools(proxy);
  if (!warmOne) await connect('aaa-111');
  await connect('bbb-222');
  const health = await (await fetch(`${base}/health`)).json();
  const discovered = decode(await primaryTools.getConnectedInstances());
  const proxyDiscovery = decode(await proxyTools.getConnectedInstances());
  assert.equal(health.instanceCount, 2);
  assert.equal(health.peerCount, 2);
  assert.equal(health.activeWebSockets, 2);
  assert.equal(discovered.instances.length, 2);
  assert.deepEqual(proxyDiscovery, discovered,
    'proxy discovery must agree with the connected primary before its next periodic poll');
  console.log('primary health:', JSON.stringify({
    instanceCount: health.instanceCount, peerCount: health.peerCount,
    activeWebSockets: health.activeWebSockets,
  }));
  console.log('primary discovery:', discovered.instances.map((item) => item.id));
  console.log('proxy discovery before next poll:', proxyDiscovery.instances.map((item) => item.id));

  const id = discovered.instances[1].id;
  const inspected = decode(await proxyTools.getPlaceInfo(id));
  assert.equal(inspected.servedBy, 'peer:bbb-222');
  console.log('immediate proxy inspection routes to:', inspected.servedBy);
  assert(sockets.every((socket) => socket.readyState === WebSocket.OPEN));

  for (let iteration = 0; iteration < 10; iteration += 1) {
    const sameSession = decode(await proxyTools.getConnectedInstances());
    for (const instance of sameSession.instances) {
      const result = decode(await proxyTools.getPlaceInfo(instance.id));
      assert.equal(result.servedBy, instance.id.replace('instance:', 'peer:'));
    }
  }
  console.log('same-session stable-topology control: 20/20 inspections reached the correct process');
  console.log('CONSISTENT: discovery and routing agree without advancing the polling clock.');
} finally {
  proxy?.stop();
  mock.timers.reset();
  for (const socket of sockets) socket.terminate();
  primary.clearAllPendingRequests();
  await app.cleanup();
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await closed;
}
