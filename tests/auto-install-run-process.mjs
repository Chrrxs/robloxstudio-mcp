#!/usr/bin/env node

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { runChecked, runProcess } from './auto-install-plugin-e2e.mjs';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

{
  const child = fakeChild();
  const spawnError = Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' });
  let spawnCommand;
  let spawnArgs;
  let spawnOptions;
  const resultPromise = runProcess('npm', ['run', 'build'], {
    platform: 'win32',
    spawnImpl(command, args, options) {
      spawnCommand = command;
      spawnArgs = args;
      spawnOptions = options;
      queueMicrotask(() => child.emit('error', spawnError));
      return child;
    },
  });

  // Keep the red-case process alive long enough to prove runProcess itself
  // settles the Promise rather than relying on an unhandled EventEmitter error.
  child.on('error', () => {});
  const timedOut = Symbol('timed-out');
  const result = await Promise.race([
    resultPromise,
    delay(50, timedOut, { ref: false }),
  ]);

  assert.notEqual(result, timedOut, 'a pre-exit spawn error settles runProcess promptly');
  assert.equal(result.code, null);
  assert.equal(result.spawnError, spawnError);
  assert.equal(result.killed, false);
  assert.equal(spawnCommand, process.execPath, 'npm runs through its Node CLI on Windows');
  assert.match(spawnArgs[0], /npm-cli\.js$/, 'the Windows npm shim is bypassed');
  assert.equal(spawnOptions.shell, undefined, 'Windows npm does not use cmd.exe');
}

{
  const startedAt = Date.now();
  const result = await runProcess(
    path.join(os.tmpdir(), `rsmcp-command-that-does-not-exist-${process.pid}`),
    [],
    { timeoutMs: 2000 },
  );
  assert.equal(result.code, null);
  assert.equal(result.spawnError?.code, 'ENOENT');
  assert(
    Date.now() - startedAt < 1000,
    'a real pre-exit spawn failure surfaces well before the process timeout',
  );
}
{
  await assert.rejects(
    runChecked(
      path.join(os.tmpdir(), `rsmcp-command-that-does-not-exist-checked-${process.pid}`),
      [],
      { timeoutMs: 2000 },
    ),
    (error) => error?.cause?.code === 'ENOENT' && /could not be started/.test(error.message),
  );
}

{
  const result = await runProcess('npm', ['--version'], {
    platform: 'win32',
    timeoutMs: 5000,
  });
  assert.equal(result.spawnError, undefined);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
}

{
  const child = fakeChild();
  const resultPromise = runProcess(process.execPath, ['ignored'], {
    spawnImpl() {
      queueMicrotask(() => {
        child.stdout.write('before-');
        child.emit('exit', 0, null);
        setTimeout(() => {
          child.stdout.end('close');
          child.stderr.end();
          child.emit('close', 0, null);
        }, 10);
      });
      return child;
    },
  });
  const result = await resultPromise;
  assert.equal(result.stdout, 'before-close', 'runProcess drains stdout through close');
}

{
  const child = fakeChild();
  child.pid = 4242;
  const startedAt = Date.now();
  let terminated;
  const resultPromise = runProcess(process.execPath, ['ignored'], {
    platform: 'win32',
    timeoutMs: 5,
    spawnImpl() {
      return child;
    },
    async terminateProcessTreeImpl(proc, platform, signal) {
      terminated = { proc, platform, signal };
      child.stdout.end();
      child.stderr.end();
      child.emit('close', null, 'SIGKILL');
      await delay(20);
    },
  });
  const result = await resultPromise;
  assert.equal(terminated.proc, child);
  assert.equal(terminated.platform, 'win32');
  assert.equal(terminated.signal, 'SIGTERM');
  assert.equal(result.killed, true);
  assert(Date.now() - startedAt >= 20, 'timeout waits for process-tree termination');
}

{
  const childSource = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    'console.log(child.pid);',
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const result = await runProcess(process.execPath, ['-e', childSource], {
    timeoutMs: 500,
  });
  assert.equal(result.killed, true);
  const descendantPid = Number(result.stdout.trim());
  assert(Number.isInteger(descendantPid), `expected descendant pid, got ${result.stdout}`);
  await delay(50);
  assert.throws(
    () => process.kill(descendantPid, 0),
    (error) => error?.code === 'ESRCH',
    'timeout terminates the subprocess descendant tree',
  );
}

{
  const jobs = Array.from({ length: 8 }, (_, index) => runProcess(
    process.execPath,
    ['-e', `process.stdout.write(${JSON.stringify(`parallel-${index}`)})`],
    { timeoutMs: 5000 },
  ));
  const results = await Promise.all(jobs);
  results.forEach((result, index) => {
    assert.equal(result.code, 0);
    assert.equal(result.spawnError, undefined);
    assert.equal(result.stdout, `parallel-${index}`);
    assert.equal(result.stderr, '');
    assert.equal(result.killed, false);
  });
}

console.log('auto-install subprocess runner passed');
