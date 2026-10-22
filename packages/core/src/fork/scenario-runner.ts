// run_scenario orchestration: validate every step, start the playtest, run
// the steps through a ScenarioDriver, and always stop the playtest. The driver
// is the only part that talks to Studio, so the flow is unit-testable.
import { describePlace, moveCode, spawnCode, USER_ID_CODE, type Place } from './scenario-luau.js';

export const MAX_SCREENSHOTS = 4;
const MAX_WAIT_STEP_SECONDS = 60;
const SPAWN_TIMEOUT_SECONDS = 15;
const DEFAULT_MOVE_TIMEOUT_SECONDS = 10;
const DEFAULT_WAIT_FOR_TIMEOUT_SECONDS = 5;
const MAX_STEP_TIMEOUT_SECONDS = 120;
const FAILURE_LOG_LINES = 5;
const FAILURE_LOG_BYTES = 1024;
const MAX_EXPR_CHARS = 60;

export interface LoadedScenario {
  name: string;
  players: number;
  steps: Array<Record<string, unknown>>;
}

export interface ImageBlock {
  type: 'image';
  data: string;
  mimeType: string;
}

/** Everything run_scenario needs from Studio. */
export interface ScenarioDriver {
  start(players: number): Promise<{ error?: string }>;
  stop(players: number): Promise<{ error?: string }>;
  /** Runs Luau in the game VM of `role`; `value` is the formatted return value. */
  eval(role: string, code: string, timeoutSeconds: number): Promise<{ ok: boolean; value?: string; error?: string }>;
  waitFor(role: string, expr: string, timeoutSeconds: number): Promise<{ ok?: boolean; elapsed?: number; value?: string; error?: string }>;
  press(role: string, key: string, holdSeconds?: number): Promise<{ error?: string }>;
  screenshot(role: string, crop?: string, maxPx?: number): Promise<{ image?: ImageBlock; note?: string; error?: string }>;
  /** Warning and error lines from `role` logged at or after `sinceSeconds` (Unix time). */
  recentLogs(role: string, sinceSeconds: number): Promise<string[]>;
  sleep(seconds: number): Promise<void>;
  now(): number;
}

type Step =
  | { type: 'spawn'; player: number; at: Place }
  | { type: 'press'; player: number; key: string; hold?: number }
  | { type: 'move'; player: number; to: Place; timeout: number }
  | { type: 'wait_for'; target: string; expr: string; timeout: number }
  | { type: 'assert'; target: string; expr: string }
  | { type: 'wait'; seconds: number }
  | { type: 'screenshot'; target: string; crop?: string; max_px?: number; label?: string };

export interface ScenarioOutcome {
  lines: string[];
  images: ImageBlock[];
  passed: boolean;
}

const TARGET = /^(edit|server|client-\d+)$/;

function place(value: unknown): Place | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    const { x, y, z } = value as Record<string, unknown>;
    if ([x, y, z].every((n) => typeof n === 'number' && Number.isFinite(n))) return { x: x as number, y: y as number, z: z as number };
  }
  return undefined;
}

function seconds(value: unknown, fallback: number, max: number): number | undefined {
  if (value === undefined) return fallback;
  return typeof value === 'number' && value >= 0 && value <= max ? value : undefined;
}

/** Returns the typed steps, or a one-line reason the scenario cannot run. */
export function validateSteps(scenario: LoadedScenario): Step[] | string {
  const steps: Step[] = [];
  for (const [index, raw] of scenario.steps.entries()) {
    const n = index + 1;
    const bad = (why: string) => `INVALID step ${n} (${String(raw.type)}): ${why}`;
    const player = raw.player === undefined ? 1 : raw.player;
    const playerOk = Number.isInteger(player) && (player as number) >= 1 && (player as number) <= scenario.players;
    const target = raw.target === undefined ? undefined : String(raw.target);
    if (target !== undefined && !TARGET.test(target)) return bad(`target must be edit, server or client-N, got "${target}"`);
    const needsPlayer = () => playerOk ? undefined : bad(`player must be 1-${scenario.players}`);
    switch (raw.type) {
      case 'spawn': {
        const at = place(raw.at);
        if (needsPlayer()) return needsPlayer()!;
        if (!at) return bad('needs at = instance path or {x, y, z}');
        steps.push({ type: 'spawn', player: player as number, at });
        break;
      }
      case 'press': {
        if (needsPlayer()) return needsPlayer()!;
        if (typeof raw.key !== 'string' || !raw.key) return bad('needs key = Enum.KeyCode name');
        const hold = raw.hold === undefined ? undefined : seconds(raw.hold, 0, 10);
        if (raw.hold !== undefined && hold === undefined) return bad('hold must be 0-10 seconds');
        steps.push({ type: 'press', player: player as number, key: raw.key, ...(hold === undefined ? {} : { hold }) });
        break;
      }
      case 'move': {
        const to = place(raw.to);
        const timeout = seconds(raw.timeout, DEFAULT_MOVE_TIMEOUT_SECONDS, MAX_STEP_TIMEOUT_SECONDS);
        if (needsPlayer()) return needsPlayer()!;
        if (!to) return bad('needs to = instance path or {x, y, z}');
        if (timeout === undefined) return bad(`timeout must be 0-${MAX_STEP_TIMEOUT_SECONDS} seconds`);
        steps.push({ type: 'move', player: player as number, to, timeout });
        break;
      }
      case 'wait_for':
      case 'assert': {
        if (typeof raw.expr !== 'string' || !raw.expr.trim()) return bad('needs expr = Luau expression');
        if (raw.type === 'assert') {
          steps.push({ type: 'assert', target: target ?? 'server', expr: raw.expr });
          break;
        }
        const timeout = seconds(raw.timeout, DEFAULT_WAIT_FOR_TIMEOUT_SECONDS, MAX_STEP_TIMEOUT_SECONDS);
        if (timeout === undefined) return bad(`timeout must be 0-${MAX_STEP_TIMEOUT_SECONDS} seconds`);
        steps.push({ type: 'wait_for', target: target ?? 'server', expr: raw.expr, timeout });
        break;
      }
      case 'wait': {
        const wait = seconds(raw.seconds, -1, MAX_WAIT_STEP_SECONDS);
        if (wait === undefined || wait < 0) return bad(`needs seconds = 0-${MAX_WAIT_STEP_SECONDS}`);
        steps.push({ type: 'wait', seconds: wait });
        break;
      }
      case 'screenshot': {
        const shotTarget = target ?? (scenario.players > 0 ? 'client-1' : 'edit');
        if (shotTarget === 'server') return bad('the server renders nothing; use client-N');
        if (raw.max_px !== undefined && !(Number.isInteger(raw.max_px) && (raw.max_px as number) >= 16 && (raw.max_px as number) <= 4096)) {
          return bad('max_px must be 16-4096');
        }
        steps.push({
          type: 'screenshot',
          target: shotTarget,
          ...(typeof raw.crop === 'string' && raw.crop ? { crop: raw.crop } : {}),
          ...(raw.max_px === undefined ? {} : { max_px: raw.max_px as number }),
          ...(typeof raw.label === 'string' && raw.label ? { label: raw.label } : {}),
        });
        break;
      }
      default:
        return bad('unknown type; use spawn, press, move, wait_for, assert, wait or screenshot');
    }
  }
  for (const step of steps) {
    const role = 'target' in step ? step.target : undefined;
    const client = role && /^client-(\d+)$/.exec(role);
    if (client && Number(client[1]) > scenario.players) {
      return `INVALID step ${steps.indexOf(step) + 1} (${step.type}): ${role} does not exist with ${scenario.players} player(s)`;
    }
  }
  return steps;
}

function short(expr: string): string {
  const flat = expr.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_EXPR_CHARS ? `${flat.slice(0, MAX_EXPR_CHARS - 1)}…` : flat;
}

function describe(step: Step): string {
  switch (step.type) {
    case 'spawn': return `spawn player=${step.player} at=${describePlace(step.at)}`;
    case 'press': return `press player=${step.player} key=${step.key}`;
    case 'move': return `move player=${step.player} to=${describePlace(step.to)}`;
    case 'wait_for': return `wait_for ${step.target} \`${short(step.expr)}\``;
    case 'assert': return `assert ${step.target} \`${short(step.expr)}\``;
    case 'wait': return `wait ${step.seconds}s`;
    case 'screenshot': return `screenshot ${step.target}${step.label ? ` "${step.label}"` : ''}`;
  }
}

/** The peer whose logs explain a failed step. */
function peerOf(step: Step): string {
  if ('target' in step) return step.target;
  if (step.type === 'spawn') return 'server';
  if ('player' in step) return `client-${step.player}`;
  return 'server';
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const clip = (text: string, max = 200) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export async function runScenario(
  driver: ScenarioDriver,
  scenario: LoadedScenario,
  options: { timeoutSeconds: number; signal?: AbortSignal },
): Promise<ScenarioOutcome> {
  const lines: string[] = [];
  const images: ImageBlock[] = [];
  const steps = validateSteps(scenario);
  if (typeof steps === 'string') return { lines: [steps], images, passed: false };

  const runStart = driver.now();
  const deadline = runStart + options.timeoutSeconds * 1000;
  const players = scenario.players;
  const mode = players === 0 ? 'solo run (server only)' : players === 1 ? 'solo play' : `multiplayer ${players} players`;
  let started = false;
  let failure: { index: number; step?: Step; why: string } | undefined;
  let failureLogs: string[] = [];

  const execute = async (): Promise<void> => {
    const startAt = driver.now();
    const start = await driver.start(players);
    if (start.error) {
      lines.push(`start ${mode} FAIL ${secs(driver.now() - startAt)}: ${clip(start.error)}`);
      failure = { index: 0, why: 'start' };
      return;
    }
    started = true;

    // Player n is client-n; the server finds the same player by UserId.
    const userIds: number[] = [];
    for (let player = 1; player <= players; player++) {
      const read = await driver.eval(`client-${player}`, USER_ID_CODE, 10);
      const userId = Number(read.value);
      if (!read.ok || !Number.isFinite(userId)) {
        lines.push(`start ${mode} FAIL: cannot read client-${player}'s player (${clip(read.error ?? String(read.value))})`);
        failure = { index: 0, why: 'start' };
        return;
      }
      userIds[player] = userId;
    }
    lines.push(`start ${mode} ok ${secs(driver.now() - startAt)}`);

    for (const [index, step] of steps.entries()) {
      const n = index + 1;
      if (options.signal?.aborted) {
        failure = { index: n, step, why: 'cancelled' };
        lines.push(`${n} ${describe(step)} CANCELLED`);
        break;
      }
      if (driver.now() > deadline) {
        failure = { index: n, step, why: 'timeout' };
        lines.push(`${n} ${describe(step)} SKIPPED: scenario timeout ${options.timeoutSeconds}s reached`);
        break;
      }
      const stepStart = driver.now();
      let error: string | undefined;
      let detail = '';
      switch (step.type) {
        case 'spawn': {
          const result = await driver.eval('server', spawnCode(userIds[step.player], step.player, step.at, SPAWN_TIMEOUT_SECONDS), SPAWN_TIMEOUT_SECONDS + 5);
          if (!result.ok) error = result.error ?? 'spawn failed';
          break;
        }
        case 'press': {
          error = (await driver.press(`client-${step.player}`, step.key, step.hold)).error;
          break;
        }
        case 'move': {
          const result = await driver.eval(`client-${step.player}`, moveCode(step.to, step.timeout), step.timeout + 5);
          if (!result.ok) error = result.error ?? 'move failed';
          else detail = ` within ${result.value} studs`;
          break;
        }
        case 'wait_for':
        case 'assert': {
          const result = await driver.waitFor(step.target, step.expr, step.type === 'assert' ? 0 : step.timeout);
          if (result.error) error = result.error;
          else if (!result.ok) error = step.type === 'assert' ? `value=${result.value ?? 'nil'}` : `timed out, last=${result.value ?? 'nil'}`;
          else detail = ` value=${result.value ?? 'nil'}`;
          break;
        }
        case 'wait':
          await driver.sleep(step.seconds);
          break;
        case 'screenshot': {
          if (images.length >= MAX_SCREENSHOTS) {
            detail = ` skipped (max ${MAX_SCREENSHOTS} per run)`;
            break;
          }
          const shot = await driver.screenshot(step.target, step.crop, step.max_px);
          if (shot.error || !shot.image) error = shot.error ?? 'no image';
          else {
            images.push(shot.image);
            detail = ` image ${images.length}${shot.note ? ` ${shot.note}` : ''}`;
          }
          break;
        }
      }
      const took = secs(driver.now() - stepStart);
      if (error !== undefined) {
        lines.push(`${n} ${describe(step)} FAIL ${took}: ${clip(error)}`);
        failure = { index: n, step, why: error };
        break;
      }
      lines.push(`${n} ${describe(step)} ok ${took}${clip(detail, 120)}`);
    }
  };

  try {
    await execute();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lines.push(`ERROR ${clip(message)}`);
    failure ??= { index: lines.length, why: message };
  } finally {
    // Runtime peers' log buffers disappear with the playtest, so read them first.
    if (started && failure?.step) {
      failureLogs = await driver.recentLogs(peerOf(failure.step), runStart / 1000 - 1).catch(() => []);
    }
    if (started) {
      const stopAt = driver.now();
      const stop = await driver.stop(players).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
      lines.push(stop.error ? `stop FAIL: ${clip(stop.error)}` : `stop ok ${secs(driver.now() - stopAt)}`);
    }
  }

  const total = secs(driver.now() - runStart);
  if (!failure) {
    lines.push(`PASS ${steps.length}/${steps.length} in ${total}`);
    return { lines, images, passed: true };
  }
  lines.push(failure.index === 0 ? `FAIL at start in ${total}` : `FAIL at step ${failure.index} (${failure.step?.type ?? 'run'}) in ${total}`);
  let budget = FAILURE_LOG_BYTES;
  for (const line of failureLogs.slice(-FAILURE_LOG_LINES)) {
    const out = `  log ${clip(line, 240)}`;
    budget -= Buffer.byteLength(out) + 1;
    if (budget < 0) break;
    lines.push(out);
  }
  return { lines, images, passed: false };
}
