import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { build as esbuildBuild, type Plugin } from 'esbuild';

interface TestHandlersModule {
  startPlaytest(request: Record<string, unknown>): Record<string, unknown>;
  stopPlaytest(request: Record<string, unknown>): Record<string, unknown>;
}

function repositoryRoot(): string {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, 'studio-plugin')) ? cwd : path.resolve(cwd, '../..');
}

function robloxPcall(callback: () => unknown): [boolean, unknown] {
  try {
    return [true, callback()];
  } catch (error) {
    return [false, error];
  }
}

const dependencies: Plugin = {
  name: 'studio-playtest-control-dependencies',
  setup(build) {
    build.onResolve({ filter: /^@rbxts\/services$/ }, () => ({ path: 'services', namespace: 'studio-playtest' }));
    build.onResolve({ filter: /^\.\.\/(StopPlayMonitor|PluginSession|PeerRole)$/ }, (args) => ({
      path: args.path.slice(3), namespace: 'studio-playtest',
    }));
    build.onLoad({ filter: /.*/, namespace: 'studio-playtest' }, (args) => {
      if (args.path === 'services') {
        return {
          contents: `export const HttpService = {};
            export const Players = { GetPlayers: () => [] };
            export const RunService = globalThis.__RUN_SERVICE__;`,
          loader: 'js',
        };
      }
      const globals: Record<string, string> = {
        StopPlayMonitor: '__STOP_MONITOR__',
        PluginSession: '__PLUGIN_SESSION__',
        PeerRole: '__PEER_ROLE__',
      };
      return { contents: `export default globalThis.${globals[args.path]};`, loader: 'js' };
    });
  },
};

let bundledModule: Promise<string> | undefined;
function pluginModule(): Promise<string> {
  bundledModule ??= esbuildBuild({
    entryPoints: [path.join(repositoryRoot(), 'studio-plugin/src/modules/handlers/TestHandlers.ts')],
    bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node20',
    logLevel: 'silent', plugins: [dependencies],
  }).then((result) => result.outputFiles[0].text);
  return bundledModule;
}

async function createHarness(editModeActive = false) {
  const spawned: Array<() => void> = [];
  let now = 0;
  let onWait: () => void = () => undefined;
  const studioTestService = {
    EditModeActive: editModeActive,
    ExecutePlayModeAsync: jest.fn(() => undefined),
    ExecuteRunModeAsync: jest.fn(() => undefined),
  };
  const pluginSession = {
    prepareSharedTopology: jest.fn(() => 'topology-token'),
    clearTopologyMarker: jest.fn(),
  };
  const stopMonitor = {
    requestStop: () => ({ ok: true, requestId: 'stop-request' }),
    waitForConsumption: () => ({ ok: true, consumed: true }),
    clearPending: () => undefined,
  };
  const commonJsModule = { exports: {} as unknown };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    __RUN_SERVICE__: { IsRunning: () => false },
    __STOP_MONITOR__: stopMonitor,
    __PLUGIN_SESSION__: pluginSession,
    __PEER_ROLE__: { detect: () => 'edit' },
    game: { GetService: () => studioTestService },
    tick: () => now,
    task: {
      spawn: (callback: () => void) => { spawned.push(callback); },
      wait: (seconds: number) => {
        now = Math.round((now + seconds) * 1000) / 1000;
        if (now > 11) throw new Error('Playtest teardown exceeded its bounded wait');
        onWait();
      },
    },
    pcall: robloxPcall,
    warn: () => undefined,
  });
  vm.runInContext(await pluginModule(), context);
  // esbuild emits the known plugin export assignment as CommonJS (or a default wrapper).
  const loaded = commonJsModule.exports as TestHandlersModule & { default?: TestHandlersModule };
  return {
    handlers: loaded.default ?? loaded,
    studioTestService,
    pluginSession,
    get now() { return now; },
    get scheduledCount() { return spawned.length; },
    onWait(callback: () => void) { onWait = callback; },
    finishExecution() {
      const callback = spawned.shift();
      if (callback === undefined) throw new Error('No playtest execution is scheduled');
      callback();
    },
  };
}

describe('Studio playtest lifecycle control', () => {
  test('waits for native edit mode after an accepted stop with no tracked execution', async () => {
    // A manually started test (or an already-unwound execution) leaves testRunning false.
    const harness = await createHarness();
    harness.onWait(() => {
      if (harness.now >= 0.3) harness.studioTestService.EditModeActive = true;
    });

    const result = harness.handlers.stopPlaytest({});

    expect(result.success).toBe(true);
    expect(harness.studioTestService.EditModeActive).toBe(true);
    expect(harness.now).toBeGreaterThanOrEqual(0.3);
  });

  test('returns a bounded failure when an accepted stop never restores native edit mode', async () => {
    const harness = await createHarness();

    const result = harness.handlers.stopPlaytest({});

    expect(result).toMatchObject({
      success: false,
      error: 'Playtest teardown did not complete.',
      stopSignalAccepted: true,
      editModeReady: false,
      timedOut: true,
    });
    expect(result).not.toHaveProperty('runtimeStopped');
    expect(harness.now).toBeGreaterThanOrEqual(10);
    expect(harness.now).toBeLessThanOrEqual(10.1);
  });

  test('rejects immediate starts before native edit mode without changing topology or scheduling execution', async () => {
    const harness = await createHarness();

    const result = harness.handlers.startPlaytest({ mode: 'play' });

    expect(result).toMatchObject({
      success: false,
      error: 'Studio is not ready to start a playtest.',
      editModeReady: false,
    });
    expect(harness.pluginSession.prepareSharedTopology).not.toHaveBeenCalled();
    expect(harness.scheduledCount).toBe(0);
    expect(harness.studioTestService.ExecutePlayModeAsync).not.toHaveBeenCalled();
    expect(harness.studioTestService.ExecuteRunModeAsync).not.toHaveBeenCalled();
  });

  test('allows the next execution immediately after stop waits for unwinding and native edit mode', async () => {
    const harness = await createHarness(true);
    expect(harness.handlers.startPlaytest({ mode: 'play' }).success).toBe(true);
    harness.studioTestService.EditModeActive = false;
    harness.onWait(() => {
      // Running the queued coroutine models ExecutePlayModeAsync returning during teardown.
      if (harness.now === 0.1) harness.finishExecution();
      if (harness.now >= 0.3) harness.studioTestService.EditModeActive = true;
    });

    const stopped = harness.handlers.stopPlaytest({});
    expect(stopped.success).toBe(true);
    expect(harness.studioTestService.EditModeActive).toBe(true);
    expect(harness.now).toBeGreaterThanOrEqual(0.3);

    const restarted = harness.handlers.startPlaytest({ mode: 'run' });
    expect(restarted.success).toBe(true);
    expect(harness.scheduledCount).toBe(1);
    harness.finishExecution();
    expect(harness.studioTestService.ExecuteRunModeAsync).toHaveBeenCalledTimes(1);
  });

  test('waits for tracked execution to unwind even when native edit mode is already ready', async () => {
    const harness = await createHarness(true);
    expect(harness.handlers.startPlaytest({ mode: 'play' }).success).toBe(true);
    harness.onWait(() => {
      if (harness.now >= 0.3) harness.finishExecution();
    });

    const result = harness.handlers.stopPlaytest({});

    expect(result.success).toBe(true);
    expect(harness.now).toBeGreaterThanOrEqual(0.3);
    expect(harness.scheduledCount).toBe(0);
    expect(harness.studioTestService.ExecutePlayModeAsync).toHaveBeenCalledTimes(1);
  });

  test('does not report success when native edit mode is ready but tracked execution never unwinds', async () => {
    const harness = await createHarness(true);
    expect(harness.handlers.startPlaytest({ mode: 'play' }).success).toBe(true);

    expect(harness.handlers.stopPlaytest({})).toMatchObject({
      success: false,
      stopSignalAccepted: true,
      editModeReady: true,
      playtestTaskPending: true,
      timedOut: true,
    });
    expect(harness.now).toBeGreaterThanOrEqual(10);
    expect(harness.now).toBeLessThanOrEqual(10.1);
    expect(harness.scheduledCount).toBe(1);
  });
});
