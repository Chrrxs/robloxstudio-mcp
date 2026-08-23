#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireStudioTestLease } from './lib/studio-test-lease.mjs';

const leaseRoot = mkdtempSync(path.join(os.tmpdir(), 'rsmcp-studio-lease-test-'));
const name = `unit-${process.pid}-${randomUUID()}`;
const pluginsDir = path.join(leaseRoot, 'Plugins');
const protectedPlugin = path.join(pluginsDir, 'MCPPlugin.rbxmx');
const reproPlugin = path.join(pluginsDir, '000_RSMCP_EditHistoryRepro.rbxmx');
mkdirSync(pluginsDir);
writeFileSync(protectedPlugin, 'original plugin');

try {
  const first = await acquireStudioTestLease({
    name,
    leaseRoot,
    pluginsDir,
    timeoutMs: 1000,
    pollMs: 10,
    staleMs: 5000,
  });
  let secondResolved = false;
  const secondPromise = acquireStudioTestLease({
    name,
    leaseRoot,
    pluginsDir,
    timeoutMs: 1000,
    pollMs: 10,
    staleMs: 5000,
  }).then((lease) => {
    secondResolved = true;
    return lease;
  });

  await delay(30);
  assert.equal(secondResolved, false, 'a parallel worktree cannot enter the shared Studio/plugin section');
  await first.release();

  const timeout = Symbol('timeout');
  const second = await Promise.race([secondPromise, delay(500, timeout, { ref: false })]);
  assert.notEqual(second, timeout, 'the waiting worktree proceeds after the owner restores shared state');
  assert.equal(second.waited, true);
  await second.release();
  await second.release();

  const third = await acquireStudioTestLease({
    name,
    leaseRoot,
    pluginsDir,
    timeoutMs: 1000,
    pollMs: 10,
    staleMs: 5000,
  });
  assert.equal(third.waited, false, 'release supports immediate reuse');
  await third.release();

  const staleName = `stale-${process.pid}-${randomUUID()}`;
  const childScript = path.join(leaseRoot, 'abandon-lease.mjs');
  const leaseModuleUrl = new URL('./lib/studio-test-lease.mjs', import.meta.url).href;
  writeFileSync(
    childScript,
    `import { acquireStudioTestLease } from ${JSON.stringify(leaseModuleUrl)};\n` +
    `const lease = await acquireStudioTestLease({ ` +
      `name: ${JSON.stringify(staleName)}, ` +
      `leaseRoot: ${JSON.stringify(leaseRoot)}, ` +
      `pluginsDir: ${JSON.stringify(pluginsDir)}, ` +
      `timeoutMs: 1000, pollMs: 10, staleMs: 5000 ` +
    `});\n` +
    `import { writeFileSync } from "node:fs";\n` +
    `writeFileSync(${JSON.stringify(protectedPlugin)}, "interrupted plugin");\n` +
    `writeFileSync(${JSON.stringify(reproPlugin)}, "interrupted repro plugin");\n` +
    `process.kill(process.pid, "SIGKILL");\n`,
    'utf8',
  );
  const child = spawn(process.execPath, [childScript], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [code, signal] = await once(child, 'exit');
  assert(code !== 0 || signal, 'fixture process is killed while intentionally abandoning its lease');

  const recovered = await acquireStudioTestLease({
    name: staleName,
    leaseRoot,
    pluginsDir,
    timeoutMs: 7000,
    pollMs: 25,
    staleMs: 5000,
  });
  assert.equal(recovered.waited, true, 'a later worktree recovers a lease abandoned by a dead process');
  assert.equal(
    readFileSync(protectedPlugin, 'utf8'),
    'original plugin',
    'stale takeover restores the interrupted owner’s durable plugin backup',
  );
  assert.equal(
    existsSync(reproPlugin),
    false,
    'stale takeover removes a repro plugin that was absent before the interrupted run',
  );
  await recovered.release();
} finally {
  rmSync(leaseRoot, { recursive: true, force: true });
}

console.log('Studio test lease passed');
