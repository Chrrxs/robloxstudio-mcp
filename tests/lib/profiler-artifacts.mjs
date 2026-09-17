import { writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';

export function writeProfilerCaptureSummary(directory, summary) {
  writeFileSync(path.join(directory, 'capture-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}

export async function finishProfilerArtifacts(directory, failed, log = console.error) {
  if (failed) {
    log(`Retained profiler failure artifacts: ${directory}`);
    return;
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
