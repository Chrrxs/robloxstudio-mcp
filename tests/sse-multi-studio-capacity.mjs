#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  closeStudioProcess,
  configureStudioDirectoryIsolation,
  createIsolatedStudioDirectory,
} from '../scripts/studio-lifecycle.mjs';
import {
  DIST,
  McpClient,
  REPO_ROOT,
  connectedInstances,
  instancePeers,
  routingPeers,
} from './lib/mcp-client.mjs';
import { acquireSuitePort } from './lib/test-port.mjs';

const STUDIO_COUNT = 4;
const EXPECTED_PHYSICAL_STREAMS = STUDIO_COUNT * 2;
const LAUNCH_TIMEOUT_MS = 120_000;
const CONNECTION_TIMEOUT_MS = 120_000;
const POLL_MS = 500;
const WORKTREE_PLUGIN = path.join(REPO_ROOT, 'studio-plugin', 'MCPPlugin.rbxmx');

function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}
async function settleOrThrow(promises, label) {
  const results = await Promise.allSettled(promises);
  const failures = results
    .filter((result) => result.status === 'rejected')
    .map((result) => asError(result.reason));
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `${label}: ${failures.map((error) => error.message).join('; ')}`);
  }
  return results.map((result) => result.value);
}


function uniquePeers(peers) {
  return [...new Map(peers.map((peer) => [peer.peerId, peer])).values()];
}

function workerEnvironment(worker, port, workerIndex, { requirePrimary }) {
  const env = {
    ...process.env,
    MCP_PLUGINS_DIR: worker.pluginsDirectory,
    ROBLOX_STUDIO_PORT: String(port),
    RSMCP_AUTO_ASSIGNED_PORT: '0',
    RSMCP_STUDIO_WORKING_DIRECTORY: worker.workingDirectory,
  };
  env.ROBLOX_STUDIO_REQUIRE_PRIMARY = requirePrimary ? '1' : '0';

  const studioExecutable = process.env[`RSMCP_PARALLEL_STUDIO_EXE_${workerIndex + 1}`]
    ?? process.env.ROBLOX_STUDIO_EXE;
  if (studioExecutable) env.ROBLOX_STUDIO_EXE = studioExecutable;
  else delete env.ROBLOX_STUDIO_EXE;
  return env;
}

async function installPlugin(worker, port, workerIndex) {
  const env = workerEnvironment(worker, port, workerIndex, { requirePrimary: true });
  const child = spawn(
    process.execPath,
    [DIST, '--install-bundled-plugin', '--plugin-path', WORKTREE_PLUGIN],
    { env, stdio: 'inherit' },
  );
  const [code, signal] = await once(child, 'exit');
  if (signal || code !== 0) {
    throw new Error(`Plugin installer ${workerIndex + 1} exited ${signal ?? code ?? 1}`);
  }

  const pluginPath = path.join(worker.pluginsDirectory, 'MCPPlugin.rbxmx');
  const expectedUrl = `http://localhost:${port}`;
  if (!readFileSync(pluginPath, 'utf8').includes(expectedUrl)) {
    throw new Error(`Studio ${workerIndex + 1} plugin is missing shared bridge URL ${expectedUrl}`);
  }
  return env;
}

async function startControl(worker, port, workerIndex, controls) {
  const expectPrimary = workerIndex === 0;
  const control = new McpClient(`sse-capacity-${workerIndex + 1}`, {
    env: workerEnvironment(worker, port, workerIndex, { requirePrimary: expectPrimary }),
    startupTimeoutMs: 10_000,
  });
  controls[workerIndex] = control;
  await control.start();
  await control.initialize();

  const expectedModeObserved = expectPrimary ? control.isPrimary() : control.isProxy();
  if (!expectedModeObserved) {
    throw new Error(
      `MCP control ${workerIndex + 1} did not enter ${expectPrimary ? 'primary' : 'proxy'} mode. ` +
      `Recent stderr:\n${control.recentStderr(20)}`,
    );
  }
  return control;
}

function assertExactLaunch(launch, worker, workerIndex) {
  if (!launch?.launch_id) {
    throw new Error(`Studio ${workerIndex + 1} launch did not return ownership: ${JSON.stringify(launch)}`);
  }
  if (
    !Number.isSafeInteger(launch.pid) ||
    launch.pid < 1 ||
    typeof launch.process_started_at_file_time !== 'string' ||
    !/^[1-9]\d*$/u.test(launch.process_started_at_file_time)
  ) {
    throw new Error(`Studio ${workerIndex + 1} launch did not return exact process identity: ${JSON.stringify(launch)}`);
  }
  if (launch.studio_working_directory !== worker.workingDirectory) {
    throw new Error(
      `Studio ${workerIndex + 1} reported working directory ` +
      `${JSON.stringify(launch.studio_working_directory)} instead of ${JSON.stringify(worker.workingDirectory)}`,
    );
  }
}

async function launchWorker(control, worker, workerIndex, launches) {
  const launch = await control.callTool('manage_instance', {
    action: 'launch',
    source: 'baseplate',
    require_process_identity: true,
    studio_working_directory: worker.workingDirectory,
    timeout_ms: LAUNCH_TIMEOUT_MS,
  }, LAUNCH_TIMEOUT_MS + 10_000);
  launches[workerIndex] = launch;
  assertExactLaunch(launch, worker, workerIndex);

  const authorized = await control.callTool('manage_instance', {
    action: 'authorize',
    launch_id: launch.launch_id,
  });
  if (authorized?.process_authorized !== true) {
    throw new Error(`manage_instance did not authorize Studio ${workerIndex + 1} launch ${launch.launch_id}`);
  }

  const completed = await control.callTool('manage_instance', {
    action: 'complete',
    launch_id: launch.launch_id,
  });
  if (completed?.process_ownership_released !== true) {
    throw new Error(`manage_instance did not complete Studio ${workerIndex + 1} launch ${launch.launch_id}`);
  }
  return launch;
}

async function waitForLaunchEditPeer(control, launch, workerIndex) {
  const deadline = Date.now() + CONNECTION_TIMEOUT_MS;
  let lastStatus;
  while (Date.now() < deadline) {
    lastStatus = await control.callTool('manage_instance', {
      action: 'status',
      launch_id: launch.launch_id,
    }, 10_000);
    if (
      lastStatus?.connected === true &&
      typeof lastStatus.instance_id === 'string' &&
      lastStatus.instance_id &&
      Array.isArray(lastStatus.roles) &&
      lastStatus.roles.includes('edit')
    ) {
      return lastStatus.instance_id;
    }
    if (lastStatus?.state === 'failed' || lastStatus?.state === 'exited') {
      throw new Error(
        `Studio ${workerIndex + 1} launch ${launch.launch_id} entered ${lastStatus.state}: ` +
        JSON.stringify(lastStatus),
      );
    }
    await delay(POLL_MS);
  }
  throw new Error(
    `Studio ${workerIndex + 1} launch ${launch.launch_id} did not register an edit peer within ` +
    `${CONNECTION_TIMEOUT_MS}ms. Last status: ${JSON.stringify(lastStatus)}`,
  );
}

async function waitForAllEditPeers(control, expectedInstanceIds) {
  const expected = new Set(expectedInstanceIds);
  const deadline = Date.now() + CONNECTION_TIMEOUT_MS;
  let lastConnected;
  while (Date.now() < deadline) {
    lastConnected = await control.callTool('get_connected_instances', {}, 10_000);
    const edits = new Set(connectedInstances(lastConnected)
      .filter((instance) => instancePeers(instance).some((peer) => peer.role === 'edit'))
      .map((instance) => instance.id));
    if ([...expected].every((id) => edits.has(id))) return lastConnected;
    await delay(POLL_MS);
  }
  throw new Error(
    `Primary MCP did not report all four edit peers within ${CONNECTION_TIMEOUT_MS}ms. ` +
    `Expected ${JSON.stringify(expectedInstanceIds)}; last response: ${JSON.stringify(lastConnected)}`,
  );
}

async function readHealth(port) {
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`/health returned HTTP ${response.status}`);
  return response.json();
}

async function waitForServerCapacity(control, port, expectedInstanceIds) {
  const expected = new Set(expectedInstanceIds);
  const deadline = Date.now() + CONNECTION_TIMEOUT_MS;
  let lastConnected;
  let lastHealth;
  let lastError;

  while (Date.now() < deadline) {
    try {
      [lastConnected, lastHealth] = await Promise.all([
        control.callTool('get_connected_instances', {}, 10_000),
        readHealth(port),
      ]);
      const allRuntimePeersPresent = expectedInstanceIds.every((id) => {
        const roles = routingPeers(lastConnected, id).map((peer) => peer.role);
        return roles.includes('edit') &&
          roles.includes('server') &&
          roles.some((role) => /^client-[1-9]\d*$/.test(role));
      });
      if (allRuntimePeersPresent && lastHealth?.activeEventStreams >= EXPECTED_PHYSICAL_STREAMS) {
        return { connected: lastConnected, health: lastHealth };
      }
      lastError = undefined;
    } catch (error) {
      lastError = asError(error);
    }
    await delay(POLL_MS);
  }

  throw new Error(
    `Four play-server/client peer sets and ${EXPECTED_PHYSICAL_STREAMS} physical event streams did not appear within ` +
    `${CONNECTION_TIMEOUT_MS}ms. Last connected response: ${JSON.stringify(lastConnected)}; ` +
    `last health: ${JSON.stringify(lastHealth)}; last polling error: ${lastError?.message ?? 'none'}`,
  );
}

function assertCapacityEvidence(connected, health, expectedInstanceIds) {
  const scopedPeers = uniquePeers(
    expectedInstanceIds.flatMap((instanceId) => routingPeers(connected, instanceId)),
  );
  const physicalPeers = scopedPeers.filter((peer) => peer.role === 'edit' || peer.role === 'server');
  if (physicalPeers.length !== EXPECTED_PHYSICAL_STREAMS) {
    throw new Error(`Expected four edit/server peer pairs, got ${JSON.stringify(physicalPeers)}`);
  }
  if (!Number.isInteger(health.activeEventStreams) || health.activeEventStreams < EXPECTED_PHYSICAL_STREAMS) {
    throw new Error(`Health did not report at least ${EXPECTED_PHYSICAL_STREAMS} active event streams: ${JSON.stringify(health)}`);
  }

  const clientPeers = scopedPeers.filter((peer) => /^client-[1-9]\d*$/.test(peer.role));
  const instancesWithoutClients = expectedInstanceIds.filter((instanceId) =>
    !routingPeers(connected, instanceId).some((peer) => /^client-[1-9]\d*$/.test(peer.role)));
  if (instancesWithoutClients.length > 0) {
    throw new Error(`Expected a logical client peer for every playtest; missing ${JSON.stringify(instancesWithoutClients)}`);
  }
  if (health.activeEventStreams !== physicalPeers.length) {
    throw new Error(
      `Logical client peers must not add physical SSE responses. Physical edit/server peers: ` +
      `${physicalPeers.length}; logical clients: ${JSON.stringify(clientPeers)}; health: ${JSON.stringify(health)}`,
    );
  }

  const scopedHealthPeers = expectedInstanceIds
    .flatMap((instanceId) => routingPeers(health, instanceId));
  const healthPeers = uniquePeers(scopedHealthPeers);
  for (const instanceId of expectedInstanceIds) {
    const routed = routingPeers(health, instanceId);
    if (!routed.some((peer) => peer.role === 'edit') || !routed.some((peer) => peer.role === 'server')) {
      throw new Error(`Health lacks distinct edit/server peer evidence for ${instanceId}: ${JSON.stringify(healthPeers)}`);
    }
  }
  const peerIds = scopedHealthPeers
    .map((peer) => peer.peerId)
    .filter((id) => typeof id === 'string' && id);
  if (new Set(peerIds).size !== peerIds.length) {
    throw new Error(`Health reported duplicate peer ids: ${JSON.stringify(peerIds)}`);
  }
}

async function stopPlaytest(control, instanceIdValue) {
  let lastResult;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    lastResult = await control.callTool('solo_playtest', {
      action: 'stop',
      instance_id: instanceIdValue,
    }, 30_000);
    if (lastResult?.success === true) return;
    if (attempt === 0) await delay(1_000);
  }
  throw new Error(`solo_playtest did not stop ${instanceIdValue}: ${JSON.stringify(lastResult)}`);
}

async function closeWorker(control, launch) {
  if (!launch) return;
  let managedError;
  if (control && launch.launch_id) {
    try {
      const closed = await control.callTool('manage_instance', {
        action: 'close',
        launch_id: launch.launch_id,
      });
      if (closed?.close_status !== 'closed' && closed?.close_status !== 'already_closed') {
        throw new Error(`manage_instance did not close ${launch.launch_id}: ${JSON.stringify(closed)}`);
      }
      return;
    } catch (error) {
      managedError = asError(error);
    }
  }

  try {
    await closeStudioProcess({
      processId: launch.pid,
      startedAtFileTime: launch.process_started_at_file_time,
    });
  } catch (identityError) {
    if (managedError) {
      throw new AggregateError(
        [managedError, asError(identityError)],
        `Could not close exactly owned Studio process ${launch.pid}`,
        { cause: managedError },
      );
    }
    throw identityError;
  }
  if (managedError) throw managedError;
}

await configureStudioDirectoryIsolation({ requireStudioClosed: false });

const workers = [];
const controls = [];
const launches = [];
const playtestInstanceIds = new Set();
let portLease;
let primaryError;

try {
  portLease = await acquireSuitePort({ env: {} });
  for (let index = 0; index < STUDIO_COUNT; index += 1) {
    workers.push(createIsolatedStudioDirectory({ prefix: `sse-capacity-${index + 1}` }));
  }

  await settleOrThrow(
    workers.map((worker, index) => installPlugin(worker, portLease.port, index)),
    'Installing four isolated Studio plugins',
  );
  await portLease.handoff();

  await startControl(workers[0], portLease.port, 0, controls);
  await settleOrThrow(
    workers.slice(1).map((worker, offset) => startControl(worker, portLease.port, offset + 1, controls)),
    'Starting proxy MCP controls',
  );

  await configureStudioDirectoryIsolation({ requireStudioClosed: false });
  const launched = await settleOrThrow(
    controls.map((control, index) => launchWorker(control, workers[index], index, launches)),
    'Launching four managed Studio processes',
  );
  const launchIdentities = launched.map((launch) =>
    `${launch.pid}:${launch.process_started_at_file_time}`);
  if (new Set(launchIdentities).size !== STUDIO_COUNT) {
    throw new Error(`Managed launches did not identify four distinct Studio processes: ${JSON.stringify(launchIdentities)}`);
  }

  const expectedInstanceIds = await settleOrThrow(
    launched.map((launch, index) => waitForLaunchEditPeer(controls[index], launch, index)),
    'Waiting for four managed edit peers',
  );
  if (new Set(expectedInstanceIds).size !== STUDIO_COUNT) {
    throw new Error(`Managed launches did not register four distinct place ids: ${JSON.stringify(expectedInstanceIds)}`);
  }
  await waitForAllEditPeers(controls[0], expectedInstanceIds);

  await settleOrThrow(expectedInstanceIds.map(async (id, index) => {
    playtestInstanceIds.add(id);
    const started = await controls[index].callTool('solo_playtest', {
      action: 'start',
      mode: 'play',
      instance_id: id,
    }, 60_000);
    if (started?.success !== true) {
      throw new Error(`solo_playtest did not start for Studio ${index + 1} (${id}): ${JSON.stringify(started)}`);
    }
  }), 'Starting four solo playtests');

  const evidence = await waitForServerCapacity(controls[0], portLease.port, expectedInstanceIds);
  assertCapacityEvidence(evidence.connected, evidence.health, expectedInstanceIds);
  console.log(
    `SSE multi-Studio capacity passed: ${expectedInstanceIds.length} Studio processes, ` +
    `${evidence.health.activeEventStreams} physical event streams on port ${portLease.port}.`,
  );
} catch (error) {
  primaryError = asError(error);
  throw error;
} finally {
  const cleanupFailures = [];

  const playtestStops = await Promise.allSettled([...playtestInstanceIds].map((id, index) =>
    stopPlaytest(controls[index] ?? controls[0], id)));

  const studioCloses = await Promise.allSettled(launches.map((launch, index) =>
    closeWorker(controls[index], launch)));
  for (const [index, result] of studioCloses.entries()) {
    if (result.status === 'rejected') {
      cleanupFailures.push(asError(result.reason));
    }
    const stopResult = playtestStops[index];
    if (stopResult?.status !== 'rejected') continue;
    if (result.status === 'rejected') {
      cleanupFailures.push(asError(stopResult.reason));
    } else {
      console.warn(
        `Playtest stop ${index + 1} failed, but the exactly owned Studio process closed successfully: ` +
        asError(stopResult.reason).message,
      );
    }
  }

  const controlStops = await Promise.allSettled(controls.map((control) => control.stop()));
  cleanupFailures.push(...controlStops
    .filter((result) => result.status === 'rejected')
    .map((result) => asError(result.reason)));

  try {
    await configureStudioDirectoryIsolation({ requireStudioClosed: false });
  } catch (error) {
    cleanupFailures.push(asError(error));
  }

  if (portLease) {
    try {
      await portLease.release();
    } catch (error) {
      cleanupFailures.push(asError(error));
    }
  }

  await delay(1_000);
  for (const worker of workers) {
    try {
      worker.cleanup();
    } catch (error) {
      cleanupFailures.push(asError(error));
    }
  }

  if (cleanupFailures.length > 0) {
    if (primaryError) {
      throw new AggregateError(
        [primaryError, ...cleanupFailures],
        `SSE capacity test failed and cleanup also failed: ${cleanupFailures.map((error) => error.message).join('; ')}`,
        { cause: primaryError },
      );
    }
    throw new AggregateError(cleanupFailures, 'SSE capacity cleanup failed');
  }
}
