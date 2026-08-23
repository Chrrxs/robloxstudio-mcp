#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wrapper = path.join(repoRoot, 'tests', 'run-with-test-port.mjs');
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-test-port-wrapper-'));
const captureScript = path.join(tempRoot, 'capture-port.mjs');

writeFileSync(captureScript, `
import { writeFileSync } from 'node:fs';

writeFileSync(process.argv[2], JSON.stringify({
  port: Number(process.env.ROBLOX_STUDIO_PORT),
  autoAssigned: process.env.RSMCP_AUTO_ASSIGNED_PORT,
  requirePrimary: process.env.ROBLOX_STUDIO_REQUIRE_PRIMARY,
}));
`, 'utf8');

async function runSuite(label) {
  const capturePath = path.join(tempRoot, `${label}.json`);
  const env = { ...process.env };
  delete env.ROBLOX_STUDIO_PORT;
  delete env.RSMCP_AUTO_ASSIGNED_PORT;
  delete env.ROBLOX_STUDIO_REQUIRE_PRIMARY;

  const child = spawn(
    process.execPath,
    [wrapper, captureScript, capturePath],
    {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  return {
    code,
    stdout,
    stderr,
    capture: JSON.parse(readFileSync(capturePath, 'utf8')),
  };
}

try {
  const [first, second] = await Promise.all([runSuite('first'), runSuite('second')]);
  for (const result of [first, second]) {
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.ok(
      Number.isInteger(result.capture.port) && result.capture.port > 0,
      'wrapper assigned a valid port',
    );
    assert.notEqual(result.capture.port, 58741, 'automatic allocation skips the default plugin port');
    assert.equal(result.capture.autoAssigned, '1', 'child knows its port was automatically assigned');
    assert.equal(result.capture.requirePrimary, '1', 'first server must fail closed instead of proxying');
  }
  assert.notEqual(
    first.capture.port,
    second.capture.port,
    'parallel wrapper invocations use distinct ports',
  );
  console.log('test port wrapper isolation passed');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
