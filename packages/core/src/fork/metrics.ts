// One JSON line per tool call, appended to MCP_METRICS_FILE. Never stdout:
// stdout carries MCP protocol messages only.
import { createWriteStream, type WriteStream } from 'node:fs';
import type { ImageInfo } from './image-budget.js';

export interface MetricsLine {
  ts: string;
  tool: string;
  profile: string;
  bytes: number;
  images: ImageInfo[];
  ms: number;
  truncated: boolean;
  error: boolean;
}

const streams = new Map<string, WriteStream>();

function streamFor(file: string): WriteStream {
  let stream = streams.get(file);
  if (!stream) {
    stream = createWriteStream(file, { flags: 'a' });
    stream.on('error', (error) => {
      console.error(`[metrics] cannot write ${file}: ${error.message}`);
      streams.delete(file);
    });
    streams.set(file, stream);
  }
  return stream;
}

export function recordMetrics(file: string | undefined, line: MetricsLine): void {
  if (!file) return;
  streamFor(file).write(`${JSON.stringify(line)}\n`);
}

/** Flushes and closes every metrics file (tests and shutdown). */
export async function closeMetrics(): Promise<void> {
  const open = [...streams.values()];
  streams.clear();
  await Promise.all(open.map((stream) => new Promise<void>((resolve) => stream.end(resolve))));
}
