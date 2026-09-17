#!/usr/bin/env node
// Entirely offline: fixture directories, injected clocks, fake RPC and fetch.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createStudioTestSafety, resetStudioTestSafety, withStudioTestLaunch,
  withStudioTestRun, withStudioTestToolLaunch, withStudioTestMaintenance,
  STUDIO_TEST_LAUNCH_WINDOW_MS as WINDOW,
  STUDIO_TEST_LAUNCH_COST_LIMIT as LIMIT,
} from '../scripts/studio-test-safety.mjs';
import { McpClient } from './lib/mcp-client.mjs';
import { callMcpHttpTool, McpHttpToolError } from './lib/mcp-http-client.mjs';

const directory = mkdtempSync(join(tmpdir(), 'studio-test-safety-'));
const ok = { success: true };
let fixtureId = 0;
function fixture() {
  const root = join(directory, `admission-${fixtureId++}`);
  const clock = { time: 1_000_000, waits: [] };
  const sleep = async (ms) => { clock.waits.push(ms); clock.time += ms; };
  const create = (overrides = {}) => createStudioTestSafety({ root, now: () => clock.time, sleep, onCapacityWait: () => {}, ...overrides });
  const env = { RSMCP_STUDIO_TEST_SAFETY_DIR: root };
  return { root, clock, create, env };
}
function blocked(category) {
  return (error) => error?.name === 'StudioTestSafetyError' && error.category === category;
}
function never() { assert.fail('Blocked operation dispatched'); }
function state(root) { return JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')); }
function replaceState(root, value) { writeFileSync(join(root, 'state.json'), JSON.stringify(value)); }

try {
  // The only filesystem roots used here are fixtures. A sibling sentinel stands
  // in for profile contents that neither admission nor reset may inspect/change.
  const profile = join(directory, 'unrelated-profile');
  mkdirSync(profile);
  writeFileSync(join(profile, 'sentinel'), 'untouched');

  {
    const { create, clock, root } = fixture();
    const initial = clock.time;
    const starts = [];
    const launch = (cost) => create().withStudioTestLaunch(cost, () => { starts.push(clock.time); return ok; });
    await create().withStudioTestRun(async () => {
      await launch(1);
      await launch(1);
      await launch(8);
      assert.deepEqual(clock.waits, [], 'available capacity admits back-to-back requests without sleeping');
      await launch(1);
      await launch(2);
      return 0;
    });
    assert.deepEqual(starts, [initial, initial, initial, initial + WINDOW, initial + WINDOW]);
    assert.deepEqual(clock.waits, [WINDOW]);
    assert.equal(state(root).blocked, null, 'capacity waits do not fail the run or latch');
    assert.equal(state(root).run, null);
  }

  {
    const { create, clock } = fixture();
    const initial = clock.time;
    await create().withStudioTestToolLaunch('multiplayer_playtest', { action: 'start', numPlayers: 2 }, () => ok);
    clock.time = initial + 1000;
    await create().withStudioTestToolLaunch('multiplayer_playtest', { action: 'add_players', numPlayers: 2 }, () => ok);
    clock.time = initial + 2500;
    await create().withStudioTestLaunch(5, () => ok);
    let calls = 0;
    const notices = [];
    await create({ onCapacityWait: (notice) => notices.push(notice) }).withStudioTestToolLaunch('multiplayer_playtest', { action: 'start', numPlayers: 3 }, () => {
      calls += 1;
      assert.equal(clock.time, initial + WINDOW + 1000, 'four processes require both oldest reservations to expire');
      return ok;
    });
    assert.deepEqual(clock.waits, [WINDOW - 1500]);
    assert.deepEqual(notices, [{ cost: 4, available: 0, waitMs: WINDOW - 1500 }]);
    assert.equal(calls, 1, 'capacity waits never retry a dispatched launch');
    await assert.rejects(create().withStudioTestLaunch(LIMIT + 1, never), blocked('invalid_launch_cost'));
    for (const numPlayers of [undefined, null, '2', 0, 9, 1.5, [], {}, NaN]) {
      assert.throws(() => create().withStudioTestToolLaunch('multiplayer_playtest', { action: 'start', numPlayers }, never), blocked('invalid_player_count'));
    }
  }

  // A reservation consumes capacity strictly before expiry, not at or after it.
  for (const offset of [-1, 0, 1]) {
    const { create, clock } = fixture();
    const initial = clock.time;
    await create().withStudioTestLaunch(LIMIT, () => ok);
    clock.time = initial + WINDOW + offset;
    await create().withStudioTestLaunch(1, () => {
      assert.equal(clock.time, initial + WINDOW + Math.max(0, offset));
      return ok;
    });
    assert.deepEqual(clock.waits, offset < 0 ? [-offset] : []);
  }

  // Version 1 ledgers retain their old structural bounds (24 cost), even
  // though only reservations in the new window consume current capacity.
  for (const kind of ['many', 'weighted', 'partly_expired']) {
    const { create, clock, root } = fixture();
    await create().withStudioTestLaunch(1, () => ok);
    const initial = clock.time;
    const reservations = kind === 'many'
      ? Array.from({ length: 24 }, (_, index) => ({ at: initial - (23 - index) * 1000, cost: 1 }))
      : kind === 'weighted' ? [{ at: initial, cost: 24 }]
        : [{ at: initial - WINDOW, cost: 10 }, { at: initial, cost: 14 }];
    replaceState(root, { ...state(root), reservations });
    const expectedWait = kind === 'many' ? WINDOW - 9000 : WINDOW;
    const active = reservations.filter((entry) => initial - entry.at < WINDOW);
    await create({ sleep: async (ms) => {
      assert.equal(ms, expectedWait);
      assert.deepEqual(state(root).reservations, active, 'admission must not discard unexpired legacy cost');
      assert.equal(state(root).pending, null, 'waiting does not reserve or dispatch');
      assert.equal(state(root).blocked, null);
      clock.waits.push(ms);
      clock.time += ms;
    } }).withStudioTestLaunch(1, () => {
      assert.equal(clock.time, initial + expectedWait);
      return ok;
    });
    assert.deepEqual(clock.waits, [expectedWait]);
    assert.deepEqual(state(root).reservations, [
      ...active.filter((entry) => clock.time - entry.at < WINDOW),
      { at: clock.time, cost: 1 },
    ]);
  }

  {
    const { create, clock, root } = fixture();
    await create().withStudioTestLaunch(LIMIT, () => ok);
    replaceState(root, { ...state(root), blocked: 'launch_budget' });
    clock.time += WINDOW;
    await assert.rejects(create().withStudioTestRun(never), blocked('launch_budget'));
    await assert.rejects(create().withStudioTestLaunch(1, never), blocked('launch_budget'));
    assert.equal(state(root).blocked, 'launch_budget', 'legacy failure latches never expire with capacity');
    await create().resetStudioTestSafety('reviewed legacy budget failure');
    await create().withStudioTestLaunch(1, () => ok);
  }

  // The launch lease is released while waiting; every wake must recheck
  // durable failures, pending work, run ownership, and clock monotonicity.
  for (const failure of ['launch_failed', 'pending_launch', 'abandoned_run', 'clock_rollback']) {
    const { create, clock, root } = fixture();
    await create().withStudioTestLaunch(LIMIT, () => ok);
    const reservations = state(root).reservations;
    await assert.rejects(create({ sleep: async (ms) => {
      assert.equal(ms, WINDOW);
      if (failure === 'clock_rollback') clock.time -= 1;
      else {
        const current = state(root);
        if (failure === 'launch_failed') current.blocked = failure;
        else current[failure === 'pending_launch' ? 'pending' : 'run'] = randomUUID();
        replaceState(root, current);
      }
    } }).withStudioTestLaunch(1, never), blocked(failure));
    assert.deepEqual(state(root).reservations, reservations, 'failed wait never reserves another launch');
  }

  // Two independent instances contend on actual lockfiles. No timer advances a
  // blocked callback: the fixture explicitly releases its wait after failure.
  {
    const { create } = fixture();
    const entered = Promise.withResolvers();
    const callback = Promise.withResolvers();
    const sleeping = Promise.withResolvers();
    const wake = Promise.withResolvers();
    let calls = 0;
    const first = create().withStudioTestLaunch(1, async () => {
      calls += 1;
      entered.resolve();
      return callback.promise;
    });
    await entered.promise;
    await assert.rejects(create().resetStudioTestSafety('do not reset live launch'), blocked('launch_active'));
    const second = create({ sleep: () => { sleeping.resolve(); return wake.promise; } }).withStudioTestLaunch(1, never);
    await sleeping.promise;
    const rejection = assert.rejects(second, blocked('launch_failed'));
    callback.resolve({ success: false });
    await first;
    wake.resolve();
    await rejection;
    assert.equal(calls, 1);
  }

  {
    const { create, clock } = fixture();
    const entered = Promise.withResolvers();
    const callback = Promise.withResolvers();
    const sleeping = Promise.withResolvers();
    const wake = Promise.withResolvers();
    const initial = clock.time;
    const first = create().withStudioTestLaunch(LIMIT - 1, async () => { entered.resolve(); return callback.promise; });
    await entered.promise;
    let waitCount = 0;
    const second = create({ sleep: async () => {
      assert.equal(waitCount++, 0, 'only the active lease delays a request with available capacity');
      sleeping.resolve();
      await wake.promise;
    } }).withStudioTestLaunch(1, () => {
      assert.equal(clock.time, initial);
      return ok;
    });
    await sleeping.promise;
    callback.resolve(ok);
    await first;
    wake.resolve();
    assert.equal(await second, ok);
    await create().withStudioTestLaunch(1, () => {
      assert.equal(clock.time, initial + WINDOW);
      return ok;
    });
  }

  {
    const { create, root, clock } = fixture();
    const secretError = new Error('fixture-secret-command');
    let calls = 0;
    await assert.rejects(create().withStudioTestLaunch(LIMIT, () => { calls += 1; throw secretError; }), (error) => error === secretError);
    await assert.rejects(create().withStudioTestLaunch(1, never), blocked('launch_unknown'));
    await assert.rejects(create().withStudioTestRun(never), blocked('launch_unknown'));
    await assert.rejects(create().resetStudioTestSafety('  '), blocked('reset_reason_required'));
    await create().resetStudioTestSafety('fixture-secret-reset');
    await create().withStudioTestLaunch(1, () => ok);
    assert.deepEqual(clock.waits, [WINDOW], 'reviewed reset does not refund the failed reservation');
    assert.equal(calls, 1);
    assert.ok(!readFileSync(join(root, 'state.json'), 'utf8').includes('fixture-secret'));
  }

  {
    const { create, clock } = fixture();
    await create().withStudioTestLaunch(1, () => ({ success: false }));
    await create().resetStudioTestSafety('retry only after operator recovery');
    const before = clock.time;
    await create().withStudioTestLaunch(1, () => ok);
    assert.equal(clock.time, before, 'reviewed reset adds no delay when capacity is available');
    assert.deepEqual(clock.waits, []);
  }

  for (const outcome of [7, undefined, '0']) {
    const { create } = fixture();
    if (typeof outcome === 'number') assert.equal(await create().withStudioTestRun(() => outcome), outcome);
    else await assert.rejects(create().withStudioTestRun(() => outcome), blocked('run_unknown'));
    await assert.rejects(create().withStudioTestRun(never), blocked(typeof outcome === 'number' ? 'run_failed' : 'run_unknown'));
    await create().resetStudioTestSafety('investigated failure');
    assert.equal(await create().withStudioTestRun(() => 0), 0);
  }

  {
    const { create } = fixture();
    const original = new Error('fixture-secret-run');
    await assert.rejects(create().withStudioTestRun(() => { throw original; }), (error) => error === original);
    await assert.rejects(create().withStudioTestRun(never), blocked('run_failed'));
  }

  {
    const { create } = fixture();
    const entered = Promise.withResolvers();
    const finish = Promise.withResolvers();
    const run = create().withStudioTestRun(async () => { entered.resolve(); return finish.promise; });
    await entered.promise;
    await assert.rejects(create().withStudioTestRun(never), blocked('run_active'));
    await assert.rejects(create().resetStudioTestSafety('must not reset live run'), blocked('run_active'));
    // A child transport instance sharing only the root can reserve within a run.
    await create().withStudioTestLaunch(1, () => ok);
    finish.resolve(0);
    assert.equal(await run, 0);
    assert.equal(await create().withStudioTestRun(() => 0), 0);
  }

  for (const marker of ['run', 'pending']) {
    const { create, root } = fixture();
    await create().withStudioTestLaunch(1, () => ok);
    replaceState(root, { ...state(root), [marker]: randomUUID() });
    await assert.rejects(create().withStudioTestRun(never), blocked(marker === 'run' ? 'abandoned_run' : 'pending_launch'));
    await assert.rejects(create().withStudioTestLaunch(1, never), blocked(marker === 'run' ? 'abandoned_run' : 'pending_launch'));
    await create().resetStudioTestSafety('confirmed abandoned callback');
    await create().withStudioTestLaunch(1, () => ok);
  }

  {
    const { create, root, clock } = fixture();
    await create().withStudioTestLaunch(1, () => ok);
    clock.time -= 1;
    await assert.rejects(create().withStudioTestLaunch(1, never), blocked('clock_rollback'));
    clock.time += 1;
    await assert.rejects(create().withStudioTestLaunch(1, never), blocked('clock_rollback'));
    await create().resetStudioTestSafety('clock repaired');
    writeFileSync(join(root, 'state.json'), '{broken');
    await assert.rejects(create().withStudioTestLaunch(1, never), blocked('corrupt_state'));
    await assert.rejects(create().resetStudioTestSafety('cannot erase unknown quota'), blocked('corrupt_state'));
  }

  {
    const { create, root } = fixture();
    await create().withStudioTestLaunch(1, () => ok);
    rmSync(join(root, 'state.json'));
    await assert.rejects(create().withStudioTestLaunch(1, never), blocked('missing_state'));
    for (const [name, action] of [['manage_instance', 'close'], ['manage_instance', 'status'], ['multiplayer_playtest', 'end'], ['solo_playtest', 'stop']]) {
      assert.equal(await create().withStudioTestToolLaunch(name, { action }, () => ok), ok);
    }
  }

  {
    const { create, root } = fixture();
    writeFileSync(root, 'not a directory');
    await assert.rejects(create().withStudioTestLaunch(1, never), (error) => error.code === 'EEXIST' || error.code === 'ENOTDIR');
  }

  {
    const { create } = fixture();
    await assert.rejects(create().withStudioTestRun(async () => {
      await create().withStudioTestLaunch(1, () => ({ success: false }));
      return 0;
    }), blocked('launch_failed'));
    await assert.rejects(create().withStudioTestRun(never), blocked('launch_failed'));
  }

  for (const unknown of [undefined, null, 'unparseable', {}, { content: [{ type: 'text', text: 'bad-json' }] }]) {
    const { create } = fixture();
    assert.equal(await create().withStudioTestLaunch(1, () => unknown), unknown);
    await assert.rejects(create().withStudioTestLaunch(1, never), blocked('launch_unknown'));
  }

  assert.equal(withStudioTestLaunch({}, 1, () => ok), ok);
  assert.equal(withStudioTestToolLaunch('multiplayer_playtest', { action: 'start' }, {}, () => ok), ok);
  assert.throws(() => withStudioTestRun({}, never), blocked('missing_absolute_root'));
  assert.throws(() => resetStudioTestSafety({}, 'reason'), blocked('missing_absolute_root'));
  assert.equal(withStudioTestToolLaunch('manage_instance', { action: 'close' }, { RSMCP_STUDIO_TEST_SAFETY_DIR: 'invalid' }, () => ok), ok);

  // Actual stdio seam, including expected-error calls, with no child process.
  {
    const { env } = fixture();
    const client = new McpClient('offline-safety', { env });
    let calls = 0;
    client.rpc = async () => {
      calls += 1;
      return { isError: true, content: [{ type: 'text', text: '{"error":"expected fixture rejection"}' }] };
    };
    assert.deepEqual(await client.callToolError('manage_instance', { action: 'launch' }), { error: 'expected fixture rejection' });
    await assert.rejects(client.callToolResult('manage_instance', { action: 'launch' }), blocked('launch_failed'));
    assert.equal(calls, 1);
    // Status rejection is intentional in the auto-install mismatch fixture;
    // cleanup and its original parser/error behavior remain available.
    assert.deepEqual(await client.callToolError('manage_instance', { action: 'status' }), { error: 'expected fixture rejection' });
    assert.equal(calls, 2);
  }

  {
    const { env } = fixture();
    const client = new McpClient('offline-expected-mismatch', { env });
    client.rpc = async () => ({ content: [{ type: 'text', text: '{"state":"failed","error":"plugin-version-rejected"}' }] });
    assert.equal((await client.callToolResult('manage_instance', { action: 'status' })).body.state, 'failed');
    client.rpc = async () => ({ content: [{ type: 'text', text: '{"launch_id":"fixture-repaired"}' }] });
    assert.deepEqual(await client.callTool('manage_instance', { action: 'launch' }), { launch_id: 'fixture-repaired' });
  }

  {
    const { env, root } = fixture();
    const client = new McpClient('offline-soft-failure', { env });
    const dispatched = [];
    const options = { onDispatch() {
      assert.notEqual(state(root).pending, null, 'dispatch timing starts after durable admission');
      dispatched.push('timing');
    } };
    client.rpc = async () => {
      dispatched.push('rpc');
      return { content: [{ type: 'text', text: '{"success":false}' }] };
    };
    assert.deepEqual(await client.callToolResult('multiplayer_playtest', { action: 'start', numPlayers: 1 }, 30_000, options), { body: { success: false }, isError: false });
    await assert.rejects(client.callTool('manage_instance', { action: 'launch' }, 30_000, options), blocked('launch_failed'));
    assert.deepEqual(dispatched, ['timing', 'rpc'], 'blocked attempts never start the latency clock or RPC');
  }

  {
    const { env } = fixture();
    const client = new McpClient('offline-parser-failure', { env });
    client.rpc = async () => ({});
    await assert.rejects(client.callToolResult('manage_instance', { action: 'launch' }), /returned no text content/);
    await assert.rejects(client.callToolResult('manage_instance', { action: 'launch' }), blocked('launch_unknown'));
  }

  // Actual HTTP seam: timer creation and network dispatch occur only after
  // admission. Replace the timeout factory as well as fetch; no real timers.
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  try {
    let requests = 0;
    let timers = 0;
    AbortSignal.timeout = () => { timers += 1; return new AbortController().signal; };
    globalThis.fetch = async () => {
      requests += 1;
      return { ok: true, status: 200, text: async () => '{"success":false}' };
    };
    const { env } = fixture();
    const options = { port: 12345, env: { ...env, ROBLOX_STUDIO_NO_AUTH: '1' } };
    assert.deepEqual(await callMcpHttpTool('multiplayer_playtest', { action: 'start', numPlayers: 1 }, options), { success: false });
    await assert.rejects(callMcpHttpTool('manage_instance', { action: 'launch' }, options), blocked('launch_failed'));
    assert.equal(requests, 1);
    assert.equal(timers, 1);
    await callMcpHttpTool('manage_instance', { action: 'close' }, options);
    assert.equal(requests, 2);

    const rejected = fixture();
    globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => '{"error":"offline refusal"}' });
    const rejectOptions = { port: 12345, env: { ...rejected.env, ROBLOX_STUDIO_NO_AUTH: '1' } };
    await assert.rejects(callMcpHttpTool('manage_instance', { action: 'launch' }, rejectOptions), (error) => error instanceof McpHttpToolError && error.responseReceived && error.status === 503 && error.body.error === 'offline refusal');
    await assert.rejects(callMcpHttpTool('manage_instance', { action: 'launch' }, rejectOptions), blocked('launch_unknown'));

    const wrapped = fixture();
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ content: [{ type: 'text', text: '{"success":false}' }] }),
    });
    const wrappedOptions = { port: 12345, env: { ...wrapped.env, ROBLOX_STUDIO_NO_AUTH: '1' } };
    await callMcpHttpTool('multiplayer_playtest', { action: 'add_players', numPlayers: 1 }, wrappedOptions);
    await assert.rejects(callMcpHttpTool('manage_instance', { action: 'launch' }, wrappedOptions), blocked('launch_failed'));

    const malformed = fixture();
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => 'not-json' });
    const malformedOptions = { port: 12345, env: { ...malformed.env, ROBLOX_STUDIO_NO_AUTH: '1' } };
    await assert.rejects(callMcpHttpTool('manage_instance', { action: 'launch' }, malformedOptions), (error) => error instanceof McpHttpToolError && error.responseReceived && error.status === 200);
    await assert.rejects(callMcpHttpTool('manage_instance', { action: 'launch' }, malformedOptions), blocked('launch_unknown'));
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  }

  {
    const { root, create, env, clock } = fixture();
    await assert.rejects(create().withStudioTestRun(async () => {
      await create().withStudioTestLaunch(LIMIT, () => { throw new Error('interrupted launch'); });
      return 0;
    }));
    const before = readFileSync(join(root, 'state.json'), 'utf8');
    clock.time += WINDOW;
    assert.equal(await create().withStudioTestMaintenance(() => 'repaired'), 'repaired');
    assert.equal(readFileSync(join(root, 'state.json'), 'utf8'), before, 'maintenance preserves failure, abandoned run, pending launch, quota and clock byte-for-byte');
    await assert.rejects(withStudioTestMaintenance(env, () => { throw new Error('repair failed'); }), /repair failed/);
    assert.equal(readFileSync(join(root, 'state.json'), 'utf8'), before);
  }

  for (const kind of ['run', 'launch', 'maintenance']) {
    const { create } = fixture();
    const entered = Promise.withResolvers();
    const finish = Promise.withResolvers();
    const operation = async () => { entered.resolve(); await finish.promise; return kind === 'launch' ? ok : 0; };
    const active = kind === 'run' ? create().withStudioTestRun(operation)
      : kind === 'launch' ? create().withStudioTestLaunch(1, operation)
        : create().withStudioTestMaintenance(operation);
    await entered.promise;
    await assert.rejects(create().withStudioTestMaintenance(never), blocked(kind === 'launch' ? 'launch_active' : 'run_active'));
    if (kind === 'maintenance') {
      await assert.rejects(create().withStudioTestRun(never), blocked('run_active'));
      await assert.rejects(create().resetStudioTestSafety('cannot reset during repair'), blocked('run_active'));
    }
    finish.resolve();
    await active;
  }

  assert.deepEqual(readdirSync(profile), ['sentinel']);
  assert.equal(readFileSync(join(profile, 'sentinel'), 'utf8'), 'untouched');
  console.log('Studio test safety offline regressions passed');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
