// Phase 5 tools that replace screenshots with cheaper evidence: ui_layout
// (GUI geometry as text), snapshot / diff_state (only what changed) and
// frame_strip (several frames in one image).
import { decodePngToRgba } from '../image-decode.js';
import { rgbaToJpeg } from '../jpeg-encoder.js';
import type { RobloxStudioTools } from '../tools/index.js';
import { resolveCropBudget } from './capture.js';
import { composeGrid, gridShape, tileMaxPx, type Frame } from './frame-grid.js';
import { layoutReport, type LayoutNode } from './layout-checks.js';
import { forkLimits } from './limits.js';
import { routeTarget } from './round-trips.js';
import { diffStates, SnapshotStore, summarizeSnapshot, type InstanceState } from './state-diff.js';

export const UI_LAYOUT_ENDPOINT = '/api/fork/ui-layout';
export const READ_STATE_ENDPOINT = '/api/fork/read-state';

const TARGET = /^(edit|server|client-\d+)$/;
const RENDER_TARGET = /^(edit|client-\d+)$/;
const MAX_PATHS = 50;
const MAX_FIELDS = 20;
/** Grid size when MCP_IMAGE_MAX_PX is 0 (off). */
const UNCAPPED_GRID_PX = 2048;

type TextResult = { content: Array<{ type: 'text'; text: string }>; isError?: true };

function text(lines: string | string[], isError = false): TextResult {
  return {
    content: [{ type: 'text', text: Array.isArray(lines) ? lines.join('\n') : lines }],
    ...(isError ? { isError: true as const } : {}),
  };
}

function pluginError(error: string, endpoint: string, tool: string): TextResult {
  return error.includes(endpoint)
    ? text(`ERROR ${tool} needs the fork's Studio plugin (${error})`, true)
    : text(`ERROR ${error}`, true);
}

function stringList(value: unknown, max: number): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || !value.every((item) => typeof item === 'string' && item.trim())) return undefined;
  return value.map((item: string) => item.trim());
}

export interface UiLayoutArgs {
  gui_path?: string;
  target?: string;
  limit?: number;
  instance_id?: string;
}

export async function uiLayout(tools: RobloxStudioTools, args: UiLayoutArgs): Promise<TextResult> {
  if (typeof args.gui_path !== 'string' || !args.gui_path.trim()) return text('ERROR gui_path is required.', true);
  if (args.target !== undefined && !TARGET.test(args.target)) return text('ERROR target must be edit, server or client-N.', true);
  const limit = args.limit ?? 40;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return text('ERROR limit must be a whole number from 1 to 200.', true);
  const { bridge, choice } = await routeTarget(tools, args.target, args.instance_id);
  // GUIs render on clients, so a playtest defaults to client-1 rather than the server.
  choice.fallback = bridge.hasRole(args.instance_id, 'client-1') ? 'client-1' : 'edit';
  const response = await bridge.callSingle(UI_LAYOUT_ENDPOINT, { gui_path: args.gui_path.trim() }, choice, args.instance_id) as {
    error?: string;
    nodes?: LayoutNode[];
    total?: number;
  };
  if (typeof response.error === 'string') return pluginError(response.error, UI_LAYOUT_ENDPOINT, 'ui_layout');
  const nodes = response.nodes ?? [];
  return text(layoutReport(nodes, response.total ?? nodes.length, limit));
}

const snapshots = new SnapshotStore();

export interface SnapshotArgs {
  paths?: unknown;
  fields?: unknown;
  target?: string;
  instance_id?: string;
}

async function readState(
  tools: RobloxStudioTools,
  role: string,
  instance_id: string | undefined,
  paths: string[],
  fields: string[],
): Promise<InstanceState[] | TextResult> {
  const response = await tools.forkBridge().callSingle(READ_STATE_ENDPOINT, { paths, fields }, role, instance_id) as {
    error?: string;
    instances?: InstanceState[];
  };
  if (typeof response.error === 'string') return pluginError(response.error, READ_STATE_ENDPOINT, 'snapshot');
  return response.instances ?? [];
}

export async function snapshot(tools: RobloxStudioTools, args: SnapshotArgs): Promise<TextResult> {
  const paths = stringList(args.paths, MAX_PATHS);
  if (!paths || paths.length === 0) return text(`ERROR paths must be a list of 1-${MAX_PATHS} instance paths.`, true);
  const fields = stringList(args.fields, MAX_FIELDS);
  if (!fields) return text(`ERROR fields must be a list of up to ${MAX_FIELDS} property names.`, true);
  if (args.target !== undefined && !TARGET.test(args.target)) return text('ERROR target must be edit, server or client-N.', true);
  const { choice } = await routeTarget(tools, args.target, args.instance_id);
  const role = choice.requested ?? choice.fallback;
  const state = await readState(tools, role, args.instance_id, paths, fields);
  if (!Array.isArray(state)) return state;
  return text(summarizeSnapshot(snapshots.add({ role, instance_id: args.instance_id, paths, fields, state })));
}

export async function diffState(tools: RobloxStudioTools, args: { snapshot_id?: string }): Promise<TextResult> {
  const id = typeof args.snapshot_id === 'string' ? args.snapshot_id.trim() : '';
  const stored = snapshots.get(id);
  if (!stored) return text(`ERROR no snapshot "${id}"; snapshots last for this server process, newest 20 kept.`, true);
  const refresh = tools.forkBridge().refreshTopology();
  if (refresh) await refresh;
  const state = await readState(tools, stored.role, stored.instance_id, stored.paths, stored.fields);
  if (!Array.isArray(state)) return state;
  return text(diffStates(stored.state, state));
}

export interface FrameStripArgs {
  target?: string;
  crop?: string;
  frames?: number;
  interval?: number;
  instance_id?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function frameStrip(tools: RobloxStudioTools, args: FrameStripArgs) {
  const count = args.frames ?? 4;
  if (!Number.isInteger(count) || count < 2 || count > 12) return text('ERROR frames must be a whole number from 2 to 12.', true);
  const interval = args.interval ?? 0.25;
  if (typeof interval !== 'number' || !(interval >= 0) || interval > 2) return text('ERROR interval must be 0-2 seconds.', true);
  if (args.target !== undefined && !RENDER_TARGET.test(args.target)) return text('ERROR target must be edit or client-N (the server renders nothing).', true);

  const bridge = tools.forkBridge();
  const refresh = bridge.refreshTopology();
  if (refresh) await refresh;
  let instanceId: string | undefined;
  let role: string;
  if (args.target) {
    role = args.target;
    instanceId = bridge.peerInstance(args.instance_id, role);
    if (instanceId === undefined) return text(`ERROR ${role} is not connected.`, true);
  } else {
    const runtime = bridge.resolveRuntime(args.instance_id);
    instanceId = runtime.instanceId;
    role = runtime.clientRole ?? 'edit';
  }

  const limits = forkLimits();
  const gridPx = limits.imageMaxPx > 0 ? limits.imageMaxPx : UNCAPPED_GRID_PX;
  const budget = await resolveCropBudget(tools, instanceId, role, args.crop, tileMaxPx(count, gridPx));
  if ('error' in budget) return text(`ERROR ${budget.error}`, true);

  const frames: Frame[] = [];
  const times: number[] = [];
  const startedAt = Date.now();
  for (let i = 0; i < count; i++) {
    const due = startedAt + i * interval * 1000;
    if (Date.now() < due) await sleep(due - Date.now());
    times.push((Date.now() - startedAt) / 1000);
    const capture = await bridge.captureViewportImage(instanceId, role, 'png', undefined, undefined, budget);
    if (!capture.success) return text(`ERROR frame ${i + 1}: ${capture.error}`, true);
    const decoded = decodePngToRgba(Buffer.from(capture.data, 'base64'));
    frames.push({ rgba: decoded.rgba, width: decoded.width, height: decoded.height });
  }

  const grid = composeGrid(frames);
  const jpeg = rgbaToJpeg(grid.rgba, grid.width, grid.height, limits.imageQuality);
  const { cols, rows } = gridShape(count);
  const region = budget.crop ? ` of ${budget.crop.x},${budget.crop.y} ${budget.crop.w}x${budget.crop.h}` : '';
  return {
    content: [
      {
        type: 'text' as const,
        text: `frame_strip ${count} frames${region}, ${cols}x${rows} grid ${grid.width}x${grid.height}px, ` +
          `tile ${frames[0].width}x${frames[0].height}, left to right then down; t=${times.map((t) => t.toFixed(2)).join(',')}s`,
      },
      { type: 'image' as const, data: jpeg.toString('base64'), mimeType: 'image/jpeg' },
    ],
  };
}
