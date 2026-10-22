// Fork tool handlers, spread after upstream's TOOL_HANDLERS so a fork entry for
// an upstream tool name replaces it.
import type { ToolHandler } from '../http-server.js';
import { CAPTURE_RECT_ENDPOINT, captureScreenshotWithBudget } from './capture.js';

export const FORK_TOOL_HANDLERS: Record<string, ToolHandler> = {
  capture_screenshot: (tools, body) => captureScreenshotWithBudget(tools, body.instance_id, {
    format: body.format,
    quality: body.quality,
    crop: body.crop,
    max_px: body.max_px,
  }),
};

/** Plugin endpoints fork handlers call, per tool (added to upstream's proxy allowlist). */
const FORK_TOOL_PROXY_ENDPOINTS: Record<string, readonly string[]> = {
  capture_screenshot: [CAPTURE_RECT_ENDPOINT],
};

export function withForkProxyEndpoints(upstream: Record<string, readonly string[]>): Record<string, readonly string[]> {
  const merged: Record<string, readonly string[]> = { ...upstream };
  for (const [tool, endpoints] of Object.entries(FORK_TOOL_PROXY_ENDPOINTS)) {
    merged[tool] = [...(merged[tool] ?? []), ...endpoints];
  }
  return merged;
}
