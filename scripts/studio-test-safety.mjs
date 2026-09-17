// Test harness policy, not a claim about a vendor-safe launch rate. The trusted
// root is profile-global and is supplied only after profile env sanitization.
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import lockfile from 'proper-lockfile';

export const STUDIO_TEST_LAUNCH_WINDOW_MS = 2 * 60 * 1000;
export const STUDIO_TEST_LAUNCH_COST_LIMIT = 10;
// Version 1 previously admitted up to 24 cost/hour. Its storage bounds are not
// the current admission policy: existing reservations must survive migration.
const STATE_V1_MAX_COST = 24;
const LOCK_STALE_MS = 120_000;
const POLL_MS = 50;
const CATEGORIES = new Set([
  'launch_failed', 'launch_unknown', 'run_failed', 'run_unknown',
  'clock_rollback', 'lock_compromised', 'launch_budget',
]);

function reportCapacityWait({ cost, available, waitMs }) {
  process.stderr.write(`Studio test safety: waiting ${Math.ceil(waitMs / 1000)}s for launch capacity (${cost} cost requested, ${available} available).\n`);
}

export class StudioTestSafetyError extends Error {
  constructor(category) {
    const guidance = CATEGORIES.has(category) || category === 'abandoned_run' || category === 'pending_launch'
      ? ' Address the cause first, then explicitly reset with npm run studio:test-safety:reset -- --reason \"reason\". Reset preserves launch-cost reservations.'
      : '';
    super(`Studio test safety blocked: ${category}.${guidance}`);
    this.name = 'StudioTestSafetyError';
    this.category = category;
  }
}

function fail(category) { throw new StudioTestSafetyError(category); }
function timestamp(value) { return Number.isSafeInteger(value) && value >= 0; }
function token(value) { return typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function validate(state) {
  if (!object(state) || state.version !== 1 || !timestamp(state.observedAt)
    || !(state.lastLaunchAt === null || timestamp(state.lastLaunchAt))
    || !(state.run === null || token(state.run))
    || !(state.pending === null || token(state.pending))
    || !(state.blocked === null || CATEGORIES.has(state.blocked))
    || !Array.isArray(state.reservations)
    || state.reservations.length > STATE_V1_MAX_COST
    || state.reservations.some((entry, index) => !object(entry) || !timestamp(entry.at)
      || !Number.isInteger(entry.cost) || entry.cost < 1 || entry.cost > STATE_V1_MAX_COST
      || entry.at > state.observedAt || state.lastLaunchAt === null || entry.at > state.lastLaunchAt
      || (index > 0 && entry.at < state.reservations[index - 1].at))
    || state.reservations.reduce((sum, entry) => sum + entry.cost, 0) > STATE_V1_MAX_COST
    || (state.lastLaunchAt !== null && state.lastLaunchAt > state.observedAt)) {
    fail('corrupt_state');
  }
  return state;
}

function launchOutcome(result) {
  if (!object(result)) return 'launch_unknown';
  let body = Object.hasOwn(result, 'body') ? result.body : result;
  if (result.isError === true) return 'launch_failed';
  if (!object(body)) return 'launch_unknown';
  if (body.isError === true || body.success === false || body.error
    || body.state === 'failed' || body.state === 'exited') return 'launch_failed';
  if (object(body.structuredContent)) return launchOutcome(body.structuredContent);
  if (Array.isArray(body.content)) {
    const text = body.content.find((entry) => entry?.type === 'text')?.text;
    try { body = JSON.parse(text); }
    catch { return 'launch_unknown'; }
    return launchOutcome(body);
  }
  if (!(body.success === true || (Number.isSafeInteger(body.pid) && body.pid > 0)
    || (typeof body.launch_id === 'string' && body.launch_id)
    || (typeof body.instance_id === 'string' && body.instance_id))) return 'launch_unknown';
  return null;
}

function toolCost(name, args) {
  if (name === 'manage_instance' && args?.action === 'launch') return 1;
  if (name !== 'multiplayer_playtest' || !['start', 'add_players'].includes(args?.action)) return 0;
  // Neither the MCP schema nor core supplies a default for numPlayers.
  if (!Number.isInteger(args.numPlayers) || args.numPlayers < 1 || args.numPlayers > 8) {
    fail('invalid_player_count');
  }
  return args.numPlayers + (args.action === 'start' ? 1 : 0);
}

export function createStudioTestSafety({ root, now = Date.now, sleep = delay, onCapacityWait = reportCapacityWait } = {}) {
  if (typeof root !== 'string' || !isAbsolute(root)) fail('missing_absolute_root');
  const statePath = join(root, 'state.json');
  const initializedPath = join(root, 'initialized');
  const runTarget = join(root, 'run');
  const stateTarget = join(root, 'state');
  const launchTarget = join(root, 'launch');

  function prepare() {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) fail('unsafe_root');
  }

  function acquire(target) {
    prepare();
    let compromised = false;
    const release = lockfile.lockSync(target, {
      realpath: false, retries: 0, stale: LOCK_STALE_MS, update: 1000,
      onCompromised: () => { compromised = true; },
    });
    return {
      assert() { if (compromised) fail('lock_compromised'); },
      release() { release(); },
    };
  }

  function locked(target) {
    return lockfile.checkSync(target, { realpath: false, stale: LOCK_STALE_MS });
  }

  function load(at) {
    if (!existsSync(statePath)) {
      if (existsSync(initializedPath)) fail('missing_state');
      return { version: 1, observedAt: at, lastLaunchAt: null, reservations: [], run: null, pending: null, blocked: null };
    }
    if (!lstatSync(statePath).isFile() || lstatSync(statePath).isSymbolicLink()) fail('corrupt_state');
    try { return validate(JSON.parse(readFileSync(statePath, 'utf8'))); }
    catch (error) {
      if (error instanceof StudioTestSafetyError) throw error;
      fail('corrupt_state');
    }
  }

  function persist(state) {
    const temporary = join(root, `state-${randomUUID()}.tmp`);
    let fd;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify(state)}\n`);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, statePath);
      if (!existsSync(initializedPath)) {
        const marker = openSync(initializedPath, 'wx', 0o600);
        try { writeFileSync(marker, '1\n'); fsyncSync(marker); }
        finally { closeSync(marker); }
      }
      // Windows does not support opening directories for fsync. The state file
      // itself is flushed before its same-directory atomic rename on all hosts.
      if (process.platform !== 'win32') {
        const directory = openSync(root, 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  async function mutate(operation) {
    let lease;
    for (;;) {
      try { lease = acquire(stateTarget); break; }
      catch (error) {
        if (error?.code !== 'ELOCKED') throw error;
        await sleep(POLL_MS);
      }
    }
    try {
      lease.assert();
      const at = now();
      if (!timestamp(at)) fail('invalid_clock');
      const state = load(at);
      if (at < state.observedAt) {
        state.blocked = 'clock_rollback';
        persist(state);
        fail('clock_rollback');
      }
      state.observedAt = at;
      state.reservations = state.reservations.filter((entry) => at - entry.at < STUDIO_TEST_LAUNCH_WINDOW_MS);
      // Even rejected attempts advance the durable clock observation.
      persist(state);
      const result = operation(state, at);
      lease.assert();
      persist(state);
      return result;
    } finally { lease.release(); }
  }

  function healthy(state, { startingRun = false } = {}) {
    if (state.blocked) fail(state.blocked);
    if (state.run !== null && (startingRun || !locked(runTarget))) fail('abandoned_run');
    if (state.pending !== null) fail('pending_launch');
  }

  async function withRun(operation) {
    let lease;
    try { lease = acquire(runTarget); }
    catch (error) { if (error?.code === 'ELOCKED') fail('run_active'); throw error; }
    const id = randomUUID();
    let started = false;
    try {
      await mutate((state) => {
        healthy(state, { startingRun: true });
        lease.assert();
        state.run = id;
      });
      started = true;
      const result = await operation();
      await mutate((state) => {
        lease.assert();
        if (state.run !== id) fail('run_unknown');
        if (result !== 0) state.blocked ??= typeof result === 'number' ? 'run_failed' : 'run_unknown';
        else if (state.pending !== null) state.blocked ??= 'launch_unknown';
        else if (state.blocked === null) state.run = null;
      });
      if (result === 0) await mutate((state) => healthy(state));
      if (typeof result !== 'number') fail('run_unknown');
      return result;
    } catch (error) {
      if (started) {
        try { await mutate((state) => { state.blocked ??= 'run_failed'; }); }
        catch { /* The persisted running marker still blocks a later run. */ }
      }
      throw error;
    } finally { lease.release(); }
  }

  async function withLaunch(cost, operation) {
    if (!Number.isInteger(cost) || cost < 1 || cost > STUDIO_TEST_LAUNCH_COST_LIMIT) fail('invalid_launch_cost');
    let lease;
    const id = randomUUID();
    let reserved = false;
    try {
      for (;;) {
        for (;;) {
          try { lease = acquire(launchTarget); break; }
          catch (error) {
            if (error?.code !== 'ELOCKED') throw error;
            // A live RPC may finish; a tripped latch must stop every waiter.
            await mutate((state) => {
              if (state.blocked) fail(state.blocked);
              if (state.run !== null && !locked(runTarget)) fail('abandoned_run');
            });
            await sleep(POLL_MS);
          }
        }
        let available;
        const wait = await mutate((state, at) => {
          lease.assert();
          healthy(state);
          let used = state.reservations.reduce((sum, entry) => sum + entry.cost, 0);
          if (used + cost > STUDIO_TEST_LAUNCH_COST_LIMIT) {
            available = Math.max(0, STUDIO_TEST_LAUNCH_COST_LIMIT - used);
          }
          let wait = 0;
          // Weighted requests may need more than the oldest reservation to
          // expire. Waiting is pre-dispatch admission, never a launch retry.
          for (const entry of state.reservations) {
            if (used + cost <= STUDIO_TEST_LAUNCH_COST_LIMIT) break;
            used -= entry.cost;
            wait = Math.max(wait, entry.at + STUDIO_TEST_LAUNCH_WINDOW_MS - at);
          }
          if (wait > 0) return wait;
          state.reservations.push({ at, cost });
          state.lastLaunchAt = at;
          state.pending = id;
          return 0;
        });
        if (wait === 0) break;
        lease.release();
        lease = undefined;
        if (available !== undefined) onCapacityWait({ cost, available, waitMs: wait });
        await sleep(wait);
      }
      reserved = true;
      lease.assert();
      const result = await operation();
      const outcome = launchOutcome(result);
      await mutate((state) => {
        lease.assert();
        if (state.pending !== id) fail('launch_unknown');
        if (outcome) state.blocked ??= outcome;
        state.pending = null;
      });
      // Error-shaped tool results keep their existing transport/parser contract;
      // the durable latch, not a replacement exception, stops later launches.
      return result;
    } catch (error) {
      if (reserved) {
        try { await mutate((state) => { state.blocked ??= 'launch_unknown'; }); }
        catch { /* Pending is durable before dispatch and remains fail-closed. */ }
      }
      throw error;
    } finally { lease?.release(); }
  }

  async function withMaintenance(operation) {
    let runLease;
    let launchLease;
    try {
      try { runLease = acquire(runTarget); }
      catch (error) { if (error?.code === 'ELOCKED') fail('run_active'); throw error; }
      try { launchLease = acquire(launchTarget); }
      catch (error) { if (error?.code === 'ELOCKED') fail('launch_active'); throw error; }
      // Maintenance accepts abandoned/failed work, but must not reset it, age
      // reservations, advance the observed clock, or initialize missing state.
      load(now());
      runLease.assert();
      launchLease.assert();
      const result = await operation();
      runLease.assert();
      launchLease.assert();
      return result;
    } finally {
      launchLease?.release();
      runLease?.release();
    }
  }

  async function reset(reason) {
    if (typeof reason !== 'string' || !reason.trim()) fail('reset_reason_required');
    let runLease;
    let launchLease;
    try {
      try { runLease = acquire(runTarget); }
      catch (error) { if (error?.code === 'ELOCKED') fail('run_active'); throw error; }
      try { launchLease = acquire(launchTarget); }
      catch (error) { if (error?.code === 'ELOCKED') fail('launch_active'); throw error; }
      await mutate((state) => {
        runLease.assert();
        launchLease.assert();
        state.run = null;
        state.pending = null;
        state.blocked = null;
        // Deliberately do not persist the operator's free-form reason: it may
        // contain credentials, paths or copied native error/command text.
      });
    } finally {
      launchLease?.release();
      runLease?.release();
    }
  }

  function withToolLaunch(name, args, operation) {
    const cost = toolCost(name, args);
    return cost === 0 ? operation() : withLaunch(cost, operation);
  }

  return { withStudioTestRun: withRun, withStudioTestLaunch: withLaunch, withStudioTestToolLaunch: withToolLaunch, withStudioTestMaintenance: withMaintenance, resetStudioTestSafety: reset };
}

function configured(env) {
  return createStudioTestSafety({ root: env?.RSMCP_STUDIO_TEST_SAFETY_DIR });
}

export function withStudioTestRun(env, operation) {
  return configured(env).withStudioTestRun(operation);
}
export function withStudioTestLaunch(env, cost, operation) {
  if (env?.RSMCP_STUDIO_TEST_SAFETY_DIR === undefined) return operation();
  return configured(env).withStudioTestLaunch(cost, operation);
}
export function withStudioTestToolLaunch(name, args, env, operation) {
  if (env?.RSMCP_STUDIO_TEST_SAFETY_DIR === undefined) return operation();
  // Cleanup/status must not even require readable admission storage.
  const cost = toolCost(name, args);
  return cost === 0 ? operation() : configured(env).withStudioTestLaunch(cost, operation);
}
export function resetStudioTestSafety(env, reason) {
  return configured(env).resetStudioTestSafety(reason);
}

export function withStudioTestMaintenance(env, operation) {
  return configured(env).withStudioTestMaintenance(operation);
}
