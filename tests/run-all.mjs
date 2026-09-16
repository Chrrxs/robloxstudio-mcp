#!/usr/bin/env node
// Runs each integration test as its own Node subprocess and summarizes
// results. Tests stay sequential within one Studio session to protect shared
// playtest state. Independent runners use distinct ports and Studio working
// directories, so separate worktrees can run concurrently.
// Without MCP_INSTANCE_ID, the runner starts a local MCP control process and
// invokes manage_instance over its authenticated HTTP tool endpoint to launch
// and later close a managed baseplate.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DIST } from './lib/mcp-client.mjs';
import { openManagedStudioSession } from './lib/managed-studio-session.mjs';
import { acquireSuitePort, testBasePort } from './lib/test-port.mjs';
import {
  assertStudioDirectoryIsolation,
  assertStudioTestProfile,
  createIsolatedStudioDirectory,
} from '../scripts/studio-lifecycle.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKTREE_PLUGIN = resolve(__dirname, '..', 'studio-plugin', 'MCPPlugin.rbxmx');
const forceManagedSession = process.argv.includes('--managed');


const FULL_TESTS = [
  'path-resolution.mjs',
  'property-value-conversion.mjs',
  'luau-payload-transfers.mjs',
  'capture-broker-transfers.mjs',
  'client-profiler-broker-deadline.mjs',
  'large-input-workflow.mjs',
  'studio-tooling-smoke.mjs',
  'eval-bridge-error-preservation.mjs',
  'eval-context-routing.mjs',
  'runtime-bridge-lifecycle.mjs',
  'playtest-control-repro.mjs',
  'play-cycle-event-stream-regression.mjs',
  'micro-profiler-responsiveness.mjs',
  'studio-grep-responsiveness.mjs',
  'studio-plugin-connection-timeout-regression.mjs',
  'execute-luau-error-preservation.mjs',
  'proxy-mode-peer-fanout.mjs',
  'execute-luau-output-capture.mjs',
  'simulation-state-lifecycle.mjs',
  'multiplayer-add-player-end-regression.mjs',
  'multiplayer-test-lifecycle.mjs',
  'studio-websocket-transport.mjs',
];
const FEATURE_TESTS = [
  'studio-tooling-smoke.mjs',
  'eval-context-routing.mjs',
  'micro-profiler-responsiveness.mjs',
];
// Long-running/inherently failing investigation scenarios are explicit opt-ins.
const DIAGNOSTIC_TESTS = ['luau-recipe-stress.mjs', 'luau-http-budget-repro.mjs', 'studio-websocket-quota.mjs'];
// These require explicit environment setup and are not part of the default suite.
const CONFIGURED_TESTS = ['capture-regressions.mjs'];
const featureSmoke = process.argv.includes('--smoke');
const requestedTestIndex = process.argv.indexOf('--test');
const requestedTest = requestedTestIndex === -1 ? undefined : process.argv[requestedTestIndex + 1];
if (requestedTestIndex !== -1 && !requestedTest) {
  throw new Error('--test requires a test filename');
}
if (requestedTest && !FULL_TESTS.includes(requestedTest) && !DIAGNOSTIC_TESTS.includes(requestedTest) && !CONFIGURED_TESTS.includes(requestedTest)) {
  throw new Error(`Unknown Studio test ${JSON.stringify(requestedTest)}`);
}
const TESTS = requestedTest ? [requestedTest] : (featureSmoke ? FEATURE_TESTS : FULL_TESTS);

// Studio takes a few seconds to fully tear down a play DM after StudioTestService:EndTest.
// Without a gap, the next test's solo_playtest start collides with the previous test's
// in-flight cleanup and either times out or sees a stale 1-peer state.
const INTER_TEST_DELAY_MS = 1000;

async function runOne(file, env) {
  const proc = spawn('node', [resolve(__dirname, file)], { stdio: 'inherit', env });
  const [code] = await once(proc, 'exit');
  return { file, code: code ?? 1 };
}

async function runChecked(command, args, env) {
  const proc = spawn(command, args, { stdio: 'inherit', env });
  const [code, signal] = await once(proc, 'exit');
  if (signal || code !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${signal ?? code ?? 1}`);
  }
}

async function main() {
  const runtimeEnv = { ...process.env };
  if (forceManagedSession) {
    delete runtimeEnv.MCP_INSTANCE_ID;
    delete runtimeEnv.RSMCP_STUDIO_WORKING_DIRECTORY;
    delete runtimeEnv.RSMCP_STUDIO_DIRECTORY_ISOLATED;
    delete runtimeEnv.ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR;
  }
  const existingInstanceId = runtimeEnv.MCP_INSTANCE_ID?.trim();
  let portLease;
  let worker;
  let studioSession;
  const results = [];
  let cleanupFailed = false;
  let retainWorker = false;
  try {
    if (!existingInstanceId) {
      await assertStudioTestProfile();
      await assertStudioDirectoryIsolation();
      if (!runtimeEnv.RSMCP_STUDIO_WORKING_DIRECTORY?.trim()) {
        portLease = await acquireSuitePort({ env: runtimeEnv });
        worker = createIsolatedStudioDirectory({ prefix: 'run-all' });
        runtimeEnv.MCP_PLUGINS_DIR = worker.pluginsDirectory;
        runtimeEnv.RSMCP_STUDIO_WORKING_DIRECTORY = worker.workingDirectory;
        runtimeEnv.RSMCP_STUDIO_DIRECTORY_ISOLATED = '1';
        runtimeEnv.ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR = worker.managedInstanceRegistryDirectory;
        runtimeEnv.ROBLOX_STUDIO_PORT = String(portLease.port);
        console.log(`Installing worktree plugin ${WORKTREE_PLUGIN}`);
        // Never hide a missing worktree build by downloading a released plugin.
        await runChecked(
          process.execPath,
          [DIST, '--install-bundled-plugin', '--plugin-path', WORKTREE_PLUGIN],
          runtimeEnv,
        );
      }
    }
    const suitePort = portLease?.port ?? testBasePort(runtimeEnv);
    console.log(
      `${featureSmoke ? 'Feature E2E smoke' : 'Full integration suite'} using port ${suitePort}` +
      (portLease?.autoAssigned ? ' (isolated worker port)' : ' (configured/default plugin port)'),
    );
    await portLease?.handoff();
    studioSession = await openManagedStudioSession({
      port: suitePort,
      existingInstanceId,
      env: runtimeEnv,
    });
    const childEnv = { ...studioSession.env, MCP_INSTANCE_ID: studioSession.instanceId };
    console.log(
      studioSession.managed
        ? `Launched managed Studio instance ${studioSession.instanceId}`
        : `Using supplied Studio instance ${studioSession.instanceId}`,
    );
    for (let i = 0; i < TESTS.length; i++) {
      if (i > 0) await delay(INTER_TEST_DELAY_MS);
      const r = await runOne(TESTS[i], childEnv);
      results.push(r);
    }
  } catch (error) {
    retainWorker = error?.retainedStudioResources === true;
    throw error;
  } finally {
    if (studioSession) {
      try {
        await studioSession.close();
        if (studioSession.managed) console.log(`Closed managed Studio instance ${studioSession.instanceId}`);
      } catch (error) {
        cleanupFailed = true;
        retainWorker = error?.retainedStudioResources === true;
        console.error(`Failed to close managed Studio instance ${studioSession.instanceId}: ${error.message}`);
      }
    }
    if (worker && retainWorker) {
      console.error(`Retaining isolated Studio worker for exact-identity recovery: ${worker.workingDirectory}`);
    } else if (worker) {
      await delay(1000);
      try {
        worker.cleanup();
      } catch (error) {
        cleanupFailed = true;
        console.error(`Failed to remove isolated Studio worker ${worker.workingDirectory}: ${error.message}`);
      }
    }
    if (portLease) {
      try {
        await portLease.release();
      } catch (error) {
        cleanupFailed = true;
        console.error(`Failed to release suite port ${portLease.port}: ${error.message}`);
      }
    }
  }

  console.log('\n========== SUMMARY ==========');
  for (const r of results) {
    console.log(`  ${r.code === 0 ? '✅ PASS' : '❌ FAIL'}  ${r.file}`);
  }
  const failed = results.filter((r) => r.code !== 0).length;
  console.log(`\n${results.length - failed}/${results.length} passed.`);
  process.exitCode = failed === 0 && !cleanupFailed ? 0 : 1;
}

await main();
