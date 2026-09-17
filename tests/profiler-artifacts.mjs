import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { finishProfilerArtifacts, writeProfilerCaptureSummary } from './lib/profiler-artifacts.mjs';

const directory = mkdtempSync(path.join(os.tmpdir(), 'rsmcp-profiler-artifacts-'));
try {
  const rawPath = path.join(directory, 'capture.mp');
  const bytes = Buffer.from([0, 1, 127, 255]);
  const summary = { capture: { ok: true, counts: { events_sampled: 0 } }, probes: [] };
  writeFileSync(rawPath, bytes);
  writeProfilerCaptureSummary(directory, summary);
  const messages = [];
  await finishProfilerArtifacts(directory, true, message => messages.push(message));
  assert.deepEqual(readFileSync(rawPath), bytes);
  assert.deepEqual(JSON.parse(readFileSync(path.join(directory, 'capture-summary.json'), 'utf8')), summary);
  assert.deepEqual(messages, [`Retained profiler failure artifacts: ${directory}`]);

  await finishProfilerArtifacts(directory, false, () => assert.fail('Successful cleanup must not report retained artifacts'));
  assert.equal(existsSync(directory), false);
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log('Profiler failure artifact retention passed (no Studio launched).');
