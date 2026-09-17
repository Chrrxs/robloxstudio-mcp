#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

export async function runRelease({ execute = executeReleaseStage, env = process.env, signal, log = console.log } = {}) {
  const { results, skipped } = await runSequentialSuite(STAGES, {
    betweenTests: () => {},
    run: async (stage) => {
      if (signal?.aborted) throw signal.reason ?? new Error('Release gate interrupted');
      log(`\n=== ${stage.name} ===`);
      const result = await execute(process.execPath, stage.args, { cwd: REPO_ROOT, env, signal });
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
  const code = results.length === STAGES.length && results.every((result) => result.code === 0) ? 0 : 1;
  return { code, results, skipped };
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
