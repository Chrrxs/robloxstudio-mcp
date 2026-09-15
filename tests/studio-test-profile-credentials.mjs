#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { windowsPowerShellEnvironment } from '../scripts/studio-lifecycle.mjs';

if (process.platform === 'win32') {
  const output = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('./studio-test-profile-credentials.ps1', import.meta.url)),
  ], {
    encoding: 'utf8',
    env: windowsPowerShellEnvironment(process.env),
    timeout: 30_000,
  });
  assert.match(output, /Studio credential vault and unattended mode fixtures passed/);
  console.log(output.trim());
} else {
  console.log('Studio credential vault fixtures skipped: native Windows Node required');
}
