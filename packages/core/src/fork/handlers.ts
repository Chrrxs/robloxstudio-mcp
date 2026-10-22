// Fork tool handlers, spread after upstream's TOOL_HANDLERS so a fork entry for
// an upstream tool name replaces it.
import type { ToolHandler } from '../http-server.js';
import { CAPTURE_RECT_ENDPOINT, captureScreenshotWithBudget } from './capture.js';
import { logsSince, QUERY_TREE_ENDPOINT, queryTree, WAIT_FOR_ENDPOINT, waitFor } from './round-trips.js';

export const FORK_TOOL_HANDLERS: Record<string, ToolHandler> = {
  capture_screenshot: (tools, body) => captureScreenshotWithBudget(tools, body.instance_id, {
    format: body.format,
    quality: body.quality,
    crop: body.crop,
    max_px: body.max_px,
  }),
  wait_for: (tools, body) => waitFor(tools, {
    expr: body.expr, target: body.target, timeout: body.timeout, instance_id: body.instance_id,
  }),
  logs_since: (tools, body, context) => logsSince(tools, {
    cursor: body.cursor, min_level: body.min_level, pattern: body.pattern, target: body.target, instance_id: body.instance_id,
  }, context?.signal),
  query_tree: (tools, body) => queryTree(tools, {
    path: body.path, class: body.class, fields: body.fields, depth: body.depth, limit: body.limit,
    target: body.target, instance_id: body.instance_id,
  }),
};

/** Plugin endpoints fork handlers call, per tool (added to upstream's proxy allowlist). */
const FORK_TOOL_PROXY_ENDPOINTS: Record<string, readonly string[]> = {
  capture_screenshot: [CAPTURE_RECT_ENDPOINT],
  wait_for: [WAIT_FOR_ENDPOINT],
  logs_since: ['/api/get-runtime-logs'],
  query_tree: [QUERY_TREE_ENDPOINT],
};

export function withForkProxyEndpoints(upstream: Record<string, readonly string[]>): Record<string, readonly string[]> {
  const merged: Record<string, readonly string[]> = { ...upstream };
  for (const [tool, endpoints] of Object.entries(FORK_TOOL_PROXY_ENDPOINTS)) {
    merged[tool] = [...(merged[tool] ?? []), ...endpoints];
  }
  return merged;
}
