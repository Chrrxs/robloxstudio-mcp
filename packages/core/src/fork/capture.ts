// capture_screenshot with crop and max_px, plus the defaults every viewport
// capture uses. Coordinates: the image is a scaled copy of a viewport region,
// so viewport px = origin + image px / scale (what simulate_mouse_input needs).
import type { RobloxStudioTools } from '../tools/index.js';
import { parseRect, pluginFrameMaxPx, type CaptureBudget, type Rect } from './image-budget.js';
import { forkLimits } from './limits.js';

export const CAPTURE_RECT_ENDPOINT = '/api/fork/capture-rect';
const MIN_MAX_PX = 16;
const MAX_MAX_PX = 4096;

export function defaultCaptureBudget(): CaptureBudget {
  return { maxPx: forkLimits().imageMaxPx };
}

export function defaultCaptureQuality(): number {
  return forkLimits().imageQuality;
}

/** Extra request fields for the plugin's capture endpoints (older plugins ignore them). */
export function pluginCaptureFields(budget: CaptureBudget): { maxPx?: number } {
  const maxPx = pluginFrameMaxPx(budget);
  return maxPx === undefined ? {} : { maxPx };
}

function errorResult(error: string) {
  return { content: [{ type: 'text', text: JSON.stringify({ error }) }] };
}

interface RectResponse {
  error?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  viewportWidth?: number;
  viewportHeight?: number;
}

function hostNoteOf(message: string): string {
  return /( (?:Captured from|Warning:) .*)$/.exec(message)?.[1] ?? '';
}

export interface CaptureArgs {
  format?: string;
  quality?: number;
  crop?: string;
  max_px?: number;
}

export async function captureScreenshotWithBudget(tools: RobloxStudioTools, instance_id: string | undefined, body: CaptureArgs) {
  const bridge = tools.forkBridge();
  const refresh = bridge.refreshTopology();
  if (refresh) await refresh;
  const { instanceId, clientRole } = bridge.resolveRuntime(instance_id);
  const role = clientRole ?? 'edit';

  let maxPx = forkLimits().imageMaxPx;
  if (body.max_px !== undefined) {
    if (!Number.isInteger(body.max_px) || body.max_px < MIN_MAX_PX || body.max_px > MAX_MAX_PX) {
      return errorResult(`max_px must be a whole number from ${MIN_MAX_PX} to ${MAX_MAX_PX}.`);
    }
    maxPx = body.max_px;
  }
  const budget: CaptureBudget = { maxPx };

  if (typeof body.crop === 'string' && body.crop.trim()) {
    const literal = parseRect(body.crop);
    const resolved = await bridge.callSingle(
      CAPTURE_RECT_ENDPOINT,
      literal ? { rect: literal } : { path: body.crop.trim() },
      role,
      instanceId,
    ) as RectResponse;
    const pluginLacksEndpoint = typeof resolved.error === 'string' && resolved.error.includes(CAPTURE_RECT_ENDPOINT);
    if (resolved.error && !(literal && pluginLacksEndpoint)) {
      return errorResult(pluginLacksEndpoint
        ? `crop by instance path needs the fork's Studio plugin; pass crop as "x,y,w,h" instead. (${resolved.error})`
        : `crop: ${resolved.error}`);
    }
    if (resolved.error) {
      budget.crop = literal;
    } else {
      budget.crop = { x: resolved.x ?? 0, y: resolved.y ?? 0, w: resolved.w ?? 0, h: resolved.h ?? 0 };
      if (resolved.viewportWidth && resolved.viewportHeight) {
        budget.viewport = { width: resolved.viewportWidth, height: resolved.viewportHeight };
      }
    }
  }

  const capture = await bridge.captureViewportImage(instanceId, role, body.format, body.quality, undefined, budget);
  if (!capture.success) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: capture.error, studioFastPathUnavailable: capture.studioFastPathUnavailable }) }] };
  }

  const viewport = capture.viewport ?? { width: capture.width, height: capture.height };
  const region: Rect = capture.crop ?? { x: 0, y: 0, w: viewport.width, h: viewport.height };
  const scale = Number((capture.width / region.w).toFixed(4));
  const quality = capture.format === 'jpeg' ? ` q${capture.quality}` : '';
  const message = capture.crop
    ? `Screenshot ${capture.width}x${capture.height}px (${capture.format}${quality})${capture.note} of viewport region ` +
      `${region.x},${region.y} ${region.w}x${region.h}. For simulate_mouse_input: viewport x = ${region.x} + image x / ${scale}, ` +
      `viewport y = ${region.y} + image y / ${scale}.${hostNoteOf(capture.message)}`
    : capture.message;

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          width: capture.width,
          height: capture.height,
          format: capture.format,
          mimeType: capture.mimeType,
          ...(capture.quality === undefined ? {} : { quality: capture.quality }),
          scale,
          origin: `${region.x},${region.y}`,
          message,
          source: capture.source,
          studioFastPathUnavailable: capture.studioFastPathUnavailable,
        }),
      },
      { type: 'image', data: capture.data, mimeType: capture.mimeType },
    ],
  };
}
