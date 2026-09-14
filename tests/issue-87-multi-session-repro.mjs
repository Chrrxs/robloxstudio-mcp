#!/usr/bin/env node
// Run after npm run build: node tests/issue-87-multi-session-repro.mjs [--sessions=9]
// Actual current-build stdio primary/proxies; only Studio /ready + WebSocket
// traffic is simulated. No native Studio launch, plugin reconnect loop, or auth
// behavior is tested. Scratch HOME/registry and an ephemeral port isolate users.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = fileURLToPath(new URL('../', import.meta.url));
const countArg = process.argv.slice(2);
assert(countArg.length <= 1 && (!countArg.length || /^--sessions=\d+$/.test(countArg[0])),
  'Usage: node tests/issue-87-multi-session-repro.mjs [--sessions=9]');
const count = Number(countArg[0]?.split('=')[1] ?? 9);
assert(Number.isInteger(count) && count >= 2 && count <= 32, 'sessions must be 2..32');
assert(process.platform !== 'win32', 'This harness requires POSIX SIGUSR2');
const { version } = JSON.parse(await readFile(join(root, 'packages/robloxstudio-mcp/package.json'), 'utf8'));
const scratch = await mkdtemp(join(tmpdir(), 'rsmcp-issue87-'));
const preload = join(scratch, 'clock.mjs');
const sessions = [];
const sockets = new Set();
const peerId = 'peer:issue87-studio';
const instanceId = 'instance:issue87-studio';
const received = [];
let base;
let stage = 'setup';
let stopping = false;
let reservation;
let oldToken;

// A finite event-loop watchdog, not a sleep or real timer. Success is driven by
// protocol/stdio/socket events; the monotonic deadline only bounds broken paths.
function bounded(promise, label, milliseconds = 20_000) {
  const completion = Promise.withResolvers();
  const deadline = performance.now() + milliseconds;
  let immediate;
  let settled = false;
  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    clearImmediate(immediate);
    callback(value);
  };
  const check = () => {
    if (performance.now() >= deadline) {
      finish(completion.reject, new Error(`${label}: event deadline exceeded`));
    } else {
      immediate = setImmediate(check);
    }
  };
  Promise.resolve(promise).then(
    (value) => finish(completion.resolve, value),
    (error) => finish(completion.reject, error),
  );
  immediate = setImmediate(check);
  return completion.promise;
}

function signal(session, name) {
  // Never retain/reuse a numeric PID after the owned transport has closed.
  const pid = session.transport.pid;
  if (pid !== null) process.kill(pid, name);
}

function roles() {
  return sessions.map(({ name, pid, role, transport, promotions }) => ({
    session: name, pid, role: transport.pid === null ? 'exited' : role, promotions,
  }));
}

async function health() {
  const response = await bounded(fetch(`${base}/health`), 'health');
  assert.equal(response.status, 200, 'health status');
  const body = await bounded(response.json(), 'health body');
  assert.equal(body.serverVersion, version, 'current-build version');
  return {
    instances: body.instanceCount, peers: body.peerCount,
    webSockets: body.activeWebSockets, pendingRequests: body.pendingRequests,
    proxyInstances: body.proxyInstanceCount,
  };
}

async function startSession(index, expectedRole) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', preload, resolve(root, 'packages/robloxstudio-mcp/dist/index.js')],
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '', HOME: scratch,
      ROBLOX_STUDIO_PORT: new URL(base).port, ROBLOX_STUDIO_HOST: '127.0.0.1',
      ROBLOX_STUDIO_NO_AUTH: '1',
      ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR: join(scratch, 'registry'),
      // Abort instead of forwarding to an unrelated owner if the ephemeral
      // reservation-to-bind race loses. Proxies still use real production logic.
      ROBLOX_STUDIO_REQUIRE_PRIMARY: expectedRole === 'primary' ? '1' : '0',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: `issue87-session-${index}`, version: '1' }, {
    versionNegotiation: { mode: { pin: '2026-07-28' } },
  });
  const ready = Promise.withResolvers();
  const closed = Promise.withResolvers();
  const session = {
    name: `session-${index}`, transport, client, role: 'starting', pid: null,
    promotions: 0, clock: undefined, closed,
  };
  sessions.push(session);
  let partial = '';
  transport.stderr.on('data', (chunk) => {
    partial += chunk.toString();
    const lines = partial.split('\n');
    partial = lines.pop();
    for (const line of lines) {
      if (line.includes('HTTP server listening on') && line.includes('(primary mode)')) {
        session.role = 'primary';
        ready.resolve();
      }
      if (line.includes('entering proxy mode')) {
        session.role = 'proxy';
        ready.resolve();
      }
      if (line.includes('Promoted from proxy to primary')) {
        session.role = 'primary';
        session.promotions += 1;
      }
      if (line === 'ISSUE87_CLOCK_DONE') session.clock?.resolve();
      if (line === 'ISSUE87_CLOCK_FAILED') session.clock?.reject(new Error(`${session.name}: clock callback failed`));
    }
  });
  await bounded(client.connect(transport), `${session.name}: MCP initialize`);
  session.pid = transport.pid;
  const onclose = transport.onclose;
  transport.onclose = () => {
    closed.resolve();
    onclose?.();
  };
  await bounded(ready.promise, `${session.name}: role announcement`);
  assert.equal(session.role, expectedRole, `${session.name}: initial role`);
  assert(!stopping, 'startup interrupted by cleanup');
  return session;
}

async function advance(active) {
  await Promise.all(active.map(async (session) => {
    assert.equal(session.transport.pid, session.pid, `${session.name}: original stdio process survives`);
    session.clock = Promise.withResolvers();
    signal(session, 'SIGUSR2');
    await bounded(session.clock.promise, `${session.name}: promotion/refresh clock completion`);
    session.clock = undefined;
  }));
}

const decode = (result) => result.structuredContent ?? JSON.parse(result.content[0].text);
async function call(session, name, args = {}) {
  const result = await bounded(session.client.callTool({ name, arguments: args }), `${session.name}: ${name}`);
  return { failed: result.isError === true, body: decode(result) };
}

async function connectPeer() {
  const response = await bounded(fetch(`${base}/ready`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      peerId, transportPeerId: peerId, instanceId, role: 'edit',
      placeId: 87, placeName: 'issue87-simulated', dataModelName: 'issue87-simulated',
      isRunning: false, pluginVersion: version, pluginVariant: 'main', timestamp: Date.now(),
    }),
  }), 'simulated Studio ready');
  assert.equal(response.status, 200, 'simulated Studio registration status');
  const body = await bounded(response.json(), 'simulated Studio ready body');
  assert.equal(body.serverVersion, version, 'registered with current plugin version');
  assert(typeof body.transportToken === 'string' && body.transportToken.length > 0, 'transport token issued');
  if (oldToken !== undefined) assert(body.transportToken !== oldToken, 'new primary issues a fresh transport token');
  oldToken = body.transportToken;
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/studio?${new URLSearchParams({ peerId, protocolVersion: '1' })}`, {
    headers: { 'X-Studio-Token': body.transportToken },
  });
  sockets.add(socket);
  const connected = Promise.withResolvers();
  socket.on('error', (error) => connected.reject(error));
  socket.on('message', (data) => {
    try {
      const frame = JSON.parse(data.toString());
      if (frame.kind === 'request') {
        received.push(frame.requestId);
        socket.send(JSON.stringify({ kind: 'response', requestId: frame.requestId, response: { servedBy: peerId } }));
      } else if (frame.kind === 'status') {
        connected.resolve();
      }
    } catch (error) {
      connected.reject(error);
    }
  });
  await bounded(connected.promise, 'simulated Studio initial status');
  return socket;
}

async function checkSessions(active, empty = false) {
  const before = received.length;
  const results = await Promise.all(active.map(async (session) => {
    assert.equal(session.transport.pid, session.pid, `${session.name}: same stdio session`);
    const discovery = await call(session, 'get_connected_instances');
    assert(!discovery.failed, `${session.name}: discovery rejected`);
    const discovered = discovery.body.instances.map(({ id }) => id).sort();
    assert.deepEqual(discovered, empty ? [] : [instanceId], `${session.name}: discovered instances`);
    const dispatch = await call(session, 'get_place_info', { instance_id: instanceId });
    if (empty) {
      assert(dispatch.failed, `${session.name}: old instance must be rejected before Studio returns`);
      assert.equal(dispatch.body.error, 'unrecognized_instance_id', `${session.name}: failover gap error`);
    } else {
      assert(!dispatch.failed, `${session.name}: dispatch rejected (${dispatch.body.error ?? 'unknown'})`);
      assert.equal(dispatch.body.servedBy, peerId, `${session.name}: dispatch reaches simulated peer`);
    }
    return { session: session.name, role: session.role, discovered, outcome: empty ? dispatch.body.error : dispatch.body.servedBy };
  }));
  const counts = await health();
  assert.equal(counts.instances, empty ? 0 : 1, 'health instance count');
  assert.equal(counts.peers, empty ? 0 : 1, 'health peer count');
  assert.equal(counts.webSockets, empty ? 0 : 1, 'health WebSocket count');
  assert.equal(received.length - before, empty ? 0 : active.length, 'one real delivered request per successful session');
  console.log(JSON.stringify({ stage, result: 'PASS', health: counts, sessions: results }));
}

try {
  // Fake only child intervals. Preserve actual network/stdio and all production
  // role logic. Await returned interval promises so a tick acknowledges completed
  // bind attempts, not merely scheduling them. No production modules are replaced.
  await writeFile(preload, [
    "import { mock } from 'node:test';",
    "mock.timers.enable({ apis: ['setInterval'] });",
    'const interval = globalThis.setInterval;',
    'let work = [];',
    'globalThis.setInterval = (callback, delay, ...args) => interval(() => {',
    '  work.push(Promise.resolve().then(() => callback(...args)));',
    '}, delay);',
    "process.on('SIGUSR2', async () => {",
    '  work = [];',
    '  mock.timers.tick(5000);',
    '  const results = await Promise.allSettled(work);',
    "  console.error(results.some((r) => r.status === 'rejected') ? 'ISSUE87_CLOCK_FAILED' : 'ISSUE87_CLOCK_DONE');",
    '});',
  ].join('\n'));
  reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await bounded(once(reservation, 'listening'), 'ephemeral port reservation');
  base = `http://127.0.0.1:${reservation.address().port}`;
  const released = once(reservation, 'close');
  reservation.close();
  await bounded(released, 'ephemeral port release');
  console.log(JSON.stringify({ stage, sessions: count, version, port: Number(new URL(base).port), simulation: 'Studio protocol only; auth disabled; no native Studio or real reconnect loop' }));

  const primary = await startSession(0, 'primary');
  const studio = await connectPeer();
  await Promise.all(Array.from({ length: count - 1 }, (_, index) => startSession(index + 1, 'proxy')));
  stage = 'steady-state';
  console.log(JSON.stringify({ stage, owners: roles() }));
  await checkSessions(sessions);
  // Every proxy attempts promotion while the real owner remains alive.
  await advance(sessions);
  assert.equal(sessions.filter((s) => s.role === 'primary').length, 1, 'exactly one steady-state owner');
  assert(sessions.every((s) => s.promotions === 0), 'no promotion while original primary lives');
  stage = 'steady-state-after-promotion-tick';
  await checkSessions(sessions);

  stage = 'failover-election';
  const disconnected = once(studio, 'close');
  signal(primary, 'SIGTERM');
  await bounded(Promise.all([primary.closed.promise, disconnected]), 'owned primary exit and Studio disconnect');
  const survivors = sessions.filter((s) => s !== primary);
  await advance(survivors);
  assert.equal(survivors.filter((s) => s.role === 'primary').length, 1, 'exactly one survivor promotes');
  assert.equal(survivors.reduce((sum, s) => sum + s.promotions, 0), 1, 'exactly one promotion announcement');
  assert.equal(survivors.filter((s) => s.role === 'proxy').length, count - 2, 'other survivors remain proxies');
  console.log(JSON.stringify({ stage, result: 'PASS', owners: roles() }));
  stage = 'expected-failover-gap-before-Studio-registration';
  await checkSessions(survivors, true);

  stage = 'recovery-after-fresh-Studio-registration';
  await connectPeer();
  await checkSessions(survivors);
  console.log(JSON.stringify({ stage: 'complete', result: 'PASS', deliveredRequests: received.length, owners: roles(), conclusion: 'Steady-state routing and surviving stdio sessions recover after simulated Studio re-registration; gap requires owner/Studio transport loss in this scenario.' }));
} catch (error) {
  console.error(JSON.stringify({ stage, result: 'FAIL', error: error instanceof Error ? error.message : String(error), owners: roles() }));
  process.exitCode = 1;
} finally {
  stopping = true;
  if (reservation?.listening) reservation.close();
  for (const socket of sockets) socket.terminate();
  // Signal-first cleanup avoids depending on stdin EOF or an MCP close response.
  // All PIDs come from our own live StdioClientTransport objects.
  await Promise.all(sessions.map(async (session) => {
    try {
      signal(session, 'SIGKILL');
      if (session.transport.pid !== null) await bounded(session.closed.promise, `${session.name}: cleanup exit`, 5000);
    } catch {
      process.exitCode = 1;
      console.error(JSON.stringify({ stage: 'cleanup', result: 'FAIL', session: session.name }));
    } finally {
      await bounded(session.client.close(), `${session.name}: cleanup transport`, 5000).catch(() => { process.exitCode = 1; });
    }
  }));
  await rm(scratch, { recursive: true, force: true });
}
