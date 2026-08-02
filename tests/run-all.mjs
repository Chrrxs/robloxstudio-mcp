#!/usr/bin/env node
// Runs each integration test as its own Node subprocess and summarizes
// results. Sequential (not parallel) to avoid playtest-state interference
// between tests — each one starts + stops its own playtest.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TESTS = [
  'path-resolution.mjs',
  'property-value-conversion.mjs',
  'eval-bridge-error-preservation.mjs',
  'eval-context-routing.mjs',
  'runtime-bridge-lifecycle.mjs',
  'execute-luau-error-preservation.mjs',
  'proxy-mode-peer-fanout.mjs',
  'execute-luau-output-capture.mjs',
  'simulation-state-lifecycle.mjs',
  'multiplayer-add-player-end-regression.mjs',
  'multiplayer-test-lifecycle.mjs',
];

// Studio takes a few seconds to fully tear down a play DM after StudioTestService:EndTest.
// Without a gap, the next test's solo_playtest start collides with the previous test's
// in-flight cleanup and either times out or sees a stale 1-peer state.
const INTER_TEST_DELAY_MS = 1000;

function runOne(file) {
  return new Promise((res) => {
    const proc = spawn('node', [resolve(__dirname, file)], { stdio: 'inherit' });
    proc.on('exit', (code) => res({ file, code: code ?? 1 }));
  });
}

const results = [];
for (let i = 0; i < TESTS.length; i++) {
  if (i > 0) await delay(INTER_TEST_DELAY_MS);
  const r = await runOne(TESTS[i]);
  results.push(r);
}

console.log('\n========== SUMMARY ==========');
for (const r of results) {
  console.log(`  ${r.code === 0 ? '✅ PASS' : '❌ FAIL'}  ${r.file}`);
}
const failed = results.filter((r) => r.code !== 0).length;
console.log(`\n${results.length - failed}/${results.length} passed.`);
process.exit(failed === 0 ? 0 : 1);
