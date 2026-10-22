// Phase 3 tools that save agent round trips: wait_for polls in Studio,
// logs_since returns only new lines, query_tree returns one line per match.
import type { RobloxStudioTools } from '../tools/index.js';
import { formatLogLines, LOG_LEVELS, type LogEntry, type LogLevelName } from './log-lines.js';

export const WAIT_FOR_ENDPOINT = '/api/fork/wait-for';
export const QUERY_TREE_ENDPOINT = '/api/fork/query-tree';

export const MAX_WAIT_SECONDS = 120;
const WAIT_REQUEST_MARGIN_MS = 15_000;
const MAX_FIELDS = 20;

type TextResult = { content: Array<{ type: 'text'; text: string }>; isError?: true };

function text(lines: string | string[], isError = false): TextResult {
  return {
    content: [{ type: 'text', text: Array.isArray(lines) ? lines.join('\n') : lines }],
    ...(isError ? { isError: true as const } : {}),
  };
}

/** Plugin errors, with a pointer to the fork plugin when the endpoint is missing. */
function pluginError(error: string, endpoint: string, tool: string): TextResult {
  return error.includes(endpoint)
    ? text(`ERROR ${tool} needs the fork's Studio plugin (${error})`, true)
    : text(`ERROR ${error}`, true);
}

/** server while a playtest is running, edit otherwise; an explicit target always wins. */
export interface RoutedTarget {
  bridge: ReturnType<RobloxStudioTools['forkBridge']>;
  choice: { requested: string | undefined; fallback: string; accepts: (role: string) => boolean };
}

export async function routeTarget(tools: RobloxStudioTools, target: string | undefined, instance_id: string | undefined): Promise<RoutedTarget> {
  const bridge = tools.forkBridge();
  const refresh = bridge.refreshTopology();
  if (refresh) await refresh;
  const fallback = bridge.hasRole(instance_id, 'server') ? 'server' : 'edit';
  return { bridge, choice: { requested: target || undefined, fallback, accepts: () => true } };
}

export interface WaitForArgs {
  expr?: string;
  target?: string;
  timeout?: number;
  instance_id?: string;
}

export interface WaitForResponse {
  error?: string;
  ok?: boolean;
  elapsed?: number;
  polls?: number;
  value?: string;
}

export function formatWaitFor(response: WaitForResponse): TextResult {
  if (typeof response.error === 'string') return pluginError(response.error, WAIT_FOR_ENDPOINT, 'wait_for');
  const elapsed = `${(response.elapsed ?? 0).toFixed(2)}s`;
  const value = response.value ?? 'nil';
  return response.ok
    ? text(`ok ${elapsed} polls=${response.polls ?? 0} value=${value}`)
    : text(`TIMEOUT ${elapsed} polls=${response.polls ?? 0} last=${value}`);
}

export async function waitFor(tools: RobloxStudioTools, args: WaitForArgs): Promise<TextResult> {
  if (typeof args.expr !== 'string' || !args.expr.trim()) return text('ERROR expr is required.', true);
  const timeout = args.timeout ?? 5;
  if (typeof timeout !== 'number' || !(timeout >= 0) || timeout > MAX_WAIT_SECONDS) {
    return text(`ERROR timeout must be 0-${MAX_WAIT_SECONDS} seconds.`, true);
  }
  return formatWaitFor(await requestWaitFor(tools, args.expr, timeout, args.target, args.instance_id));
}

/** One wait_for round trip; also used by run_scenario's wait_for and assert steps. */
export async function requestWaitFor(
  tools: RobloxStudioTools,
  expr: string,
  timeout: number,
  target: string | undefined,
  instance_id: string | undefined,
): Promise<WaitForResponse> {
  const { bridge, choice } = await routeTarget(tools, target, instance_id);
  return await bridge.callSingle(
    WAIT_FOR_ENDPOINT,
    { expr, timeout },
    choice,
    instance_id,
    timeout * 1000 + WAIT_REQUEST_MARGIN_MS,
  ) as WaitForResponse;
}

export interface LogsSinceArgs {
  cursor?: string;
  min_level?: string;
  pattern?: string;
  target?: string;
  instance_id?: string;
}

/** logs_since cursors wrap get_runtime_logs cursors: "i.<cursor>" for one Instance, "g.<base64 map>" for a group. */
function decodeLogsCursor(cursor: string | undefined): { single?: string; group?: Record<string, string> } {
  if (cursor === undefined || cursor === '') return {};
  if (cursor.startsWith('i.')) return { single: cursor.slice(2) };
  if (cursor.startsWith('g.')) {
    try {
      const map = JSON.parse(Buffer.from(cursor.slice(2), 'base64url').toString('utf8'));
      if (map && typeof map === 'object' && !Array.isArray(map) && Object.values(map).every((value) => typeof value === 'string')) {
        return { group: map as Record<string, string> };
      }
    } catch {
      // fall through
    }
  }
  throw new Error('logs_since cursor is invalid; omit it to read from the start of the buffer.');
}

interface InstanceLogs {
  instanceId: string;
  entries?: LogEntry[];
  error?: string;
  nextCursor?: string;
  peerErrors?: Array<{ role: string; error: string }>;
}

export function formatLogsSince(raw: Record<string, unknown>, minLevel: LogLevelName, role?: string): string[] {
  const instances = Array.isArray(raw.instances) ? raw.instances as InstanceLogs[] : [raw as unknown as InstanceLogs];
  const entries = instances
    .flatMap((instance) => instance.entries ?? [])
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const lines = formatLogLines(entries, { minLevel, role });
  for (const instance of instances) {
    if (instance.error) lines.push(`! ${instance.instanceId}: ${instance.error.slice(0, 200)}`);
    for (const peer of instance.peerErrors ?? []) {
      if (role === undefined || peer.role === role) lines.push(`! ${peer.role}: ${peer.error.slice(0, 200)}`);
    }
  }
  if (lines.length === 0) lines.push('no new lines');
  const cursor = raw.nextCursorByInstance
    ? `g.${Buffer.from(JSON.stringify(raw.nextCursorByInstance)).toString('base64url')}`
    : `i.${String(raw.nextCursor ?? '')}`;
  lines.push(`cursor=${cursor}`);
  return lines;
}

export async function logsSince(tools: RobloxStudioTools, args: LogsSinceArgs, signal?: AbortSignal): Promise<TextResult> {
  const minLevel = (args.min_level ?? 'warn') as LogLevelName;
  if (!LOG_LEVELS.includes(minLevel)) return text(`ERROR min_level must be one of: ${LOG_LEVELS.join(', ')}.`, true);
  const cursor = decodeLogsCursor(args.cursor);
  const result = await tools.getRuntimeLogs(
    args.instance_id,
    undefined,
    cursor.single,
    cursor.group,
    undefined,
    args.pattern || undefined,
    signal,
    true,
  );
  const raw = JSON.parse(result.content[0].text) as Record<string, unknown>;
  return text(formatLogsSince(raw, minLevel, args.target || undefined));
}

export interface QueryTreeArgs {
  path?: string;
  class?: string;
  fields?: unknown;
  depth?: number;
  limit?: number;
  target?: string;
  instance_id?: string;
}

interface QueryTreeResponse {
  error?: string;
  lines?: string[];
  total?: number;
}

export function formatQueryTree(response: QueryTreeResponse, path: string): TextResult {
  if (typeof response.error === 'string') return pluginError(response.error, QUERY_TREE_ENDPOINT, 'query_tree');
  const lines = [...(response.lines ?? [])];
  const total = response.total ?? lines.length;
  if (total === 0) return text(`no matches under ${path}`);
  if (total > lines.length) lines.push(`… ${lines.length} of ${total}; raise limit or narrow class/path`);
  return text(lines);
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return value as number;
}

export async function queryTree(tools: RobloxStudioTools, args: QueryTreeArgs): Promise<TextResult> {
  if (typeof args.path !== 'string' || !args.path.trim()) return text('ERROR path is required.', true);
  const fields = args.fields ?? [];
  if (!Array.isArray(fields) || fields.length > MAX_FIELDS || !fields.every((field) => typeof field === 'string' && field.trim())) {
    return text(`ERROR fields must be a list of up to ${MAX_FIELDS} property names (or @Attribute).`, true);
  }
  let depth: number;
  let limit: number;
  try {
    depth = boundedInteger(args.depth, 1, 0, 10, 'depth');
    limit = boundedInteger(args.limit, 25, 1, 500, 'limit');
  } catch (error) {
    return text(`ERROR ${(error as Error).message}`, true);
  }
  const { bridge, choice } = await routeTarget(tools, args.target, args.instance_id);
  const response = await bridge.callSingle(
    QUERY_TREE_ENDPOINT,
    { path: args.path.trim(), class: args.class || undefined, fields, depth, limit },
    choice,
    args.instance_id,
  ) as QueryTreeResponse;
  return formatQueryTree(response, args.path.trim());
}
