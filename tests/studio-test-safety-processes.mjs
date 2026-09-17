#!/usr/bin/env node
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createStudioTestSafety, STUDIO_TEST_LAUNCH_COST_LIMIT as LIMIT,
  STUDIO_TEST_LAUNCH_WINDOW_MS as WINDOW,
} from '../scripts/studio-test-safety.mjs';

if (process.argv[2] === '--hold-fixture-run') {
  const safety = createStudioTestSafety({ root: process.argv[3] });
  // Keep only this fixture Node process alive until the parent terminates it.
  process.on('message', () => {});
  await safety.withStudioTestRun(async () => {
    await safety.withStudioTestLaunch(1, async () => {
      process.send({ event: 'reserved' });
      await Promise.withResolvers().promise;
      return { success: true };
    });
    return 0;
  });
} else {
  const root = mkdtempSync(join(tmpdir(), 'studio-safety-processes-'));
  const child = fork(fileURLToPath(import.meta.url), ['--hold-fixture-run', root], {
    execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const blocked = (category) => (error) => error?.category === category;
  const never = () => assert.fail('unsafe replacement launch dispatched');
  try {
    const ready = Promise.withResolvers();
    const onMessage = (message) => message?.event === 'reserved'
      ? ready.resolve() : ready.reject(new Error('Unexpected fixture child message'));
    const onError = (error) => ready.reject(error);
    const onExit = () => ready.reject(new Error('Fixture child exited before reservation'));
    child.once('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
    try { await ready.promise; } finally {
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
    }
    const safety = createStudioTestSafety({ root, sleep: () => assert.fail('fixture must not wait on real time') });
    await assert.rejects(safety.withStudioTestRun(never), blocked('run_active'));
    const before = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
    assert.equal(before.reservations.length, 1);
    assert.notEqual(before.run, null);
    assert.notEqual(before.pending, null);

    const exited = once(child, 'exit');
    assert.equal(child.kill('SIGKILL'), true);
    await exited;
    // Age only this dead child's fixture leases instead of sleeping for stale
    // detection. The real persisted running/pending state must survive recovery.
    const staleTime = new Date(Date.now() - 10 * 60 * 1000);
    for (const name of ['run.lock', 'launch.lock']) {
      utimesSync(join(root, name), staleTime, staleTime);
    }
    await assert.rejects(safety.withStudioTestRun(never), blocked('abandoned_run'));
    await assert.rejects(safety.withStudioTestLaunch(1, never), blocked('abandoned_run'));
    await safety.resetStudioTestSafety('Fixture child was terminated and its state inspected');
    const after = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
    assert.deepEqual(after.reservations, before.reservations, 'reset never refunds an indeterminate launch');
    let time = after.observedAt;
    const waits = [];
    const recovered = createStudioTestSafety({
      root, now: () => time, onCapacityWait: () => {},
      sleep: async (ms) => { waits.push(ms); time += ms; },
    });
    let calls = 0;
    await recovered.withStudioTestLaunch(LIMIT, () => {
      calls += 1;
      assert.equal(time, before.reservations[0].at + WINDOW);
      return { success: true };
    });
    assert.deepEqual(waits, [before.reservations[0].at + WINDOW - after.observedAt]);
    assert.equal(calls, 1, 'recovered launch waits for the interrupted reservation without retrying');
    console.log('Cross-process Studio safety fixture passed (only fixture Node processes used).');
  } finally {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
}
