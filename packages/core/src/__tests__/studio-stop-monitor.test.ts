import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { build, type Plugin } from 'esbuild';

type Role = 'edit' | 'server';

interface PluginSettings {
  GetSetting(key: string): unknown;
  SetSetting(key: string, value: unknown): void;
}

interface StopConsumption {
  ok: boolean;
  consumed: boolean;
  error?: string;
}

interface StopMonitor {
  init(plugin: PluginSettings): void;
  requestStop(): { ok: boolean; requestId?: string };
  waitForConsumption(requestId: string): StopConsumption;
  startMonitor(lifecycle: { beforeEndTest(): void; afterEndTestFailure(): void }): void;
  clearPending(requestId?: string): void;
}

interface SettingAccess {
  role: Role;
  key: string;
  value: unknown;
}

interface SettingsFaults {
  dropWrite?: (access: SettingAccess) => boolean;
  nilRead?: (access: SettingAccess) => boolean;
}

interface ScheduledMonitor {
  callback: () => void;
  at: number;
}

interface Payload {
  kind: string;
  id: string;
}

function payload(value: unknown): Payload | undefined {
  if (typeof value !== 'string') return undefined;
  const decoded: unknown = JSON.parse(value);
  if (decoded === null || typeof decoded !== 'object') return undefined;
  if (!('kind' in decoded) || typeof decoded.kind !== 'string') return undefined;
  if (!('id' in decoded) || typeof decoded.id !== 'string') return undefined;
  return { kind: decoded.kind, id: decoded.id };
}

const dependencies: Plugin = {
  name: 'studio-stop-monitor-dependencies',
  setup(builder) {
    builder.onResolve({ filter: /^@rbxts\/services$/ }, () => ({ path: 'services', namespace: 'stop-monitor' }));
    builder.onResolve({ filter: /^\.\/PluginSession$/ }, () => ({ path: 'session', namespace: 'stop-monitor' }));
    builder.onLoad({ filter: /.*/, namespace: 'stop-monitor' }, (args) => ({
      contents: args.path === 'services'
        ? 'module.exports = globalThis.stopServices;'
        : 'export default globalThis.stopSession;',
      loader: 'js',
    }));
  },
};

let source: string;

beforeAll(async () => {
  const root = fs.existsSync(path.join(process.cwd(), 'studio-plugin')) ? process.cwd() : path.resolve(process.cwd(), '../..');
  const result = await build({
    entryPoints: [path.join(root, 'studio-plugin/src/modules/StopPlayMonitor.ts')],
    bundle: true, write: false, platform: 'node', format: 'cjs', plugins: [dependencies],
  });
  source = result.outputFiles[0].text;
});

function createHarness(faults: SettingsFaults = {}) {
  const settings = new Map<string, unknown>();
  const writes: SettingAccess[] = [];
  const scheduled: ScheduledMonitor[] = [];
  const suspended = Symbol('monitor suspended');
  let activeMonitor: ScheduledMonitor | undefined;
  let now = 100;
  let nextGuid = 0;

  function advance(seconds: number): void {
    const target = Math.round((now + seconds) * 1000) / 1000;
    let turns = 0;
    for (;;) {
      scheduled.sort((left, right) => left.at - right.at);
      if (scheduled.length === 0 || scheduled[0].at > target) break;
      if (++turns > 1000) throw new Error('Monitor did not yield a positive polling interval');
      const monitor = scheduled.shift()!;
      now = monitor.at;
      activeMonitor = monitor;
      try { monitor.callback(); }
      catch (error) { if (error !== suspended) throw error; }
      finally { activeMonitor = undefined; }
    }
    now = target;
  }

  function load(role: Role, instanceId = 'studio-a') {
    let running = true;
    const events: string[] = [];
    const endTest = jest.fn(() => { events.push('end'); });
    const lifecycle = {
      beforeEndTest: jest.fn(() => { events.push('close'); }),
      afterEndTestFailure: jest.fn(() => { events.push('restore'); }),
    };
    const commonJsModule = { exports: {} as unknown };
    const context = vm.createContext({
      module: commonJsModule,
      exports: commonJsModule.exports,
      stopSession: { getInstanceId: () => instanceId },
      stopServices: {
        HttpService: {
          GenerateGUID: () => `stop-${++nextGuid}`,
          JSONEncode: JSON.stringify,
          JSONDecode: JSON.parse,
        },
        RunService: { IsRunning: () => role === 'server', IsServer: () => role === 'server' },
      },
      game: { GetService: () => ({ EndTest: endTest }) },
      tick: () => now,
      tostring: String,
      typeIs: (value: unknown, type: string) => type === 'table'
        ? value !== null && typeof value === 'object'
        : typeof value === type,
      pcall: (callback: () => unknown): [boolean, unknown] => {
        try { return [true, callback()]; }
        catch (error) {
          if (error === suspended) throw error;
          return [false, error];
        }
      },
      warn: () => undefined,
      task: {
        spawn: (callback: () => void) => {
          scheduled.push({ callback: () => { if (running) callback(); }, at: now });
        },
        wait: (seconds: number) => {
          if (role === 'edit') {
            if (seconds <= 0) throw new Error('Consumption wait must advance the clock');
            advance(seconds);
            if (now > 130) throw new Error('Stop acknowledgement wait exceeded its bound');
            return;
          }
          if (activeMonitor === undefined) throw new Error('Server wait outside monitor');
          if (!running) throw suspended;
          // A synchronous JS VM cannot resume a Luau coroutine. Re-enter only the
          // spawned polling loop on its next tick; all module state stays alive.
          scheduled.push({ callback: activeMonitor.callback, at: Math.round((now + seconds) * 1000) / 1000 });
          throw suspended;
        },
      },
    });
    vm.runInContext(source, context);
    // esbuild emits this repository-owned export as CommonJS (or a default wrapper).
    const loaded = commonJsModule.exports as StopMonitor & { default?: StopMonitor };
    const monitor = loaded.default ?? loaded;
    monitor.init({
      GetSetting: key => {
        const access = { role, key, value: settings.get(key) };
        return faults.nilRead?.(access) ? undefined : access.value;
      },
      SetSetting: (key, value) => {
        const access = { role, key, value };
        writes.push(access);
        // Silent settings failure returns normally but leaves persisted state unchanged.
        if (!faults.dropWrite?.(access)) settings.set(key, value);
      },
    });
    return {
      monitor, endTest, lifecycle, events,
      start: () => monitor.startMonitor(lifecycle),
      stop: () => { running = false; },
    };
  }

  return { load, advance, writes, get now() { return now; } };
}

function request(monitor: StopMonitor): string {
  const result = monitor.requestStop();
  expect(result.ok).toBe(true);
  if (result.requestId === undefined) throw new Error('Stop request has no id');
  return result.requestId;
}

function expectTimeout(result: StopConsumption, elapsed: number): void {
  expect(result).toMatchObject({ ok: false, consumed: false });
  expect(result.error).toMatch(/timed out/i);
  expect(elapsed).toBeGreaterThanOrEqual(8);
  expect(elapsed).toBeLessThanOrEqual(8.1);
}

describe('Studio stop monitor settings delivery', () => {
  test('recovers a silently lost first request write within eight seconds using the same request id', () => {
    let dropped = false;
    const harness = createHarness({
      dropWrite: access => {
        if (!dropped && access.role === 'edit' && payload(access.value)?.kind === 'request') {
          dropped = true;
          return true;
        }
        return false;
      },
    });
    const edit = harness.load('edit');
    const server = harness.load('server');
    server.start();
    const started = harness.now;
    const id = request(edit.monitor);

    expect(edit.monitor.waitForConsumption(id)).toMatchObject({ ok: true, consumed: true });
    expect(harness.now - started).toBeLessThanOrEqual(8);
    expect(server.endTest).toHaveBeenCalledTimes(1);
    const deliveredIds = harness.writes
      .filter(access => access.role === 'edit')
      .map(access => payload(access.value))
      .filter(value => value?.kind === 'request')
      .map(value => value!.id);
    expect(deliveredIds.length).toBeGreaterThanOrEqual(2);
    expect(new Set(deliveredIds)).toEqual(new Set([id]));
  });

  test('waits through transient nil settings reads rather than failing prematurely', () => {
    let reads = 0;
    const harness = createHarness({ nilRead: access => access.role === 'edit' && ++reads <= 4 });
    const edit = harness.load('edit');
    const server = harness.load('server');
    server.start();
    const id = request(edit.monitor);

    expect(edit.monitor.waitForConsumption(id)).toMatchObject({ ok: true, consumed: true });
    expect(reads).toBeGreaterThan(4);
    expect(server.endTest).toHaveBeenCalledTimes(1);
  });

  test('successful delivery closes transport and invokes EndTest exactly once', () => {
    const harness = createHarness();
    const edit = harness.load('edit');
    const server = harness.load('server');
    server.start();

    expect(edit.monitor.waitForConsumption(request(edit.monitor))).toMatchObject({ ok: true, consumed: true });
    harness.advance(3);
    expect(server.endTest).toHaveBeenCalledTimes(1);
    expect(server.endTest).toHaveBeenCalledWith('stopped_by_mcp');
    expect(server.events).toEqual(['close', 'end']);
  });

  test('repeated delivery after a lost acknowledgement preserves success without invoking EndTest again', () => {
    let dropped = false;
    const harness = createHarness({
      dropWrite: access => {
        if (!dropped && access.role === 'server' && payload(access.value)?.kind === 'result') {
          dropped = true;
          return true;
        }
        return false;
      },
    });
    const edit = harness.load('edit');
    const server = harness.load('server');
    server.start();

    expect(edit.monitor.waitForConsumption(request(edit.monitor))).toMatchObject({ ok: true, consumed: true });
    expect(dropped).toBe(true);
    expect(server.endTest).toHaveBeenCalledTimes(1);
    expect(server.events).toEqual(['close', 'end']);
  });

  test('preserves a persisted acknowledgement through prolonged nil reads after the server exits', () => {
    const faults: SettingsFaults = {};
    const harness = createHarness(faults);
    const edit = harness.load('edit');
    const server = harness.load('server');
    server.endTest.mockImplementationOnce(() => {
      server.events.push('end');
      server.stop();
    });
    server.start();
    const started = harness.now;
    faults.nilRead = access => access.role === 'edit'
      && payload(access.value)?.kind === 'result'
      && harness.now - started < 1.5;

    expect(edit.monitor.waitForConsumption(request(edit.monitor))).toMatchObject({ ok: true, consumed: true });
    expect(harness.now - started).toBeGreaterThanOrEqual(1.5);
    expect(harness.now - started).toBeLessThanOrEqual(8);
    expect(server.endTest).toHaveBeenCalledTimes(1);
    expect(server.events).toEqual(['close', 'end']);
  });

  test('reports genuine EndTest failure, restores transport, and permits a fresh stop request', () => {
    const harness = createHarness();
    const edit = harness.load('edit');
    const server = harness.load('server');
    server.endTest.mockImplementationOnce(() => {
      server.events.push('end');
      throw new Error('teardown denied');
    });
    server.start();

    const failure = edit.monitor.waitForConsumption(request(edit.monitor));
    expect(failure).toMatchObject({ ok: false, consumed: true });
    expect(failure.error).toContain('teardown denied');
    expect(server.events).toEqual(['close', 'end', 'restore']);
    expect(edit.monitor.waitForConsumption(request(edit.monitor))).toMatchObject({ ok: true, consumed: true });
    expect(server.endTest).toHaveBeenCalledTimes(2);
    expect(server.events).toEqual(['close', 'end', 'restore', 'close', 'end']);
  });

  test('replays a lost EndTest failure acknowledgement without retrying EndTest', () => {
    let dropped = false;
    const harness = createHarness({
      dropWrite: access => {
        if (!dropped && access.role === 'server' && payload(access.value)?.kind === 'result') {
          dropped = true;
          return true;
        }
        return false;
      },
    });
    const edit = harness.load('edit');
    const server = harness.load('server');
    server.endTest.mockImplementationOnce(() => {
      server.events.push('end');
      throw new Error('teardown denied');
    });
    server.start();

    const failure = edit.monitor.waitForConsumption(request(edit.monitor));
    expect(failure).toMatchObject({ ok: false, consumed: true });
    expect(failure.error).toContain('teardown denied');
    expect(dropped).toBe(true);
    expect(server.endTest).toHaveBeenCalledTimes(1);
    expect(server.events).toEqual(['close', 'end', 'restore']);
  });

  test.each(['no server', 'permanent write loss'])('%s produces a bounded acknowledgement timeout', failure => {
    const harness = createHarness({ dropWrite: () => failure === 'permanent write loss' });
    const edit = harness.load('edit');
    const server = harness.load('server');
    if (failure !== 'no server') server.start();
    const started = harness.now;

    expectTimeout(edit.monitor.waitForConsumption(request(edit.monitor)), harness.now - started);
    expect(server.endTest).not.toHaveBeenCalled();
  });

  test('a server from a foreign Studio instance cannot consume the stop request', () => {
    const harness = createHarness();
    const edit = harness.load('edit', 'studio-a');
    const foreign = harness.load('server', 'studio-b');
    foreign.start();
    const started = harness.now;

    expectTimeout(edit.monitor.waitForConsumption(request(edit.monitor)), harness.now - started);
    expect(foreign.endTest).not.toHaveBeenCalled();
  });

  test('ignores a request older than its lifetime', () => {
    const harness = createHarness();
    const edit = harness.load('edit');
    request(edit.monitor);
    harness.advance(13);
    const server = harness.load('server');
    server.start();
    harness.advance(2);

    expect(server.endTest).not.toHaveBeenCalled();
    expect(server.lifecycle.beforeEndTest).not.toHaveBeenCalled();
  });

  test('a new runtime ignores a still-fresh request left behind by a silently failed clear', () => {
    const harness = createHarness({
      dropWrite: access => access.role === 'edit' && access.value === false,
    });
    const edit = harness.load('edit');
    const abandonedId = request(edit.monitor);
    edit.monitor.clearPending(abandonedId);
    harness.advance(1);
    const server = harness.load('server');
    server.start();
    harness.advance(1);

    expect(server.endTest).not.toHaveBeenCalled();
    expect(server.lifecycle.beforeEndTest).not.toHaveBeenCalled();
    expect(edit.monitor.waitForConsumption(request(edit.monitor))).toMatchObject({ ok: true, consumed: true });
    expect(server.endTest).toHaveBeenCalledTimes(1);
  });

  test('clearing an old request preserves a newer one, while clearing the current request prevents delivery', () => {
    const harness = createHarness();
    const edit = harness.load('edit');
    const oldId = request(edit.monitor);
    const currentId = request(edit.monitor);
    edit.monitor.clearPending(oldId);
    const server = harness.load('server');
    server.start();
    expect(edit.monitor.waitForConsumption(currentId)).toMatchObject({ ok: true, consumed: true });

    const cancelledId = request(edit.monitor);
    edit.monitor.clearPending(cancelledId);
    const nextServer = harness.load('server');
    nextServer.start();
    harness.advance(2);
    expect(nextServer.endTest).not.toHaveBeenCalled();
    expect(server.endTest).toHaveBeenCalledTimes(1);
  });
});
