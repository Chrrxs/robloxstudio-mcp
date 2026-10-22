// The one place every tool result passes on its way out: response cap, image
// cap and metrics.
import type { CallToolResult } from '@modelcontextprotocol/server';
import { shrinkImageBlocks } from './image-budget.js';
import { capFor, forkLimits, type ForkLimits } from './limits.js';
import { recordMetrics } from './metrics.js';
import { narrowHint } from './narrow-hints.js';
import { capResult } from './output-budget.js';

export function finishToolResult(
  tool: string,
  result: CallToolResult,
  era: string,
  startedAt: number,
  limits: ForkLimits = forkLimits(),
): CallToolResult {
  const shrunk = shrinkImageBlocks(result.content, limits.imageMaxPx);
  const capped = capResult({ ...result, content: shrunk.content }, era, capFor(limits, tool), narrowHint(tool));
  recordMetrics(limits.metricsFile, {
    ts: new Date().toISOString(),
    tool,
    profile: limits.profile,
    bytes: capped.bytes,
    images: shrunk.images,
    ms: Date.now() - startedAt,
    truncated: capped.truncated,
    error: result.isError === true,
  });
  return capped.result;
}
