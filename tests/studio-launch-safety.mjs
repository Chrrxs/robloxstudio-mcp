#!/usr/bin/env node
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchStudio } from '../scripts/studio-lifecycle.mjs';
import { withStudioTestRun } from '../scripts/studio-test-safety.mjs';

for (const outcome of ['spawned', 'spawn-error', 'missing-executable']) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rsmcp-direct-launch-fixture-'));
  const env = { RSMCP_STUDIO_TEST_SAFETY_DIR: root };
  let spawnCalls = 0;
  let unrefCalls = 0;
  let checks = 0;
  const adapters = {
    assertProfile() { checks++; },
    assertIsolation() { checks++; },
    resolveExecutable() {
      if (outcome === 'missing-executable') throw new Error('fixture executable unavailable');
      return 'fixture-Studio';
    },
    spawnProcess(executable, args, options) {
      spawnCalls++;
      assert.equal(executable, 'fixture-Studio');
      assert.deepEqual(args, ['fixture-place']);
      assert.equal(options.env, env);
      assert.equal(options.cwd, root);
      const child = new EventEmitter();
      child.pid = 123;
      child.unref = () => { unrefCalls++; };
      queueMicrotask(() => child.emit(outcome === 'spawn-error' ? 'error' : 'spawn', new Error('fixture spawn failure')));
      return child;
    },
  };
  try {
    const status = await withStudioTestRun(env, async () => {
      if (outcome === 'spawned') {
        const launched = await launchStudio(['fixture-place'], { workingDirectory: root, env }, adapters);
        assert.deepEqual(launched, { pid: 123, exe: 'fixture-Studio', args: ['fixture-place'], workingDirectory: root });
        return 0;
      }
      await assert.rejects(launchStudio(['fixture-place'], { workingDirectory: root, env }, adapters), /fixture/);
      const attempts = spawnCalls;
      await assert.rejects(launchStudio(['fixture-place'], { workingDirectory: root, env }, adapters));
      assert.equal(spawnCalls, attempts, 'a failed launch must prevent a replacement spawn');
      return 1;
    });
    assert.equal(status, outcome === 'spawned' ? 0 : 1);
    assert.equal(spawnCalls, outcome === 'missing-executable' ? 0 : 1);
    assert.equal(unrefCalls, outcome === 'spawned' ? 1 : 0);
    assert.equal(checks, outcome === 'spawned' ? 2 : 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
{
  const root = mkdtempSync(path.join(os.tmpdir(), 'rsmcp-direct-owned-fixture-'));
  const env = {
    RSMCP_STUDIO_TEST_SAFETY_DIR: root,
    RSMCP_STUDIO_TEST_WORKER_JOB: 'Local\\RsmcpStudioWorker-0123456789abcdef0123456789abcdef',
  };
  const entered = Promise.withResolvers();
  const assigned = Promise.withResolvers();
  try {
    await withStudioTestRun(env, async () => {
      let returned = false;
      const launch = launchStudio([], { workingDirectory: root, env }, {
        assertProfile() {},
        assertIsolation() {},
        resolveExecutable() { return 'fixture-Studio'; },
        spawnProcess() { assert.fail('WTI launch must never use uncontained direct spawn'); },
        async launchOwnedProcess(_exe, _args, cwd, options) {
          assert.equal(cwd, root);
          assert.equal(options.env.RSMCP_STUDIO_TEST_WORKER_JOB, env.RSMCP_STUDIO_TEST_WORKER_JOB);
          entered.resolve();
          await assigned.promise;
          return 321;
        },
      }).then(value => { returned = true; return value; });
      await entered.promise;
      assert.equal(returned, false, 'Direct launch must wait for suspended process assignment');
      assigned.resolve();
      assert.equal((await launch).pid, 321);
      return 0;
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

await assert.rejects(launchStudio([], { env: {} }, {
  assertProfile() {},
  assertIsolation() {},
  resolveExecutable() { assert.fail('unguarded launch must not resolve an executable'); },
  spawnProcess() { assert.fail('unguarded launch must not spawn'); },
}), /guarded dedicated-profile runner/);
console.log('Direct Studio launch safety fixture passed (no Studio processes launched).');
