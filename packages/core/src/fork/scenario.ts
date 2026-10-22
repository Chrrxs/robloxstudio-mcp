// run_scenario: load a scenario in the edit DataModel, then run it against a
// live playtest through upstream's playtest, eval, input, capture and log paths.
import type { RobloxStudioTools } from '../tools/index.js';
import { captureWithBudget } from './capture.js';
import { formatLogLines, type LogEntry } from './log-lines.js';
import { requestWaitFor } from './round-trips.js';
import { runScenario, type ImageBlock, type LoadedScenario, type ScenarioDriver } from './scenario-runner.js';

export const LOAD_SCENARIO_ENDPOINT = '/api/fork/load-scenario';
export const DEFAULT_SCENARIO_CONTAINER = 'ServerStorage.Scenarios';
const LOAD_TIMEOUT_MS = 30_000;
const START_TIMEOUT_SECONDS = 60;
const STOP_TIMEOUT_SECONDS = 30;
const MAX_RUN_SECONDS = 600;

type ToolResult = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };

function body(result: ToolResult): Record<string, unknown> {
  try {
    const parsed = JSON.parse(result.content[0]?.text ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return { error: result.content[0]?.text ?? 'unreadable response' };
  }
}

function failureOf(response: Record<string, unknown>): string | undefined {
  if (response.success === false || typeof response.error === 'string') {
    const parts = [response.error, response.message].filter((part) => typeof part === 'string' && part);
    return parts.length > 0 ? [...new Set(parts)].join(': ') : 'failed';
  }
  return undefined;
}

export function scenarioContainer(env: NodeJS.ProcessEnv = process.env): string {
  return env.MCP_SCENARIO_CONTAINER?.trim() || DEFAULT_SCENARIO_CONTAINER;
}

export function studioDriver(tools: RobloxStudioTools, instance_id: string | undefined, signal?: AbortSignal): ScenarioDriver {
  const bridge = tools.forkBridge();
  return {
    async start(players) {
      const result = players <= 1
        ? await tools.soloPlaytest('start', players === 0 ? 'run' : 'play', START_TIMEOUT_SECONDS, instance_id)
        : await tools.multiplayerPlaytest('start', players, undefined, undefined, undefined, START_TIMEOUT_SECONDS, instance_id);
      return { error: failureOf(body(result)) };
    },
    async stop(players) {
      const result = players <= 1
        ? await tools.soloPlaytest('stop', undefined, STOP_TIMEOUT_SECONDS, instance_id)
        : await tools.multiplayerPlaytest('end', undefined, undefined, undefined, undefined, STOP_TIMEOUT_SECONDS, instance_id);
      return { error: failureOf(body(result)) };
    },
    async eval(role, code, timeoutSeconds) {
      const response = await bridge.callSingle('/api/eval-runtime', { code }, role, instance_id, timeoutSeconds * 1000) as Record<string, unknown>;
      return {
        ok: response.ok === true,
        value: typeof response.result === 'string' ? response.result : undefined,
        error: typeof response.error === 'string' ? response.error : undefined,
      };
    },
    async waitFor(role, expr, timeoutSeconds) {
      return requestWaitFor(tools, expr, timeoutSeconds, role, instance_id);
    },
    async press(role, key, holdSeconds) {
      const result = await tools.simulateKeyboardInput(key, 'tap', holdSeconds, undefined, role, instance_id);
      return { error: failureOf(body(result as ToolResult)) };
    },
    async screenshot(role, crop, maxPx) {
      const instanceId = bridge.peerInstance(instance_id, role);
      if (instanceId === undefined) return { error: `${role} is not connected` };
      const result = await captureWithBudget(tools, instanceId, role, { crop, max_px: maxPx }) as ToolResult;
      const info = body(result);
      const image = result.content.find((block) => block.type === 'image') as ImageBlock | undefined;
      if (typeof info.error === 'string' || !image) return { error: typeof info.error === 'string' ? info.error : 'no image' };
      return { image, note: `${info.width}x${info.height} scale=${info.scale} origin=${info.origin}` };
    },
    async recentLogs(role, sinceSeconds) {
      const result = await tools.getRuntimeLogs(instance_id, undefined, undefined, undefined, undefined, undefined, signal, true);
      const raw = JSON.parse(result.content[0].text) as Record<string, unknown>;
      const instances = Array.isArray(raw.instances) ? raw.instances as Array<{ entries?: LogEntry[] }> : [raw as { entries?: LogEntry[] }];
      const entries = instances
        .flatMap((instance) => instance.entries ?? [])
        .filter((entry) => (entry.ts ?? 0) >= sinceSeconds)
        .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
      return formatLogLines(entries, { minLevel: 'warn', role });
    },
    sleep(seconds) {
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, seconds * 1000);
        signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    },
    now: () => Date.now(),
  };
}

export interface RunScenarioArgs {
  name?: string;
  source?: string;
  params?: unknown;
  timeout?: number;
  instance_id?: string;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true as const } : {}) };
}

export async function runScenarioTool(tools: RobloxStudioTools, args: RunScenarioArgs, signal?: AbortSignal, driver?: ScenarioDriver) {
  const hasName = typeof args.name === 'string' && args.name.trim() !== '';
  const hasSource = typeof args.source === 'string' && args.source.trim() !== '';
  if (hasName === hasSource) return textResult('ERROR pass exactly one of name or source.', true);
  if (args.params !== undefined && (args.params === null || typeof args.params !== 'object' || Array.isArray(args.params))) {
    return textResult('ERROR params must be an object.', true);
  }
  const timeout = args.timeout ?? 120;
  if (typeof timeout !== 'number' || !(timeout > 0) || timeout > MAX_RUN_SECONDS) {
    return textResult(`ERROR timeout must be 1-${MAX_RUN_SECONDS} seconds.`, true);
  }

  const bridge = tools.forkBridge();
  const refresh = bridge.refreshTopology();
  if (refresh) await refresh;
  const container = scenarioContainer();
  const loaded = await bridge.callSingle(
    LOAD_SCENARIO_ENDPOINT,
    { name: hasName ? args.name!.trim() : undefined, source: hasSource ? args.source : undefined, params: args.params, container },
    'edit',
    args.instance_id,
    LOAD_TIMEOUT_MS,
  ) as unknown as LoadedScenario & { error?: string };
  if (typeof loaded.error === 'string') {
    return textResult(loaded.error.includes(LOAD_SCENARIO_ENDPOINT)
      ? `ERROR run_scenario needs the fork's Studio plugin (${loaded.error})`
      : `ERROR ${loaded.error}`, true);
  }

  const outcome = await runScenario(driver ?? studioDriver(tools, args.instance_id, signal), loaded, { timeoutSeconds: timeout, signal });
  return {
    content: [
      { type: 'text' as const, text: [`scenario ${loaded.name} (${loaded.players} player${loaded.players === 1 ? '' : 's'})`, ...outcome.lines].join('\n') },
      ...outcome.images,
    ],
  };
}
