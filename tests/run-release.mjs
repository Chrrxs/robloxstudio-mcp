#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectReleaseEnvironment,
  createReleaseRecord,
  describeReleaseArtifacts,
  RELEASE_ARTIFACTS_DIRECTORY,
  RELEASE_OUTPUT_ENV,
  RELEASE_RECORD_FILE,
} from '../scripts/release-record.mjs';
import { resolveStudioExe } from '../scripts/studio-lifecycle.mjs';
import { runSequentialSuite } from './lib/sequential-suite.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STAGES = [
  { name: 'auto-install + functional', args: ['tests/run-with-test-port.mjs', 'tests/auto-install-plugin-e2e.mjs', '--with-functional'] },
  { name: 'WSL process identity', args: ['tests/run-with-test-port.mjs', 'tests/wsl-process-identity-launch.mjs'] },
  { name: 'lifecycle regressions', args: ['tests/run-with-test-port.mjs', 'tests/studio-lifecycle-regressions.mjs'] },
  { name: 'parallel Studio isolation', args: ['tests/parallel-studio-isolation-smoke.mjs'] },
];

export function executeReleaseStage(command, args, { cwd, env, signal, spawnImpl = spawn }) {
  const { promise, resolve: settle } = Promise.withResolvers();
  try {
    const child = spawnImpl(command, args, { cwd, env, signal, stdio: 'inherit' });
    let spawnError;
    // Close waits for this child's stdio closure, not descendant/Studio cleanup.
    // The outer native job containment remains responsible for those processes.
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, exitSignal) => settle({ code, signal: exitSignal, spawnError }));
  } catch (spawnError) {
    settle({ code: null, spawnError });
  }
  return promise;
}

// With an output directory (set by the profile harness for managed release
// runs), the gate writes release-record.json there whether it passes or fails;
// the auto-install stage copies the tarballs it tested into artifacts/.
export async function runRelease({
  execute = executeReleaseStage,
  env = process.env,
  signal,
  log = console.log,
  outputDirectory = env[RELEASE_OUTPUT_ENV],
  collectEnvironment = () => collectReleaseEnvironment({ env, resolveStudioExecutable: resolveStudioExe }),
  now = () => new Date(),
} = {}) {
  let stageEnv = env;
  let environment;
  if (outputDirectory) {
    rmSync(join(outputDirectory, RELEASE_RECORD_FILE), { force: true });
    rmSync(join(outputDirectory, RELEASE_ARTIFACTS_DIRECTORY), { recursive: true, force: true });
    mkdirSync(join(outputDirectory, RELEASE_ARTIFACTS_DIRECTORY), { recursive: true });
    if (env[RELEASE_OUTPUT_ENV] !== outputDirectory) stageEnv = { ...env, [RELEASE_OUTPUT_ENV]: outputDirectory };
    environment = collectEnvironment();
  }
  const { results, skipped } = await runSequentialSuite(STAGES, {
    betweenTests: () => {},
    run: async (stage) => {
      if (signal?.aborted) throw signal.reason ?? new Error('Release gate interrupted');
      log(`\n=== ${stage.name} ===`);
      const result = await execute(process.execPath, stage.args, { cwd: REPO_ROOT, env: stageEnv, signal });
      if (result.spawnError) throw result.spawnError;
      if (result.signal) throw new Error(`Terminated by ${result.signal}`);
      if (signal?.aborted) throw signal.reason ?? new Error('Release gate interrupted');
      return result.code ?? 1;
    },
  });
  log('\n========== RELEASE SUMMARY ==========');
  for (const result of results) {
    log(`  ${result.code === 0 ? 'PASS' : 'FAIL'}  ${result.file.name}${result.error ? `: ${result.error.message ?? result.error}` : ''}`);
  }
  for (const stage of skipped) log(`  NOT RUN  ${stage.name} (release gate stopped after failure)`);
  let code = results.length === STAGES.length && results.every((result) => result.code === 0) ? 0 : 1;
  let record;
  if (outputDirectory) {
    try {
      let artifacts = [];
      let artifactsError;
      try {
        artifacts = describeReleaseArtifacts(join(outputDirectory, RELEASE_ARTIFACTS_DIRECTORY));
      } catch (error) {
        artifactsError = error instanceof Error ? error.message : String(error);
      }
      if (code === 0 && !artifactsError && artifacts.length === 0) artifactsError = 'The release gate exported no tested tarballs.';
      record = createReleaseRecord({ results, skipped, artifacts, artifactsError, environment, createdAt: now().toISOString() });
      writeFileSync(join(outputDirectory, RELEASE_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
      log(`  Release record: ${record.result} (${artifacts.length} tarballs)`);
      if (record.result !== 'passed') code = 1;
    } catch (error) {
      log(`  Release record could not be written: ${error instanceof Error ? error.message : String(error)}`);
      code = 1;
    }
  }
  return { code, results, skipped, record };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const controller = new AbortController();
  const handlers = new Map(['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? [] : ['SIGHUP'])].map((signal) => [
    signal,
    () => controller.abort(new Error(`Release gate received ${signal}`)),
  ]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    process.exitCode = (await runRelease({ signal: controller.signal })).code;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}
