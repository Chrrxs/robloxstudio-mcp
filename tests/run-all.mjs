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
import { testBasePort } from './lib/test-port.mjs';
import {
  configureStudioDirectoryIsolation,
  createIsolatedStudioDirectory,
} from '../scripts/studio-lifecycle.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKTREE_PLUGIN = resolve(__dirname, '..', 'studio-plugin', 'MCPPlugin.rbxmx');
const forceManagedSession = process.argv.includes('--managed');
if (forceManagedSession) {
  delete process.env.MCP_INSTANCE_ID;
  delete process.env.RSMCP_STUDIO_WORKING_DIRECTORY;
  delete process.env.RSMCP_STUDIO_DIRECTORY_ISOLATED;
}


const FULL_TESTS = [
  'path-resolution.mjs',
  'property-value-conversion.mjs',
  'studio-tooling-smoke.mjs',
  'eval-bridge-error-preservation.mjs',
  'eval-context-routing.mjs',
  'runtime-bridge-lifecycle.mjs',
  'micro-profiler-responsiveness.mjs',
  'execute-luau-error-preservation.mjs',
  'proxy-mode-peer-fanout.mjs',
  'execute-luau-output-capture.mjs',
  'simulation-state-lifecycle.mjs',
  'multiplayer-add-player-end-regression.mjs',
  'multiplayer-test-lifecycle.mjs',
];
const FEATURE_TESTS = [
  'studio-tooling-smoke.mjs',
  'eval-context-routing.mjs',
  'micro-profiler-responsiveness.mjs',
];
const featureSmoke = process.argv.includes('--smoke');
const TESTS = featureSmoke ? FEATURE_TESTS : FULL_TESTS;

// Studio takes a few seconds to fully tear down a play DM after StudioTestService:EndTest.
// Without a gap, the next test's solo_playtest start collides with the previous test's
// in-flight cleanup and either times out or sees a stale 1-peer state.
const INTER_TEST_DELAY_MS = 1000;

async function runOne(file) {
  const proc = spawn('node', [resolve(__dirname, file)], { stdio: 'inherit' });
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
  const hasConfiguredPort = process.env.ROBLOX_STUDIO_PORT !== undefined
    && process.env.ROBLOX_STUDIO_PORT !== '';
  const suitePort = testBasePort();
  process.env.ROBLOX_STUDIO_PORT = String(suitePort);
  console.log(
    `${featureSmoke ? 'Feature E2E smoke' : 'Full integration suite'} using port ${suitePort}` +
    (hasConfiguredPort ? ' (from ROBLOX_STUDIO_PORT)' : ' (default plugin port)'),
  );

  let worker;
  if (!process.env.MCP_INSTANCE_ID && !process.env.RSMCP_STUDIO_WORKING_DIRECTORY) {
    await configureStudioDirectoryIsolation({ requireStudioClosed: false });
    worker = createIsolatedStudioDirectory({ prefix: 'run-all' });
    process.env.MCP_PLUGINS_DIR = worker.pluginsDirectory;
    process.env.RSMCP_STUDIO_WORKING_DIRECTORY = worker.workingDirectory;
    process.env.RSMCP_STUDIO_DIRECTORY_ISOLATED = '1';
    console.log(`Installing worktree plugin ${WORKTREE_PLUGIN}`);
    // Never hide a missing worktree build by downloading a released plugin.
    await runChecked(
      process.execPath,
      [DIST, '--install-bundled-plugin', '--plugin-path', WORKTREE_PLUGIN],
      process.env,
    );
  }

  let studioSession;
  const results = [];
  let cleanupFailed = false;
  try {
    studioSession = await openManagedStudioSession({
      port: suitePort,
      existingInstanceId: process.env.MCP_INSTANCE_ID,
    });
    process.env.MCP_INSTANCE_ID = studioSession.instanceId;
    console.log(
      studioSession.managed
        ? `Launched managed Studio instance ${studioSession.instanceId}`
        : `Using supplied Studio instance ${studioSession.instanceId}`,
    );
    for (let i = 0; i < TESTS.length; i++) {
      if (i > 0) await delay(INTER_TEST_DELAY_MS);
      const r = await runOne(TESTS[i]);
      results.push(r);
    }
  } finally {
    if (studioSession) {
      try {
        await studioSession.close();
        if (studioSession.managed) console.log(`Closed managed Studio instance ${studioSession.instanceId}`);
      } catch (error) {
        cleanupFailed = true;
        console.error(`Failed to close managed Studio instance ${studioSession.instanceId}: ${error.message}`);
      }
    }
    if (worker) {
      await delay(1000);
      try {
        worker.cleanup();
      } catch (error) {
        cleanupFailed = true;
        console.error(`Failed to remove isolated Studio worker ${worker.workingDirectory}: ${error.message}`);
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
