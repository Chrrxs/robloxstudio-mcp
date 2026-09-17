#!/usr/bin/env node
// Run via scripts/studio-test-profile.mjs run -- tests/studio-websocket-reconnect.mjs.
// Native Studio uses real retry/deadline clocks: fake timers cannot control its
// process. Fault transitions wait on network events, with bounded watchdogs;
// only the existing managed-session helper polls Studio lifecycle state.
// Proxy faults emulate registration loss; owned-bridge-restart additionally
// stops/replaces the captured MCP child, never an external/shared listener.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { assertStudioDirectoryIsolation, assertStudioTestProfile, createIsolatedStudioDirectory } from '../scripts/studio-lifecycle.mjs';
import { DIST, McpClient, REPO_ROOT, routingPeers } from './lib/mcp-client.mjs';
import { callMcpHttpTool } from './lib/mcp-http-client.mjs';
import { openManagedStudioSession } from './lib/managed-studio-session.mjs';
import { acquireSuitePort } from './lib/test-port.mjs';

assertStudioTestProfile();
assertStudioDirectoryIsolation();
assert.equal(process.argv.length, 2, 'This regression always tests the current worktree artifact');
const started = performance.now();
const events = new EventEmitter();
const stats = { readyCalls: 0, readySuccesses: 0, rejectedUpgrades: 0, connections: 0, scenarios: 0 };
const record = (state, details = {}) => {
  console.log(JSON.stringify({ elapsedMs: Math.round(performance.now() - started), state, ...details }));
  events.emit('change');
};
let proxyFailure;
function failProxy(error) {
  proxyFailure ??= error;
  record('proxy-failure', { message: error.message });
}
async function waitFor(predicate, label, timeoutMs = 70000) {
  const pending = Promise.withResolvers();
  const check = () => {
    if (proxyFailure) pending.reject(proxyFailure);
    else if (predicate()) pending.resolve();
  };
  const watchdog = setTimeout(() => pending.reject(new Error(`${label} deadline: ${JSON.stringify(stats)}`)), timeoutMs);
  events.on('change', check);
  check();
  try { await pending.promise; }
  finally { clearTimeout(watchdog); events.off('change', check); }
}

const portLease = await acquireSuitePort({ env: {} });
const pairs = new Set();
const sockets = new Set();
const upstreams = new Set();
const forwardedRequests = new Set();
const heldReplies = new Set();
const heldUpgrades = new Set();
const peers = new Map();
const controls = [];
const cleanupErrors = [];
let fault, session, worker, backend, backendEnv, failure;
let playing = false;
const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

function forwardHttp(incoming, outgoing, body, registration) {
  const activeFault = registration?.peerId === fault?.peerId ? fault : undefined;
  const hold = activeFault?.mode === 'ready-hold' && ++activeFault.readyRequests === 1;
  if (activeFault && activeFault.mode !== 'ready-hold') activeFault.readyRequests++;
  if (registration) {
    stats.readyCalls++;
    const peer = peers.get(registration.peerId) ?? { role: registration.role, readySuccesses: 0 };
    peer.transportPeerId = registration.transportPeerId;
    peers.set(registration.peerId, peer);
    record('ready-request', { role: peer.role, held: hold, scenario: activeFault?.mode, count: stats.readyCalls });
  }
  const forwarded = request({
    hostname: '127.0.0.1', port: portLease.port, path: incoming.url, method: incoming.method,
    headers: { ...incoming.headers, host: `127.0.0.1:${portLease.port}` },
  }, response => {
    response.on('error', error => { outgoing.destroy(); failProxy(error); });
    if (!registration) {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
      return;
    }
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => {
      const reply = { outgoing, status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) };
      if (hold) {
        activeFault.heldReply = reply;
        heldReplies.add(reply);
        record('ready-response-held', { role: registration.role, status: reply.status });
        return;
      }
      if (reply.status === 200) {
        stats.readySuccesses++;
        const peer = peers.get(registration.peerId);
        peer.readySuccesses++;
        peer.readySequence = stats.readySuccesses;
        try { peer.role = JSON.parse(reply.body.toString()).assignedRole; }
        catch (error) { outgoing.destroy(); failProxy(error); return; }
        if (activeFault) {
          if (activeFault.mode === 'between-ready-and-upgrade' && !activeFault.betweenInjected) {
            // Backend remains live: only the proxy's registration knowledge is
            // lost after returning /ready and before accepting the next upgrade.
            activeFault.betweenInjected = true;
            activeFault.invalidated = true;
            record('proxy-registration-lost-between-ready-and-upgrade', { role: registration.role });
          } else {
            activeFault.invalidated = false;
            activeFault.freshReady = true;
          }
        }
      }
      outgoing.writeHead(reply.status, reply.headers);
      outgoing.end(reply.body);
      record('ready-response', { role: registration.role, status: reply.status });
    });
  });
  forwardedRequests.add(forwarded);
  forwarded.on('close', () => forwardedRequests.delete(forwarded));
  forwarded.on('error', () => {
    // Connection refusal is expected during the actual owned bridge restart.
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end();
    record('backend-http-unavailable');
  });
  forwarded.end(body);
}
const front = createServer((incoming, outgoing) => {
  const chunks = [];
  incoming.on('error', failProxy);
  incoming.on('data', chunk => chunks.push(chunk));
  incoming.on('end', () => {
    try {
      const body = Buffer.concat(chunks);
      const registration = incoming.method === 'POST' && incoming.url === '/ready' ? JSON.parse(body.toString()) : undefined;
      forwardHttp(incoming, outgoing, body, registration);
    } catch (error) { outgoing.destroy(); failProxy(error); }
  });
});
front.on('connection', socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => socket.destroy());
});
function rejectUpgrade(socket, status = 404) {
  const body = JSON.stringify({ error: 'unknown_peer' });
  socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
front.on('upgrade', (incoming, socket, head) => {
  const peerId = new URL(incoming.url, 'http://localhost').searchParams.get('peerId');
  const activeFault = fault?.peerId === peerId ? fault : undefined;
  if (activeFault?.mode === 'silent-upgrade' && !activeFault.heldUpgrade) {
    activeFault.heldUpgrade = socket;
    heldUpgrades.add(socket);
    record('upgrade-held-without-response', { role: peers.get(peerId)?.role });
    return;
  }
  if (activeFault?.invalidated) {
    stats.rejectedUpgrades++;
    activeFault.rejectedUpgrades++;
    if (activeFault.betweenInjected) activeFault.rejectedAfterReady++;
    rejectUpgrade(socket);
    record('proxy-upgrade-rejected', { role: peers.get(peerId)?.role, scenario: activeFault.mode });
    return;
  }
  // Do not tell Studio Opened until the real backend accepts its credentials.
  const upstream = new WebSocket(`ws://127.0.0.1:${portLease.port}${incoming.url}`, {
    maxPayload: 64 * 1024 * 1024, headers: { 'X-Studio-Token': incoming.headers['x-studio-token'] ?? '' },
  });
  upstreams.add(upstream);
  const pair = { upstream, downstream: undefined, peerId, knownPeer: false };
  const buffered = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    upstreams.delete(upstream);
    pairs.delete(pair);
    upstream.terminate();
    pair.downstream?.terminate();
    socket.destroy();
    record('socket-closed', { role: peers.get(peerId)?.role });
  };
  socket.on('close', close);
  upstream.on('error', close);
  upstream.on('close', close);
  upstream.on('unexpected-response', (req, response) => {
    rejectUpgrade(socket, response.statusCode);
    response.destroy();
    req.destroy();
    record('backend-upgrade-rejected', { status: response.statusCode, role: peers.get(peerId)?.role });
  });
  upstream.on('message', bytes => {
    const body = bytes.toString();
    try {
      const message = JSON.parse(body);
      if (message.kind === 'status') pair.knownPeer = message.knownPeer === true;
    } catch (error) { failProxy(error); }
    if (pair.downstream?.readyState === WebSocket.OPEN) pair.downstream.send(body);
    else buffered.push(body);
    events.emit('change');
  });
  upstream.on('open', () => {
    if (socket.destroyed) { close(); return; }
    websocketServer.handleUpgrade(incoming, socket, head, downstream => {
      pair.downstream = downstream;
      pairs.add(pair);
      stats.connections++;
      downstream.on('error', close);
      downstream.on('close', close);
      downstream.on('message', bytes => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes.toString());
      });
      for (const body of buffered) downstream.send(body);
      buffered.length = 0;
      record('socket-opened', { role: peers.get(peerId)?.role, connection: stats.connections });
    });
  });
});

function connectedPair(peerId) {
  return [...pairs].find(pair => pair.peerId === peerId && pair.knownPeer &&
    pair.upstream.readyState === WebSocket.OPEN && pair.downstream.readyState === WebSocket.OPEN);
}
function rolePair(role) {
  return [...pairs].find(pair => peers.get(pair.peerId)?.role === role && connectedPair(pair.peerId) === pair);
}
const tool = (name, args = {}) => callMcpHttpTool(name, { ...args, instance_id: session.instanceId }, {
  port: portLease.port, env: session.env, timeoutMs: 45000,
});
async function verifyTools(targets) {
  await waitFor(() => targets.every(target => {
    if (target !== 'client-1') return rolePair(target);
    const server = rolePair('server');
    return server && [...peers.values()].some(peer =>
      peer.role === 'client-1' && peer.transportPeerId === server.peerId &&
      peer.readySequence > peers.get(server.peerId).readySequence);
  }), 'native transports and fresh proxied client registration');
  const topology = await tool('get_connected_instances');
  const roles = routingPeers(topology, session.instanceId).map(peer => peer.role);
  for (const target of targets) {
    assert.ok(roles.includes(target), `Recovered topology includes ${target}: ${JSON.stringify(roles)}`);
    const result = await tool('execute_luau', {
      target, code: `return ${JSON.stringify(`native-reconnect:${target}:${stats.scenarios}`)}`,
    });
    assert.equal(result.success, true, `${target} execution succeeds`);
    assert.equal(result.returnValue, `native-reconnect:${target}:${stats.scenarios}`, `${target} returns a fresh routed response`);
  }
}
async function runProxyFault(mode, role, targets) {
  const previous = rolePair(role);
  assert.ok(previous, `${role} has a healthy transport before ${mode}`);
  const scenario = {
    mode, peerId: previous.peerId, invalidated: mode !== 'silent-upgrade',
    readyRequests: 0, rejectedUpgrades: 0, rejectedAfterReady: 0, freshReady: false,
  };
  fault = scenario;
  record('scenario-start', { mode, role, injection: 'proxy emulation; backend process remains live' });
  previous.downstream.terminate();
  await waitFor(() => scenario.freshReady && connectedPair(scenario.peerId), `${role}/${mode} fresh registration and recovery`, 45000);
  assert.notEqual(connectedPair(scenario.peerId), previous, 'Recovery replaces the failed socket');
  if (mode === 'ready-hold') {
    assert.ok(scenario.heldReply, '/ready really produced a held HTTP response');
    assert.equal(scenario.heldReply.status, 200, 'Held response contains real backend credentials');
    assert.ok(scenario.readyRequests >= 2, 'A new /ready starts while the previous response is still withheld');
    const recovered = connectedPair(scenario.peerId);
    const reply = scenario.heldReply;
    heldReplies.delete(reply);
    if (!reply.outgoing.destroyed) {
      reply.outgoing.writeHead(reply.status, reply.headers);
      reply.outgoing.end(reply.body);
      record('late-ready-released-after-recovery', { role });
    } else record('late-ready-discarded-client-already-closed', { role });
    await verifyTools(targets);
    assert.equal(connectedPair(scenario.peerId), recovered, 'Late registration cannot replace the recovered transport');
  } else {
    if (mode === 'silent-upgrade') {
      assert.ok(scenario.heldUpgrade, 'A native WebSocket upgrade received no response');
      // Keep the old upgrade unanswered until a fresh registration and socket
      // succeed; destroying it earlier could falsely pass without a deadline.
      scenario.heldUpgrade.destroy();
      heldUpgrades.delete(scenario.heldUpgrade);
    } else assert.ok(scenario.rejectedUpgrades > 0, 'Native stale credentials encountered an actual rejected upgrade');
    if (mode === 'between-ready-and-upgrade') {
      assert.ok(scenario.betweenInjected && scenario.rejectedAfterReady > 0, 'Registration was invalidated specifically between /ready and upgrade');
      assert.ok(scenario.readyRequests >= 2, 'A second fresh registration recovers the between-stage loss');
    }
    await verifyTools(targets);
  }
  fault = undefined;
  stats.scenarios++;
  record('scenario-passed', { mode, role, targets, readyRequests: scenario.readyRequests });
}
function createControl(env) {
  backendEnv = env;
  backend = new McpClient(`native-reconnect-bridge-${controls.length}`, { env, command: process.execPath, startupTimeoutMs: 20000 });
  controls.push(backend);
  return backend;
}
async function stopOwnedControl(control) {
  const proc = control.proc;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    await Promise.all([once(proc, 'exit', { signal: AbortSignal.timeout(15000) }), control.stop()]);
  } catch (error) {
    // This child was created by this suite; never discover/kill by port or name.
    proc.kill('SIGKILL');
    throw error;
  }
}
async function restartOwnedBridge(targets) {
  const transportRoles = targets.filter(role => role !== 'client-1');
  const before = transportRoles.map(role => {
    const pair = rolePair(role);
    assert.ok(pair, `${role} has a healthy socket before real bridge restart`);
    return { role, pair, readySuccesses: peers.get(pair.peerId).readySuccesses };
  });
  const previousPid = backend.proc.pid;
  record('scenario-start', { mode: 'owned-bridge-restart', targets, pid: previousPid });
  await stopOwnedControl(backend);
  const replacement = createControl(backendEnv);
  await replacement.start();
  assert.equal(replacement.isPrimary(), true, 'Replacement owns the same dedicated listener, not a proxy');
  assert.notEqual(replacement.proc.pid, previousPid, 'A real replacement child is running');
  await waitFor(() => before.every(({ pair, readySuccesses }) =>
    peers.get(pair.peerId).readySuccesses > readySuccesses && connectedPair(pair.peerId)), 'all native peers recover after real bridge restart');
  for (const { pair } of before) assert.notEqual(connectedPair(pair.peerId), pair, 'Real restart replaces each failed transport');
  await verifyTools(targets);
  stats.scenarios++;
  record('scenario-passed', { mode: 'owned-bridge-restart', targets, pid: replacement.proc.pid });
}

try {
  front.listen(0, '127.0.0.1');
  await once(front, 'listening', { signal: AbortSignal.timeout(10000) });
  const address = front.address();
  assert.ok(address && typeof address === 'object');
  worker = await createIsolatedStudioDirectory({ prefix: 'native-websocket-reconnect' });
  // The profile wrapper exports/builds once before launch. Never rebuild or
  // overwrite a source/snapshot artifact while Studio is using it.
  const artifact = path.join(REPO_ROOT, 'studio-plugin', 'MCPPlugin.rbxmx');
  const runtimeEnv = {
    ...process.env, MCP_PLUGINS_DIR: worker.pluginsDirectory,
    ...worker.environment,
    RSMCP_STUDIO_WORKING_DIRECTORY: worker.workingDirectory,
    ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR: worker.managedInstanceRegistryDirectory,
    ROBLOX_STUDIO_PORT: String(portLease.port), RSMCP_AUTO_ASSIGNED_PORT: '0',
  };
  const installer = spawn(process.execPath, [DIST, '--install-bundled-plugin', '--plugin-path', artifact], {
    env: { ...runtimeEnv, ROBLOX_STUDIO_PORT: String(address.port) }, stdio: 'inherit',
  });
  try {
    const [code, signal] = await once(installer, 'exit', { signal: AbortSignal.timeout(60000) });
    assert.equal(signal, null); assert.equal(code, 0);
  } finally {
    if (installer.exitCode === null && installer.signalCode === null) installer.kill('SIGKILL');
  }
  assert.ok(readFileSync(path.join(worker.pluginsDirectory, 'MCPPlugin.rbxmx'), 'utf8').includes(`http://localhost:${address.port}`));
  await portLease.handoff();
  session = await openManagedStudioSession({ port: portLease.port, env: runtimeEnv }, { createControl });
  await verifyTools(['edit']);
  await restartOwnedBridge(['edit']);
  const modes = ['stale-registration', 'ready-hold', 'silent-upgrade', 'between-ready-and-upgrade'];
  for (const mode of modes) await runProxyFault(mode, 'edit', ['edit']);
  playing = true;
  const play = await tool('solo_playtest', { action: 'start', mode: 'play' });
  assert.equal(play.success, true, 'Full solo Play starts');
  assert.ok(play.roles?.includes('client-1'), 'Full solo Play includes the client, not server-only Run');
  await waitFor(() => rolePair('server'), 'solo server native transport');
  await verifyTools(['edit', 'server', 'client-1']);
  await restartOwnedBridge(['edit', 'server', 'client-1']);
  // Client-1 is multiplexed through the server transport; assert its routed
  // execution after every fault rather than inventing a native client socket.
  for (const role of ['edit', 'server']) {
    for (const mode of modes) await runProxyFault(mode, role, ['edit', 'server', 'client-1']);
  }
  assert.equal((await tool('solo_playtest', { action: 'stop' })).success, true);
  playing = false;
  await verifyTools(['edit']);
  assert.equal(stats.scenarios, 14, 'All standalone-edit and full-play fault scenarios ran');
} catch (error) {
  failure = error;
} finally {
  fault = undefined;
  // Unblock every outstanding attempt before trying managed Studio shutdown.
  for (const reply of heldReplies) reply.outgoing.destroy();
  heldReplies.clear();
  for (const socket of heldUpgrades) socket.destroy();
  heldUpgrades.clear();
  if (playing && session) {
    try { assert.equal((await tool('solo_playtest', { action: 'stop' })).success, true); }
    catch (error) { cleanupErrors.push(error); }
  }
  try { await session?.close(); }
  catch (error) { cleanupErrors.push(error); }
  for (const control of controls) {
    try { await stopOwnedControl(control); } catch (error) { cleanupErrors.push(error); }
  }
  try { await worker?.cleanup(); } catch (error) { cleanupErrors.push(error); }
  for (const forwarded of forwardedRequests) forwarded.destroy();
  for (const upstream of upstreams) upstream.terminate();
  for (const pair of pairs) pair.downstream.terminate();
  for (const socket of sockets) socket.destroy();
  try {
    const closed = once(websocketServer, 'close', { signal: AbortSignal.timeout(10000) });
    websocketServer.close(); await closed;
    if (front.listening) {
      const stopped = once(front, 'close', { signal: AbortSignal.timeout(10000) });
      front.close(); front.closeAllConnections(); await stopped;
    }
  } catch (error) { cleanupErrors.push(error); }
  try { await portLease.release(); } catch (error) { cleanupErrors.push(error); }
  record('finished', { ...stats, cleanupErrors: cleanupErrors.length, failed: Boolean(failure) });
}
if (failure || cleanupErrors.length || proxyFailure) throw new AggregateError(
  [...(failure ? [failure] : []), ...cleanupErrors, ...(proxyFailure && proxyFailure !== failure ? [proxyFailure] : [])],
  'Native Studio WebSocket reconnect regression failed',
);
