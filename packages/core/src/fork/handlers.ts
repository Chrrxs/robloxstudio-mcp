// Fork tool handlers, spread after upstream's TOOL_HANDLERS so a fork entry for
// an upstream tool name replaces it.
import type { ToolHandler } from '../http-server.js';
import { CAPTURE_RECT_ENDPOINT, captureScreenshotWithBudget } from './capture.js';
import { logsSince, QUERY_TREE_ENDPOINT, queryTree, WAIT_FOR_ENDPOINT, waitFor } from './round-trips.js';
import { LOAD_SCENARIO_ENDPOINT, runScenarioTool } from './scenario.js';

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
  run_scenario: (tools, body, context) => runScenarioTool(tools, {
    name: body.name, source: body.source, params: body.params, timeout: body.timeout, instance_id: body.instance_id,
  }, context?.signal),
};

/** Plugin endpoints fork handlers call, per tool (added to upstream's proxy allowlist). */
function forkProxyEndpoints(upstream: Record<string, readonly string[]>): Record<string, readonly string[]> {
  const of = (...tools: string[]) => tools.flatMap((tool) => upstream[tool] ?? []);
  return {
    capture_screenshot: [CAPTURE_RECT_ENDPOINT],
    wait_for: [WAIT_FOR_ENDPOINT],
    logs_since: ['/api/get-runtime-logs'],
    query_tree: [QUERY_TREE_ENDPOINT],
    // run_scenario drives the same plugin paths as these upstream tools.
    run_scenario: [
      LOAD_SCENARIO_ENDPOINT,
      WAIT_FOR_ENDPOINT,
      CAPTURE_RECT_ENDPOINT,
      ...of('solo_playtest', 'multiplayer_playtest', 'eval_server_runtime', 'simulate_keyboard_input', 'capture_screenshot', 'get_runtime_logs'),
    ],
  };
}

export function withForkProxyEndpoints(upstream: Record<string, readonly string[]>): Record<string, readonly string[]> {
  const merged: Record<string, readonly string[]> = { ...upstream };
  for (const [tool, endpoints] of Object.entries(forkProxyEndpoints(upstream))) {
    merged[tool] = [...new Set([...(merged[tool] ?? []), ...endpoints])];
  }
  return merged;
}
