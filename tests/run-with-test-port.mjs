#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireSuitePort } from './lib/test-port.mjs';

const [script, ...args] = process.argv.slice(2);
if (!script) {
  console.error('Usage: node tests/run-with-test-port.mjs <script> [...args]');
  process.exit(2);
}

const portLease = await acquireSuitePort();
const env = {
  ...process.env,
  ROBLOX_STUDIO_PORT: String(portLease.port),
};
if (portLease.autoAssigned) {
  env.RSMCP_AUTO_ASSIGNED_PORT = '1';
  env.ROBLOX_STUDIO_REQUIRE_PRIMARY = '1';
}
console.log(
  `Test process using port ${portLease.port}` +
  (portLease.autoAssigned ? ' (automatically assigned)' : ' (from ROBLOX_STUDIO_PORT)'),
);

await portLease.handoff();
try {
  const child = spawn(process.execPath, [script, ...args], {
    env,
    stdio: 'inherit',
  });
  const [code, signal] = await once(child, 'exit');
  if (signal) {
    console.error(`Test process exited from signal ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
} finally {
  await portLease.release();
}
