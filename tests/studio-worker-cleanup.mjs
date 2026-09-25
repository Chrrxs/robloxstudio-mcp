#!/usr/bin/env node
// Offline only: no Studio, profile operations, native commands, or real timers.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mock } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStudioWorkerCleanup } from '../scripts/studio-lifecycle.mjs';
import { requireStudioWorkerCapability, createAutoInstallCleanupError } from './auto-install-plugin-e2e.mjs';
import { createStudioWorkerJob } from '../scripts/studio-worker-job.mjs';

// A rejected native drain must close its broker, not leave the broker waiting
// for stdin or permit a later cleanup call to start another ten-minute grace.
for (const scenario of [
  { response: { error: 'Owned Studio installer did not finish within worker grace' }, error: /installer did not finish/ },
  { response: { error: 'Owned Studio installer did not finish' }, exitCode: 1, error: /installer did not finish.*broker shutdown failed.*broker exited 1/ },
  { requestTimeout: true, error: /Timed out waiting for Studio worker broker/ },
  { response: { drained: false }, error: /drain was not confirmed/ },
  { response: { drained: true } },
]) {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      ref() {}, unref() {},
    });
    let drainRequests = 0;
    let closed = false;
    child.stdin.on('data', chunk => {
      const request = JSON.parse(chunk.toString());
      if (request.op === 'drain') drainRequests++;
      if (request.op === 'drain' && scenario.requestTimeout) return;
      const response = request.op === 'drain'
        ? scenario.response
        : { ready: true, name: request.name };
      queueMicrotask(() => child.stdout.write(`${JSON.stringify(response)}\n`));
    });
    child.stdin.on('finish', () => {
      closed = true;
      child.emit('close', scenario.exitCode ?? 0);
    });
    const job = await createStudioWorkerJob({
      env: {}, cwd: '.', toWindowsPath: value => value, spawnProcess: () => child,
    });
    const result = job.drain();
    assert.equal(job.drain(), result, 'concurrent cleanup must share the same drain');
    if (scenario.requestTimeout) mock.timers.tick(645000);
    if (scenario.error) {
      let failure;
      await assert.rejects(result, error => {
        failure = error;
        return scenario.error.test(error.message);
      });
      await assert.rejects(job.drain(), error => error === failure);
    } else {
      await result;
      await job.drain();
    }
    assert.equal(closed, true, 'drain must await broker exit on success and failure');
    assert.equal(drainRequests, 1, 'a terminal drain result must not restart installer grace');
  } finally {
    mock.timers.reset();
  }
}

const workerDirectory = 'C:\\fixture\\robloxstudio-mcp-workers\\auto-install-e2e-worker';
const lockedFile = `${workerDirectory}\\managed-instances\\instance.json`;
const removalError = Object.assign(new Error('Worker file remains locked'), {
  code: 'EPERM', syscall: 'unlink', path: lockedFile,
});
const expectedOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };

for (const status of [{}, { test_worker_job_name: 'another-worker' }]) {
  const actions = [];
  await assert.rejects(requireStudioWorkerCapability({
    async callTool(name, args) { actions.push([name, args.action]); return status; },
  }, 'Local\\RsmcpStudioWorker-0123456789abcdef0123456789abcdef'), /cannot guarantee the requested worker-job containment/);
  assert.deepEqual(actions, [['manage_instance', 'status']], 'Unsupported or mismatched artifacts must fail before launch');
}

{
  let attempts = 0;
  const cleanup = createStudioWorkerCleanup(workerDirectory, {
    async drain() {},
    removeDirectory(directory, options) {
      assert.equal(directory, workerDirectory);
      assert.deepEqual(options, expectedOptions);
      attempts += 1;
      if (attempts === 1) throw removalError;
    },
  });
  await assert.rejects(cleanup, error => error === removalError);
  await cleanup();
  assert.equal(attempts, 2, 'A failed cleanup must allow a later explicit attempt');
  await cleanup();
  assert.equal(attempts, 2, 'Successful cleanup must be idempotent');
}

{
  let attempts = 0;
  const cleanup = createStudioWorkerCleanup(workerDirectory, {
    async drain() {},
    removeDirectory(directory, options) {
      assert.equal(directory, workerDirectory);
      assert.deepEqual(options, expectedOptions);
      attempts += 1;
      throw removalError;
    },
  });
  await assert.rejects(cleanup, error => error === removalError);
  await assert.rejects(cleanup, error => error === removalError);
  assert.equal(attempts, 2, 'Persistent removal failure must remain fatal and retryable');
}

{
  const events = [];
  const gate = Promise.withResolvers();
  const cleanup = createStudioWorkerCleanup(workerDirectory, {
    async drain() { events.push('draining'); await gate.promise; events.push('empty'); },
    removeDirectory() { events.push('removed'); },
  });
  const first = cleanup();
  const concurrent = cleanup();
  assert.deepEqual(events, ['draining'], 'No deletion is allowed before the owned job is empty');
  gate.resolve();
  await Promise.all([first, concurrent]);
  assert.deepEqual(events, ['draining', 'empty', 'removed'], 'Concurrent cleanup must share one drain and deletion');
}

{
  const removing = Promise.withResolvers();
  const finishRemoval = Promise.withResolvers();
  let completed = false;
  const cleanup = createStudioWorkerCleanup(workerDirectory, {
    async drain() {},
    async removeDirectory() { removing.resolve(); await finishRemoval.promise; },
  });
  const pending = cleanup().then(() => { completed = true; });
  await removing.promise;
  await Promise.resolve();
  assert.equal(completed, false, 'Cleanup cannot report success while asynchronous removal is pending');
  finishRemoval.resolve();
  await pending;
  assert.equal(completed, true);
}

{
  const failure = new Error('Unknown worker membership');
  let removals = 0;
  const cleanup = createStudioWorkerCleanup(workerDirectory, {
    async drain() { throw failure; },
    removeDirectory() { removals++; },
  });
  await assert.rejects(cleanup, error => error === failure);
  assert.equal(removals, 0, 'Unknown ownership must retain the worker and registry');
  assert.throws(() => createStudioWorkerCleanup(workerDirectory), /retained job ownership/);
}

{
  const nestedError = new AggregateError(
    [new Error('Managed cleanup failed', { cause: removalError })],
    'Owned worker cleanup failed',
  );
  for (const bodyError of [undefined, new Error('Installer case failed')]) {
    const aggregate = createAutoInstallCleanupError([nestedError], bodyError);
    assert.ok(aggregate instanceof AggregateError);
    assert.deepEqual(aggregate.errors, bodyError ? [bodyError, nestedError] : [nestedError]);
    assert.equal(aggregate.cause, bodyError ?? nestedError);
    if (bodyError) assert.ok(aggregate.stack.includes(bodyError.message), 'Original scenario failure must remain visible alongside cleanup errors');
    // The executable logs error.stack; nested filesystem details must survive there.
    assert.ok(aggregate.stack.includes(removalError.message));
    assert.ok(aggregate.stack.includes('EPERM'));
    assert.ok(aggregate.stack.includes('unlink'));
    assert.ok(aggregate.stack.includes('instance.json'));
    assert.ok(aggregate.stack.includes('auto-install-e2e-worker'));
  }
}

const root = mkdtempSync(path.join(tmpdir(), 'studio-worker-cleanup-'));
try {
  const worker = path.join(root, 'worker');
  const registry = path.join(worker, 'managed-instances');
  const sibling = path.join(root, 'unrelated-worker');
  mkdirSync(registry, { recursive: true });
  mkdirSync(sibling);
  writeFileSync(path.join(registry, 'instance.json'), '{}');
  const cleanup = createStudioWorkerCleanup(worker, { async drain() {} });
  await cleanup();
  assert.equal(existsSync(worker), false, 'Cleanup must remove the worker recursively');
  assert.equal(existsSync(sibling), true, 'Cleanup must leave other workers untouched');
  await cleanup();
  assert.equal(existsSync(sibling), true);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('Studio worker cleanup offline regressions passed');
