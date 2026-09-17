#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { accessSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  assertStudioDirectoryIsolation,
  assertStudioTestProfile,
  createIsolatedStudioDirectory,
  isWsl,
} from '../scripts/studio-lifecycle.mjs';
import { configurePluginAssetForPort } from '../packages/core/dist/install-plugin-helpers.js';
import { openManagedStudioSession } from './lib/managed-studio-session.mjs';
import { McpClient, REPO_ROOT, connectedInstances, instancePeers } from './lib/mcp-client.mjs';
import { acquireSuitePort } from './lib/test-port.mjs';

const WORKER_COUNT = 2;
const LAUNCH_TIMEOUT_MS = 120000;
const PLAY_TIMEOUT_MS = 60000;
const PLAY_CYCLES = Number(process.argv.find((arg) => arg.startsWith('--cycles='))?.split('=')[1] ?? 1);
assert.ok(Number.isSafeInteger(PLAY_CYCLES) && PLAY_CYCLES > 0, '--cycles must be a positive integer');
const runId = randomUUID();

function assertLiveDesktop() {
  const unavailable = (detail) => {
    const error = new Error(`LIVE_DESKTOP_UNAVAILABLE: ${detail}. Run this acceptance from the enrolled test account's interactive Windows desktop; no functional acceptance has run.`);
    error.code = 'LIVE_DESKTOP_UNAVAILABLE';
    return error;
  };
  if (process.platform !== 'win32' && !isWsl()) {
    throw unavailable('Windows Studio is not accessible on this host');
  }
  let output;
  try {
    output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
$sessionId = (Get-Process -Id $PID).SessionId
$shell = @(Get-Process -Name explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $sessionId })
@{ interactive = [Environment]::UserInteractive; sessionId = $sessionId; shellPresent = ($shell.Count -gt 0) } | ConvertTo-Json -Compress
`], { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim();
  } catch (error) {
    if (error.code === 'ENOENT') throw unavailable('Windows PowerShell interop is unavailable');
    throw new Error('Windows desktop preflight failed (not a skipped acceptance)', { cause: error });
  }
  const desktop = JSON.parse(output);
  if (desktop.interactive !== true || desktop.sessionId <= 0 || desktop.shellPresent !== true) {
    throw unavailable(`no interactive Explorer desktop in the current Windows session (${output})`);
  }
}

// Always settle every sibling before throwing: a late launch must never escape cleanup.
async function settle(label, promises) {
  const results = await Promise.allSettled(promises);
  const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, `${label}: ${failures.map(String).join('; ')}`);
  return results.map((result) => result.value);
}

function clientFor(worker, env, suffix) {
  return new McpClient(`parallel-${worker.index + 1}-${suffix}`, {
    env,
    args: [worker.dist],
    cwd: worker.repoRoot,
    startupTimeoutMs: 15000,
  });
}

async function installPlugin(worker) {
  await assertStudioTestProfile();
  await assertStudioDirectoryIsolation();
  const child = spawn(process.execPath, [worker.dist, '--install-bundled-plugin', '--plugin-path', worker.sourcePlugin], {
    env: worker.env,
    cwd: worker.repoRoot,
    stdio: 'inherit',
  });
  const [code, signal] = await once(child, 'exit');
  if (signal || code !== 0) throw new Error(`Worker ${worker.index + 1} plugin installer exited ${signal ?? code ?? 1}`);
  const installedArtifact = readFileSync(path.join(worker.directory.pluginsDirectory, 'MCPPlugin.rbxmx'));
  const expectedArtifact = configurePluginAssetForPort(worker.sourceArtifact, String(worker.lease.port));
  assert.ok(installedArtifact.equals(expectedArtifact), `Worker ${worker.index + 1} installed plugin differs from its intended build beyond the allowed port and saved-URL key configuration`);
  worker.installedSource = installedArtifact.toString('utf8');
}

function tool(worker, name, args = {}) {
  return worker.client.callTool(name, { ...args, instance_id: worker.session.instanceId }, PLAY_TIMEOUT_MS);
}

async function execute(worker, code, target = 'edit') {
  const result = await tool(worker, 'execute_luau', { target, code });
  assert.equal(result.success, true, `Worker ${worker.index + 1} ${target} execution: ${JSON.stringify(result)}`);
  return String(result.returnValue);
}

async function verifyMarker(worker, other, target = 'edit') {
  const result = await execute(worker, `
local own = workspace:FindFirstChild(${JSON.stringify(worker.marker)})
assert(own ~= nil, "own worker marker is missing")
assert(workspace:FindFirstChild(${JSON.stringify(other.marker)}) == nil, "foreign worker marker leaked into this place")
return own:GetAttribute("Owner")
`, target);
  assert.equal(result, worker.token, `Worker ${worker.index + 1} ${target} place ownership`);
}

async function waitForRole(worker, playing) {
  const deadline = Date.now() + PLAY_TIMEOUT_MS;
  let peers = [];
  do {
    const connected = await worker.client.callTool('get_connected_instances', {});
    const instance = connectedInstances(connected).find((entry) => entry.id === worker.session.instanceId);
    peers = instancePeers(instance);
    if (playing ? peers.some((peer) => peer.role === 'server')
      : peers.some((peer) => peer.role === 'edit') && !peers.some((peer) => peer.role === 'server' || peer.role.startsWith('client'))) return;
    await delay(500);
  } while (Date.now() < deadline);
  throw new Error(`Worker ${worker.index + 1} did not reach ${playing ? 'play' : 'edit'} mode: ${JSON.stringify(peers)}`);
}

async function stopPlay(worker) {
  const result = await tool(worker, 'solo_playtest', { action: 'stop' });
  assert.equal(result.success, true, `Worker ${worker.index + 1} play stop: ${JSON.stringify(result)}`);
  await waitForRole(worker, false);
  worker.playing = false;
}

const workers = [];
let primaryError;
try {
  // Optional roots exercise two different worktree builds, not a shared globally installed plugin.
  for (let index = 0; index < WORKER_COUNT; index += 1) {
    const repoRoot = path.resolve(process.env[`RSMCP_PARALLEL_REPO_ROOT_${index + 1}`] ?? REPO_ROOT);
    const dist = path.join(repoRoot, 'packages/robloxstudio-mcp/dist/index.js');
    const sourcePlugin = path.join(repoRoot, 'studio-plugin/MCPPlugin.rbxmx');
    accessSync(dist);
    const sourceArtifact = readFileSync(sourcePlugin);
    workers.push({ index, repoRoot, dist, sourcePlugin, sourceArtifact, marker: `RsmcpParallel_${runId}_${index}`, token: `${runId}:${index}` });
  }
  assertLiveDesktop();
  await assertStudioTestProfile();
  const settingsBefore = await assertStudioDirectoryIsolation();

  for (const worker of workers) {
    worker.directory = await createIsolatedStudioDirectory({ prefix: `parallel-${worker.index + 1}` });
  }
  await settle('Port allocation failed', workers.map(async (worker) => {
    worker.lease = await acquireSuitePort({ env: {} });
    worker.env = {
      ...process.env,
      ...worker.directory.environment,
      MCP_INSTANCE_ID: '',
      MCP_PLUGINS_DIR: worker.directory.pluginsDirectory,
      ROBLOX_STUDIO_PORT: String(worker.lease.port),
      ROBLOX_STUDIO_REQUIRE_PRIMARY: '1',
      RSMCP_AUTO_ASSIGNED_PORT: '0',
      RSMCP_STUDIO_WORKING_DIRECTORY: worker.directory.workingDirectory,
      ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR: worker.directory.managedInstanceRegistryDirectory,
      ROBLOX_STUDIO_EXE: process.env[`RSMCP_PARALLEL_STUDIO_EXE_${worker.index + 1}`] ?? process.env.ROBLOX_STUDIO_EXE ?? '',
    };
  }));
  for (const values of [
    workers.map((worker) => worker.lease.port),
    workers.map((worker) => worker.directory.workingDirectory),
    workers.map((worker) => worker.directory.pluginsDirectory),
    workers.map((worker) => worker.directory.managedInstanceRegistryDirectory),
  ]) {
    assert.ok(values.every((value) => value !== undefined && value !== ''), 'Every isolation boundary must be explicit');
    assert.equal(new Set(values).size, WORKER_COUNT, `Workers share an isolation boundary: ${JSON.stringify(values)}`);
  }
  await settle('Plugin installation failed', workers.map(installPlugin));
  for (const worker of workers) {
    assert.ok(worker.installedSource.includes(`http://localhost:${worker.lease.port}`), `Worker ${worker.index + 1} plugin lacks its own port`);
    for (const other of workers) {
      if (other !== worker) assert.ok(!worker.installedSource.includes(`http://localhost:${other.lease.port}`), `Worker ${worker.index + 1} plugin contains a foreign port`);
    }
  }
  assert.notEqual(workers[0].installedSource, workers[1].installedSource, 'Installed worker plugin artifacts must differ');

  await settle('Port handoff failed', workers.map((worker) => worker.lease.handoff()));
  await settle('Managed Studio launch failed', workers.map(async (worker) => {
    worker.session = await openManagedStudioSession({ port: worker.lease.port, env: worker.env, launchTimeoutMs: LAUNCH_TIMEOUT_MS }, {
      createControl: (env) => clientFor(worker, env, 'manager'),
    });
  }));
  assert.equal(new Set(workers.map((worker) => worker.session.instanceId)).size, WORKER_COUNT, 'Workers connected to the same Studio instance');
  assert.equal(new Set(workers.map((worker) => worker.session.processIdentity?.processId)).size, WORKER_COUNT, 'Workers share a Studio process');
  for (const worker of workers) {
    assert.ok(worker.session.managed && worker.session.launchId, 'Acceptance must own every Studio launch');
    assert.ok(Number.isSafeInteger(worker.session.processIdentity?.processId) && worker.session.processIdentity.processId > 0, 'Managed launch must retain an exact process identity');
    assert.match(worker.session.processIdentity.startedAtFileTime, /^[1-9]\d*$/u);
    assert.equal(worker.session.studioWorkingDirectory, worker.directory.workingDirectory);
    assert.equal(worker.session.managedInstanceRegistryDirectory, worker.directory.managedInstanceRegistryDirectory);
  }
  await settle('Functional client startup failed', workers.map(async (worker) => {
    worker.client = clientFor(worker, { ...worker.session.env, MCP_INSTANCE_ID: worker.session.instanceId }, 'functional');
    await worker.client.start();
    await worker.client.initialize();
    assert.ok(worker.client.isProxy(), 'Functional client must reach its worker-owned primary');
  }));
  await settle('Managed registry isolation failed', workers.map(async (worker) => {
    const status = await worker.client.callTool('manage_instance', { action: 'status' });
    assert.ok(Array.isArray(status.managed), 'Registry status must report managed launches');
    assert.deepEqual(status.managed.map((entry) => entry.launch_id), [worker.session.launchId], 'Each worker registry must contain only its own launch');
    const connected = await worker.client.callTool('get_connected_instances', {});
    assert.deepEqual(connectedInstances(connected).map((entry) => entry.id), [worker.session.instanceId], 'Each primary must connect only its own plugin');
  }));
  await settle('Place marker creation failed', workers.map(async (worker) => {
    assert.equal(await execute(worker, `
assert(workspace:FindFirstChild(${JSON.stringify(worker.marker)}) == nil, "marker already exists")
local marker = Instance.new("Folder")
marker.Name = ${JSON.stringify(worker.marker)}
marker:SetAttribute("Owner", ${JSON.stringify(worker.token)})
marker.Parent = workspace
return marker:GetAttribute("Owner")
`), worker.token);
  }));
  await settle('Edit place isolation failed', workers.map((worker, index) => verifyMarker(worker, workers[1 - index])));

  for (let cycle = 1; cycle <= PLAY_CYCLES; cycle += 1) {
    console.log(`Parallel play/stop cycle ${cycle}/${PLAY_CYCLES}`);
    await settle('Concurrent play failed', workers.map(async (worker) => {
      worker.playing = true;
      const result = await tool(worker, 'solo_playtest', { action: 'start', mode: 'play' });
      assert.equal(result.success, true, `Worker ${worker.index + 1} play start: ${JSON.stringify(result)}`);
      await waitForRole(worker, true);
    }));
    await settle('Runtime place isolation failed', workers.map((worker, index) => verifyMarker(worker, workers[1 - index], 'server')));
    await settle('Concurrent stop failed', workers.map(stopPlay));
    await settle('Post-play isolation failed', workers.map((worker, index) => verifyMarker(worker, workers[1 - index])));
  }

  const [a, b] = workers;
  await a.client.stop();
  await a.session.close();
  a.closed = true;
  await verifyMarker(b, a);
  assert.equal(await execute(b, `local marker = workspace:FindFirstChild(${JSON.stringify(b.marker)}) marker:SetAttribute("AfterSiblingClose", true) return marker:GetAttribute("AfterSiblingClose")`), 'true');
  await verifyMarker(b, a);
  const settingsAfter = await assertStudioDirectoryIsolation();
  assert.equal(settingsAfter.value, settingsBefore.value, 'Studio changed the isolated PluginsDir setting');
} catch (error) {
  primaryError = error;
} finally {
  const cleanupFailures = [];
  async function cleanup(promises) {
    const results = await Promise.allSettled(promises);
    cleanupFailures.push(...results.filter((result) => result.status === 'rejected').map((result) => result.reason));
  }
  await cleanup(workers.filter((worker) => worker.playing && worker.client && !worker.closed).map(stopPlay));
  await cleanup(workers.filter((worker) => worker.client).map((worker) => worker.client.stop()));
  await cleanup(workers.filter((worker) => worker.session && !worker.closed).map(async (worker) => {
    await worker.session.close();
    worker.closed = true;
  }));
  await cleanup(workers.filter((worker) => worker.lease).map((worker) => worker.lease.release()));
  for (const worker of workers) {
    if (!worker.directory) continue;
    try {
      await worker.directory.cleanup();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (cleanupFailures.length) {
    throw new AggregateError(primaryError ? [primaryError, ...cleanupFailures] : cleanupFailures, 'Parallel isolation cleanup failed', { cause: primaryError });
  }
}
if (primaryError) throw primaryError;
console.log(`Parallel Studio functional isolation passed: build-specific plugins, distinct ports/directories/registries, edit and play markers, play/stop, and worker B execution after worker A closed (${workers.map((worker) => worker.session.instanceId).join(', ')}).`);
