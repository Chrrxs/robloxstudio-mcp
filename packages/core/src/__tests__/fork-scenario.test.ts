import { runScenarioTool } from '../fork/scenario.js';
import { luaString, moveCode, spawnCode } from '../fork/scenario-luau.js';
import { MAX_SCREENSHOTS, runScenario, validateSteps, type LoadedScenario, type ScenarioDriver } from '../fork/scenario-runner.js';
import type { RobloxStudioTools } from '../tools/index.js';

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

/** A driver that records every call and fails where told to. */
function fakeDriver(overrides: Partial<ScenarioDriver> = {}) {
  const calls: string[] = [];
  let clock = 1_000_000;
  const driver: ScenarioDriver = {
    start: async (players) => { calls.push(`start ${players}`); clock += 3000; return {}; },
    stop: async (players) => { calls.push(`stop ${players}`); clock += 1000; return {}; },
    eval: async (role, code) => {
      calls.push(`eval ${role}`);
      clock += 200;
      if (code.includes('LocalPlayer.UserId') && !code.includes('MoveTo')) return { ok: true, value: role === 'client-1' ? '-1' : '-2' };
      return { ok: true, value: code.includes('MoveTo') ? '2.9' : 'true' };
    },
    waitFor: async (role, expr) => { calls.push(`waitFor ${role} ${expr}`); clock += 500; return { ok: true, elapsed: 0.5, value: 'true' }; },
    press: async (role, key) => { calls.push(`press ${role} ${key}`); clock += 100; return {}; },
    screenshot: async (role) => { calls.push(`screenshot ${role}`); return { image: { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }, note: '512x288 scale=0.4 origin=0,0' }; },
    recentLogs: async (role) => { calls.push(`logs ${role}`); return [`12:00:00.0 ${role} ERR Door script: attempt to index nil`]; },
    sleep: async (seconds) => { calls.push(`sleep ${seconds}`); clock += seconds * 1000; },
    now: () => clock,
    ...overrides,
  };
  return { driver, calls };
}

const EIGHT_STEPS: LoadedScenario = {
  name: 'DoorOpens',
  players: 2,
  steps: [
    { type: 'spawn', player: 1, at: 'Workspace.Spawns.A' },
    { type: 'spawn', player: 2, at: { x: 10, y: 5, z: 0 } },
    { type: 'move', player: 1, to: 'Workspace.Door' },
    { type: 'press', player: 1, key: 'E' },
    { type: 'wait_for', expr: 'workspace.Door:GetAttribute("Open")', timeout: 5 },
    { type: 'assert', target: 'client-2', expr: 'workspace.Door.Transparency > 0.5' },
    { type: 'wait', seconds: 0.5 },
    { type: 'screenshot', target: 'client-1', crop: 'Workspace.Door', label: 'open door' },
  ],
};

describe('run_scenario runner', () => {
  test('an 8-step multiplayer run passes in one compact report', async () => {
    const { driver, calls } = fakeDriver();
    const outcome = await runScenario(driver, EIGHT_STEPS, { timeoutSeconds: 120 });
    const report = outcome.lines.join('\n');
    expect(outcome.passed).toBe(true);
    expect(outcome.lines[0]).toMatch(/^start multiplayer 2 players ok \d+\.\ds$/);
    expect(outcome.lines.at(-2)).toMatch(/^stop ok/);
    expect(outcome.lines.at(-1)).toMatch(/^PASS 8\/8 in \d+\.\ds$/);
    expect(report).toContain('3 move player=1 to=Workspace.Door ok 0.2s within 2.9 studs');
    expect(report).toContain('5 wait_for server `workspace.Door:GetAttribute("Open")` ok 0.5s value=true');
    expect(report).toContain('8 screenshot client-1 "open door" ok 0.0s image 1 512x288 scale=0.4 origin=0,0');
    expect(outcome.images).toHaveLength(1);
    expect(calls).toContain('waitFor client-2 workspace.Door.Transparency > 0.5');
    expect(calls.filter((call) => call.startsWith('stop'))).toEqual(['stop 2']);
    expect(bytes(report)).toBeLessThanOrEqual(1536);
  });

  test('a failing step stops the run, reads that peer\'s logs before stopping, and reports FAIL', async () => {
    const { driver, calls } = fakeDriver({
      waitFor: async () => ({ ok: false, elapsed: 5, value: 'nil' }),
      recentLogs: async (role) => {
        calls.push(`logs ${role}`);
        return Array.from({ length: 12 }, (_, i) => `12:00:0${i % 10}.0 ${role} ERR ${'x'.repeat(300)} ${i}`);
      },
    });
    const outcome = await runScenario(driver, EIGHT_STEPS, { timeoutSeconds: 120 });
    const report = outcome.lines.join('\n');
    expect(outcome.passed).toBe(false);
    expect(report).toContain('5 wait_for server `workspace.Door:GetAttribute("Open")` FAIL');
    expect(report).toContain('timed out, last=nil');
    expect(report).not.toMatch(/^6 /m);
    expect(calls.indexOf('logs server')).toBeLessThan(calls.indexOf('stop 2'));
    const failLine = outcome.lines.findIndex((line) => line.startsWith('FAIL at step 5 (wait_for)'));
    expect(failLine).toBeGreaterThan(0);
    const logLines = outcome.lines.slice(failLine + 1);
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.length).toBeLessThanOrEqual(5);
    expect(bytes(logLines.join('\n'))).toBeLessThanOrEqual(1024);
  });

  test('the playtest is stopped even when a step throws', async () => {
    const { driver, calls } = fakeDriver({ press: async () => { throw new Error('bridge closed'); } });
    const outcome = await runScenario(driver, EIGHT_STEPS, { timeoutSeconds: 120 });
    expect(outcome.passed).toBe(false);
    expect(outcome.lines).toContain('ERROR bridge closed');
    expect(calls.filter((call) => call.startsWith('stop'))).toEqual(['stop 2']);
  });

  test('a failed start does not stop anything', async () => {
    const { driver, calls } = fakeDriver({ start: async () => ({ error: 'Playtest already running.' }) });
    const outcome = await runScenario(driver, { name: 's', players: 1, steps: [{ type: 'wait', seconds: 1 }] }, { timeoutSeconds: 10 });
    expect(outcome.lines[0]).toMatch(/^start solo play FAIL .*Playtest already running/);
    expect(outcome.lines.at(-1)).toMatch(/^FAIL at start/);
    expect(calls.some((call) => call.startsWith('stop'))).toBe(false);
  });

  test('screenshots are capped per run, and cancellation stops between steps', async () => {
    const shots = Array.from({ length: MAX_SCREENSHOTS + 2 }, () => ({ type: 'screenshot' }));
    const { driver } = fakeDriver();
    const outcome = await runScenario(driver, { name: 's', players: 1, steps: shots }, { timeoutSeconds: 60 });
    expect(outcome.images).toHaveLength(MAX_SCREENSHOTS);
    expect(outcome.lines.filter((line) => line.includes('skipped (max 4 per run)'))).toHaveLength(2);

    const controller = new AbortController();
    const cancelling = fakeDriver({ sleep: async () => { controller.abort(); } });
    const cancelled = await runScenario(cancelling.driver, { name: 's', players: 1, steps: [{ type: 'wait', seconds: 1 }, { type: 'wait', seconds: 1 }] }, { timeoutSeconds: 60, signal: controller.signal });
    expect(cancelled.lines).toContain('2 wait 1s CANCELLED');
    expect(cancelling.calls.filter((call) => call.startsWith('stop'))).toHaveLength(1);
  });

  test('every step is validated before the playtest starts', () => {
    const scenario = (steps: Array<Record<string, unknown>>, players = 1): LoadedScenario => ({ name: 's', players, steps });
    expect(validateSteps(scenario([{ type: 'jump' }]))).toMatch(/^INVALID step 1 \(jump\): unknown type/);
    expect(validateSteps(scenario([{ type: 'press', player: 2, key: 'E' }]))).toMatch(/player must be 1-1/);
    expect(validateSteps(scenario([{ type: 'press', player: 1 }]))).toMatch(/needs key/);
    expect(validateSteps(scenario([{ type: 'assert', target: 'client-3', expr: 'true' }], 2))).toMatch(/client-3 does not exist with 2 player/);
    expect(validateSteps(scenario([{ type: 'wait' }]))).toMatch(/needs seconds/);
    expect(validateSteps(scenario([{ type: 'screenshot', target: 'server' }]))).toMatch(/server renders nothing/);
    expect(validateSteps(scenario([{ type: 'spawn', at: 'Workspace.A' }]))).toEqual([{ type: 'spawn', player: 1, at: 'Workspace.A' }]);
  });
});

describe('scenario Luau', () => {
  test('strings are escaped as Luau literals', () => {
    expect(luaString('a"b\\c\nd\u0001')).toBe('"a\\"b\\\\c\\nd\\1"');
  });

  test('spawn targets the mapped player and lifts them above the spawn point', () => {
    const code = spawnCode(-2, 2, 'Workspace.Spawns.B', 15);
    expect(code).toContain('GetPlayerByUserId(-2)');
    expect(code).toContain('__resolve("Workspace.Spawns.B"):GetPivot()');
    expect(code).toContain('+ Vector3.new(0, 3, 0)');
  });

  test('move waits for MoveToFinished with a deadline', () => {
    const code = moveCode({ x: 1, y: 2, z: 3 }, 8);
    expect(code).toContain('CFrame.new(1, 2, 3)');
    expect(code).toContain('MoveToFinished');
    expect(code).toContain('os.clock() + 8');
  });
});

describe('run_scenario tool', () => {
  function fakeTools(loaded: unknown) {
    const calls: Array<{ endpoint: string; data: Record<string, unknown>; role: unknown }> = [];
    const tools = {
      forkBridge: () => ({
        refreshTopology: () => undefined,
        callSingle: async (endpoint: string, data: Record<string, unknown>, role: unknown) => {
          calls.push({ endpoint, data, role });
          return loaded;
        },
      }),
    } as unknown as RobloxStudioTools;
    return { tools, calls };
  }

  test('loads by name from the container in the edit peer and runs it', async () => {
    const { tools, calls } = fakeTools({ name: 'Smoke', players: 1, steps: [{ type: 'wait', seconds: 0 }] });
    const { driver } = fakeDriver();
    const result = await runScenarioTool(tools, { name: 'Smoke', params: { level: 2 } }, undefined, driver);
    expect(calls[0]).toEqual({
      endpoint: '/api/fork/load-scenario',
      data: { name: 'Smoke', source: undefined, params: { level: 2 }, container: 'ServerStorage.Scenarios' },
      role: 'edit',
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text.split('\n')[0]).toBe('scenario Smoke (1 player)');
    expect(text).toMatch(/PASS 1\/1/);
  });

  test('argument and load errors are one line', async () => {
    const { tools } = fakeTools({ error: 'no ModuleScript "Nope" in ServerStorage.Scenarios (found: Smoke)' });
    const textOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content[0].text;
    expect(textOf(await runScenarioTool(tools, {}))).toBe('ERROR pass exactly one of name or source.');
    expect(textOf(await runScenarioTool(tools, { name: 'a', source: 'b' }))).toBe('ERROR pass exactly one of name or source.');
    expect(textOf(await runScenarioTool(tools, { name: 'a', params: [1] }))).toBe('ERROR params must be an object.');
    expect(textOf(await runScenarioTool(tools, { name: 'a', timeout: 0 }))).toMatch(/timeout must be/);
    expect(textOf(await runScenarioTool(tools, { name: 'Nope' }))).toBe('ERROR no ModuleScript "Nope" in ServerStorage.Scenarios (found: Smoke)');
  });
});
