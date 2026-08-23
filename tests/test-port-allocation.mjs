#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { McpClient } from './lib/mcp-client.mjs';
import {
  acquireSuitePort,
  configuredTestPort,
  testBasePort,
} from './lib/test-port.mjs';

async function canListen(port) {
  const server = net.createServer();
  const listening = once(server, 'listening');
  server.listen(port, '127.0.0.1');
  try {
    await listening;
  } catch (error) {
    if (error.code === 'EADDRINUSE') return false;
    throw error;
  }
  const closed = once(server, 'close');
  server.close();
  await closed;
  return true;
}

assert.equal(configuredTestPort({}), undefined);
assert.equal(configuredTestPort({ ROBLOX_STUDIO_PORT: '43123' }), 43123);
assert.equal(testBasePort({}), 58741);
assert.equal(testBasePort({ ROBLOX_STUDIO_PORT: '43123' }), 43123);
assert.throws(
  () => configuredTestPort({ ROBLOX_STUDIO_PORT: 'not-a-port' }),
  /ROBLOX_STUDIO_PORT/,
);
assert.throws(
  () => configuredTestPort({ ROBLOX_STUDIO_PORT: '0' }),
  /ROBLOX_STUDIO_PORT/,
);

const [first, second] = await Promise.all([
  acquireSuitePort({ env: {} }),
  acquireSuitePort({ env: {} }),
]);

try {
  assert.equal(first.autoAssigned, true);
  assert.equal(second.autoAssigned, true);
  assert.notEqual(first.port, second.port, 'simultaneous suites receive distinct ports');
  assert.equal(await canListen(first.port), false, 'first lease reserves its port before server startup');
  assert.equal(await canListen(second.port), false, 'second lease reserves its port before server startup');

  await first.handoff();
  await second.handoff();
  assert.equal(await canListen(first.port), true, 'handoff makes the first port available to its server');
  assert.equal(await canListen(second.port), true, 'handoff makes the second port available to its server');
} finally {
  await Promise.all([first.release(), second.release()]);
}

let windowsCheckCalls = 0;
let windowsRejectedPort;
const crossPlatformLease = await acquireSuitePort({
  env: {},
  windowsAvailabilityCheck(port) {
    windowsCheckCalls += 1;
    if (windowsCheckCalls === 1) {
      windowsRejectedPort = port;
      return false;
    }
    return true;
  },
});
try {
  assert.equal(windowsCheckCalls, 2, 'allocator retries a port occupied only on the Windows side');
  assert.notEqual(crossPlatformLease.port, windowsRejectedPort);
} finally {
  await crossPlatformLease.release();
}

const explicit = await acquireSuitePort({ env: { ROBLOX_STUDIO_PORT: '43123' } });
try {
  assert.equal(explicit.port, 43123);
  assert.equal(explicit.autoAssigned, false);
} finally {
  await explicit.release();
}

const clientModuleUrl = new URL('./lib/mcp-client.mjs', import.meta.url).href;
const child = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '--eval',
    `const { BASE_PORT } = await import(${JSON.stringify(clientModuleUrl)}); process.stdout.write(String(BASE_PORT));`,
  ],
  {
    encoding: 'utf8',
    env: { ...process.env, ROBLOX_STUDIO_PORT: '43123' },
  },
);
assert.equal(child.status, 0, child.stderr);
assert.equal(child.stdout, '43123', 'McpClient children inherit the suite-assigned port');

const previousAutoAssigned = process.env.RSMCP_AUTO_ASSIGNED_PORT;
const previousRequirePrimary = process.env.ROBLOX_STUDIO_REQUIRE_PRIMARY;
let fakePrimary;
let fakeProxy;
try {
  process.env.RSMCP_AUTO_ASSIGNED_PORT = '1';
  process.env.ROBLOX_STUDIO_REQUIRE_PRIMARY = '1';
  const fakeServer = [
    'console.error("require-primary=" + (process.env.ROBLOX_STUDIO_REQUIRE_PRIMARY ?? "unset"));',
    'console.error("HTTP server listening (primary mode)");',
    'console.error("fake running on stdio");',
    'setInterval(() => {}, 1000);',
  ].join('\n');

  fakePrimary = new McpClient('fake-primary', {
    args: ['--eval', fakeServer],
    startupTimeoutMs: 2000,
  });
  await fakePrimary.start();
  assert.match(
    fakePrimary.recentStderr(),
    /require-primary=1/,
    'the first client on an automatic port must become primary',
  );

  fakeProxy = new McpClient('fake-proxy', {
    args: ['--eval', fakeServer],
    startupTimeoutMs: 2000,
  });
  await fakeProxy.start();
  assert.match(
    fakeProxy.recentStderr(),
    /require-primary=unset/,
    'later clients may proxy only after a primary is confirmed',
  );
} finally {
  if (fakeProxy) await fakeProxy.stop();
  if (fakePrimary) await fakePrimary.stop();
  if (previousAutoAssigned === undefined) delete process.env.RSMCP_AUTO_ASSIGNED_PORT;
  else process.env.RSMCP_AUTO_ASSIGNED_PORT = previousAutoAssigned;
  if (previousRequirePrimary === undefined) delete process.env.ROBLOX_STUDIO_REQUIRE_PRIMARY;
  else process.env.ROBLOX_STUDIO_REQUIRE_PRIMARY = previousRequirePrimary;
}

console.log('test port allocation passed');
