import { BridgeService } from '../bridge-service.js';
import { createHttpServer } from '../http-server.js';
import { RobloxStudioTools } from '../tools/index.js';
import { buildStudioLaunchArgs, buildWindowsStudioStartScript, buildWindowsStudioStopScript, cleanupManagedBaseplateFiles, isWsl, quoteWindowsCommandLineArg, StudioInstanceManager, sweepStaleBaseplateFiles } from '../studio-instance-manager.js';
import { detectStudioPlatform } from '../studio-platform.js';
import { ManagedInstanceRegistry } from '../managed-instance-registry.js';
import request from 'supertest';
import { spawnSync, type SpawnOptions } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const READY = {
  pluginSessionId: 'session-1',
  instanceId: 'place:test',
  role: 'edit',
  placeId: 0,
  placeName: 'TestPlace',
  dataModelName: 'TestPlace',
  isRunning: false,
};

const ZERO_NETWORK_STATE = {
  InboundNetworkMinDelayMs: 0,
  OutboundNetworkMinDelayMs: 0,
  InboundNetworkJitterMs: 0,
  OutboundNetworkJitterMs: 0,
  InboundNetworkLossPercent: 0,
  OutboundNetworkLossPercent: 0,
};

const DIRTY_NETWORK_STATE = {
  InboundNetworkMinDelayMs: 50,
  OutboundNetworkMinDelayMs: 50,
  InboundNetworkJitterMs: 10,
  OutboundNetworkJitterMs: 10,
  InboundNetworkLossPercent: 0.5,
  OutboundNetworkLossPercent: 0.5,
};

function readRegistryEvents(registryDir: string): Record<string, unknown>[] {
  return fs.readdirSync(registryDir)
    .filter((name) => name.startsWith('events-') && name.endsWith('.jsonl'))
    .flatMap((name) => fs.readFileSync(path.join(registryDir, name), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)));
}

describe('Smoke', () => {
  test('sanitized Codex environment still detects a WSL host with working Windows interop', () => {
    const kernelVersion = process.platform === 'linux' && fs.existsSync('/proc/version')
      ? fs.readFileSync('/proc/version', 'utf8')
      : '';
    if (!/microsoft|wsl/i.test(kernelVersion)) return;

    const previousInterop = process.env.WSL_INTEROP;
    const previousDistroName = process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
    delete process.env.WSL_DISTRO_NAME;
    try {
      expect(isWsl()).toBe(true);
    } finally {
      if (previousInterop === undefined) delete process.env.WSL_INTEROP;
      else process.env.WSL_INTEROP = previousInterop;
      if (previousDistroName === undefined) delete process.env.WSL_DISTRO_NAME;
      else process.env.WSL_DISTRO_NAME = previousDistroName;
    }
  });

  test('sanitized WSL capability selects the retained Windows launcher boundary', async () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
    const platformCapabilities = detectStudioPlatform({
      platform: 'linux',
      kernelVersion: 'Linux version 6.6.87.2-microsoft-standard-WSL2',
      windowsInteropAvailable: true,
    });
    let launcherCalls = 0;
    let abortCalls = 0;

    try {
      const manager = new StudioInstanceManager({
        registryDir,
        platformCapabilities,
        processAdapter: {
          currentBootId: () => 'boot-1',
          observeStudioProcesses: () => ({
            status: 'ok',
            observedAt: Date.now(),
            processes: [],
          }),
          resolveStudioExe: () => 'C:\\Roblox\\RobloxStudioBeta.exe',
        },
        windowsStudioLauncher: () => {
          launcherCalls += 1;
          return {
            pid: 9001,
            nativePid: 7101,
            nativeStartedAt: '133700123499',
            unref: () => {},
            authorize: () => {},
            release: () => {},
            abort: () => {
              abortCalls += 1;
            },
          };
        },
      });

      expect(manager.getLifecycleCapabilities()).toMatchObject({
        hostPlatform: 'wsl',
        processIdentity: {
          supported: true,
          launcher: 'wsl-windows-retained',
        },
      });

      const record = await manager.launch({
        source: 'local_file',
        localPlaceFile: '/tmp/sanitized-codex-wsl.rbxl',
        requireProcessIdentity: true,
      });
      expect(launcherCalls).toBe(1);
      expect(record).toMatchObject({
        nativeProcessId: 7101,
        nativeProcessStartedAt: '133700123499',
        processAuthorizationState: 'pending',
      });

      await manager.close(record);
      expect(abortCalls).toBe(1);
    } finally {
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('source does not force playtest shutdown with brittle fallbacks', () => {
    const cwd = process.cwd();
    const repoRoot = fs.existsSync(path.join(cwd, 'studio-plugin')) ? cwd : path.resolve(cwd, '../..');
    const guardedFiles = [
      path.join(repoRoot, 'packages/core/src/tools/index.ts'),
      path.join(repoRoot, 'studio-plugin/src/modules/ClientBroker.ts'),
      path.join(repoRoot, 'studio-plugin/src/modules/Communication.ts'),
      path.join(repoRoot, 'studio-plugin/src/modules/handlers/TestHandlers.ts'),
    ];

    for (const file of guardedFiles) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source).not.toMatch(/RunService\s*[:.]\s*Stop\s*\(/);
      expect(source).not.toContain('/api/force-stop-runtime');
      expect(source).not.toContain('runtime_runservice_stop');
      expect(source).not.toContain('windows_shift_f5');
      expect(source).not.toContain('WScript.Shell');
      expect(source).not.toContain('SendKeys');
      expect(source).not.toContain('powershell.exe');
    }
  });

  test('BridgeService instantiable', () => {
    const bridge = new BridgeService();
    expect(bridge).toBeDefined();
    expect(bridge.getPendingRequest('place:nope', 'edit')).toBeNull();
  });

  test('get_connected_instances returns one compact routing row per place', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);

    bridge.registerInstance({
      pluginSessionId: 'place-one-edit',
      instanceId: 'place:1',
      role: 'edit',
      placeId: 1,
      placeName: 'Place One',
      dataModelName: 'PlaceOneEdit',
      isRunning: false,
    });
    bridge.registerInstance({
      pluginSessionId: 'place-one-server',
      instanceId: 'place:1',
      role: 'server',
      placeId: 1,
      placeName: 'Place One',
      dataModelName: 'PlaceOneServer',
      isRunning: true,
    });
    bridge.registerInstance({
      pluginSessionId: 'place-one-client',
      instanceId: 'place:1',
      role: 'client',
      placeId: 1,
      placeName: 'Place One',
      dataModelName: 'PlaceOneClient',
      isRunning: true,
    });
    bridge.registerInstance({
      pluginSessionId: 'place-two-edit',
      instanceId: 'anon:2',
      role: 'edit',
      placeId: 0,
      placeName: '',
      dataModelName: 'Untitled Place',
      isRunning: false,
    });

    const result = await tools.getConnectedInstances();
    const payload = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);

    expect(payload).toEqual({
      instances: [
        { id: 'place:1', name: 'Place One', roles: ['edit', 'server', 'client-1'] },
        { id: 'anon:2', name: 'Untitled Place', roles: ['edit'] },
      ],
    });
    expect(Object.keys(payload.instances[0]).sort()).toEqual(['id', 'name', 'roles']);
  });

  test('WSL Studio launch does not inherit the synchronous PowerShell pipes', () => {
    const script = buildWindowsStudioStartScript(
      'C:\\Roblox\\RobloxStudioBeta.exe',
      ['--task', 'EditFile', '--localPlaceFile', 'C:\\Places\\Baseplate.rbxl'],
    );

    expect(script.startsWith("$ErrorActionPreference = 'Stop'\n")).toBe(true);
    expect(script).toContain(
      'if (String.IsNullOrEmpty(currentDirectory))\n            currentDirectory = null;',
    );
    expect(script.indexOf('String.IsNullOrEmpty(currentDirectory)')).toBeLessThan(
      script.indexOf('bool started = CreateProcessW'),
    );
    expect(script).toContain('CREATE_SUSPENDED');
    expect(script).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE');
    expect(script).toContain('AssignProcessToJobObject');
    expect(script).toContain('Marshal.GetLastWin32Error() == 5');
    expect(script).toContain(
      'public uint dwXCountChars;\n        public uint dwYCountChars;\n        public uint dwFillAttribute;\n        public uint dwFlags;',
    );
    expect(script).toContain('$launch = [McpSuspendedStudio]::Start(');
    expect(script).toContain('$launch.Resume()');
    expect(script).toContain('$launch.Abort()');
    expect(script).toContain(
      'elseif ($command -eq "MCP_STUDIO_LAUNCH_ABORT") { $launch.Abort(); $accepted = $true }',
    );
    expect(script).toContain(
      'if ($command -eq "MCP_STUDIO_LAUNCH_COMPLETE") { $launch.Release(); $accepted = $true }\n' +
      'elseif ($command -eq "MCP_STUDIO_LAUNCH_ABORT") { $launch.Abort(); $accepted = $true }',
    );
    expect(script).toContain('TerminateAndWait(created.hProcess)');
    expect(script).toContain('TerminateAndWait(process)');
    expect(script).toContain('WaitForSingleObject(processHandle, 15000)');
    expect(script).toContain('$launch.StartedAtFileTime');
    expect(script).not.toContain('$psi.UseShellExecute');
    expect(script).toContain("'C:\\Roblox\\RobloxStudioBeta.exe', 'C:\\Roblox\\RobloxStudioBeta.exe --task EditFile --localPlaceFile C:\\Places\\Baseplate.rbxl', $null)");
  });

  test('Windows Studio shutdown uses a creation-checked process handle', () => {
    const script = buildWindowsStudioStopScript(47312, '133700123456');

    expect(script).toContain(
      '[System.Diagnostics.Process]::GetProcessById($processId)',
    );
    expect(script).toContain(
      '$studio.StartTime.ToUniversalTime().ToFileTimeUtc()',
    );
    expect(script).toContain(
      'if ($actualStartedAt -ne $expectedStartedAt) { return }',
    );
    expect(script).toContain('$studio.Kill()');
    expect(script).toContain('$studio.WaitForExit()');
    expect(script).not.toContain('Stop-Process');
  });

  test('WSL Studio launch applies environment and working-directory values as PowerShell data', () => {
    const script = buildWindowsStudioStartScript(
      'C:\\Roblox\\RobloxStudioBeta.exe',
      ['--task', 'EditFile'],
      {
        set: {
          STUDIO_LAUNCH_LOADER: "C:\\LaunchTools\\loader's; $env:SHOULD_NOT_RUN.dll",
          STUDIO_LAUNCH_BUILD_VERSION: '0.0.0+build.123',
        },
        remove: ['STUDIO_LAUNCH_LOADED_BUILD_VERSION'],
      },
      "C:\\Studio Workers\\worker's-directory",
    );

    expect(script).toContain(
      "[Environment]::SetEnvironmentVariable('STUDIO_LAUNCH_LOADER', 'C:\\LaunchTools\\loader''s; $env:SHOULD_NOT_RUN.dll', [EnvironmentVariableTarget]::Process)",
    );
    expect(script).toContain(
      "[Environment]::SetEnvironmentVariable('STUDIO_LAUNCH_LOADED_BUILD_VERSION', $null, [EnvironmentVariableTarget]::Process)",
    );
    expect(script.indexOf("'STUDIO_LAUNCH_LOADER'")).toBeLessThan(
      script.indexOf('[McpSuspendedStudio]::Start('),
    );
    expect(script).toContain(
      "[McpSuspendedStudio]::Start('C:\\Roblox\\RobloxStudioBeta.exe', 'C:\\Roblox\\RobloxStudioBeta.exe --task EditFile', 'C:\\Studio Workers\\worker''s-directory')",
    );
    expect(script).toContain('Start(string application, string commandLine, string currentDirectory)');
    expect(script.match(/IntPtr\.Zero, currentDirectory, ref startup/g)).toHaveLength(2);
    expect(script).toContain('CREATE_SUSPENDED');

    expect(() => buildWindowsStudioStartScript('Studio.exe', [], {
      set: { 'STUDIO_LAUNCH_LOADER; Remove-Item Env:PATH': 'loader.dll' },
    })).toThrow(/Invalid process environment variable name/);
    expect(() => buildWindowsStudioStartScript(
      'Studio.exe',
      [],
      undefined,
      ' \t',
    )).toThrow(/studio_working_directory must be a non-empty string/);
  });

  test('HTTP server starts and responds to health check', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    const app = createHttpServer(tools, bridge);

    const response = await request(app).get('/health').expect(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.service).toBe('robloxstudio-mcp');
  });

  test('clearAllPendingRequests rejects all pending', async () => {
    const bridge = new BridgeService();
    const p1 = bridge.sendRequest('/test1', {}, 'place:test', 'edit');
    const p2 = bridge.sendRequest('/test2', {}, 'place:test', 'edit');
    expect(bridge.getPendingRequest('place:test', 'edit')).toBeTruthy();
    bridge.clearAllPendingRequests();
    expect(bridge.getPendingRequest('place:test', 'edit')).toBeNull();
    await expect(p1).rejects.toThrow('Connection closed');
    await expect(p2).rejects.toThrow('Connection closed');
  });

  test('Disconnect rejects pending requests for that (instanceId, role)', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    const app = createHttpServer(tools, bridge);

    await request(app).post('/ready').send(READY).expect(200);
    const pending = bridge.sendRequest('/test', {}, 'place:test', 'edit');
    pending.catch(() => {});
    await request(app).post('/disconnect').send({ pluginSessionId: 'session-1' }).expect(200);
    await expect(pending).rejects.toThrow(/disconnected/);
  });

  test('Connection state lifecycle', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    const app = createHttpServer(tools, bridge) as any;
    expect(app.isPluginConnected()).toBe(false);
    await request(app).post('/ready').send(READY).expect(200);
    expect(app.isPluginConnected()).toBe(true);
    await request(app).post('/disconnect').send({ pluginSessionId: 'session-1' }).expect(200);
    expect(app.isPluginConnected()).toBe(false);
  });

  test('start_playtest rejects numPlayers', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    await expect(tools.startPlaytest('play', 1)).rejects.toThrow(/multiplayer_playtest/);
  });

  test('manage_instance blocks launching an already connected latest published place', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance({
      ...READY,
      instanceId: 'place:123',
      placeId: 123,
    });
    const launch = jest.fn();
    (tools as any).instanceManager = {
      list: () => [],
      launch,
    };

    const result = await tools.manageInstance({
      action: 'launch',
      source: 'published_place',
      place_id: 123,
      wait_for_connection: false,
    });

    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({
      error: 'Place is already open.',
      message: 'place_id 123 is already connected. Use the existing instance or launch a specific place_revision.',
    });
    expect(launch).not.toHaveBeenCalled();
  });

  test('manage_instance allows launching an explicit past revision for an already connected place', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance({
      ...READY,
      instanceId: 'place:123',
      placeId: 123,
    });
    const launch = jest.fn(async (options) => ({
      ...options,
      recordId: 'launch-revision',
      nativeProcessId: 7001,
      exe: 'RobloxStudioBeta.exe',
      args: [],
      launchedAt: Date.now(),
      state: 'launching',
    }));
    (tools as any).instanceManager = {
      list: () => [],
      launch,
      refresh: (record: unknown) => record,
    };
    jest.spyOn(tools as any, '_deriveUniverseId').mockResolvedValue(456);

    const result = await tools.manageInstance({
      action: 'launch',
      source: 'place_revision',
      place_id: 123,
      place_version: 7,
      wait_for_connection: false,
    });

    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual(expect.objectContaining({
      launch_id: 'launch-revision',
      pid: 7001,
      state: 'launching',
      message: 'Studio launch requested.',
    }));
    expect(launch).toHaveBeenCalledWith({
      source: 'place_revision',
      localPlaceFile: undefined,
      placeId: 123,
      universeId: 456,
      placeVersion: 7,
      connectionTimeoutMs: 120000,
      studioExecutable: undefined,
      processEnvironment: undefined,
    });
  });

  test('manage_instance baseplate launch does not parse non-dependent launch inputs', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    const launch = jest.fn(async (options) => ({
      ...options,
      recordId: 'launch-baseplate',
      nativeProcessId: 7002,
      exe: 'RobloxStudioBeta.exe',
      args: [],
      launchedAt: Date.now(),
      state: 'launching',
    }));
    (tools as any).instanceManager = {
      list: () => [],
      launch,
      refresh: (record: unknown) => record,
    };

    const result = await tools.manageInstance({
      action: 'launch',
      source: 'baseplate',
      place_id: 'not-needed',
      place_version: 'not-needed',
      universe_id: 'not-accepted',
      wait_for_connection: false,
    });

    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual(expect.objectContaining({
      launch_id: 'launch-baseplate',
      pid: 7002,
      state: 'launching',
      message: 'Studio launch requested.',
    }));
    expect(launch).toHaveBeenCalledWith({
      source: 'baseplate',
      localPlaceFile: undefined,
      placeId: undefined,
      universeId: undefined,
      placeVersion: undefined,
      connectionTimeoutMs: 120000,
      studioExecutable: undefined,
      processEnvironment: undefined,
      studioWorkingDirectory: undefined,
    });
  });

  test('manage_instance threads exact executable, process environment, and working directory into launch', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    const launch = jest.fn(async (options) => ({
      ...options,
      recordId: 'launch-custom',
      nativeProcessId: 7003,
      exe: options.studioExecutable,
      args: [],
      launchedAt: Date.now(),
      state: 'launching',
    }));
    (tools as any).instanceManager = {
      list: () => [],
      launch,
      refresh: (record: unknown) => record,
    };

    await tools.manageInstance({
      action: 'launch',
      source: 'local_file',
      local_place_file: '/tmp/custom-launch-place.rbxl',
      wait_for_connection: false,
      studio_executable: 'C:\\Roblox\\version-custom\\RobloxStudioBeta.exe',
      studio_working_directory: 'C:\\Studio Workers\\worker-7',
      process_environment: {
        set: {
          STUDIO_LAUNCH_LOADER: 'C:\\LaunchTools\\studio_loader.dll',
          STUDIO_LAUNCH_BUILD_VERSION: '0.0.0+build.123',
        },
        remove: ['STUDIO_LAUNCH_LOADED_BUILD_VERSION'],
      },
    });

    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      studioExecutable: 'C:\\Roblox\\version-custom\\RobloxStudioBeta.exe',
      studioWorkingDirectory: 'C:\\Studio Workers\\worker-7',
      processEnvironment: {
        set: {
          STUDIO_LAUNCH_LOADER: 'C:\\LaunchTools\\studio_loader.dll',
          STUDIO_LAUNCH_BUILD_VERSION: '0.0.0+build.123',
        },
        remove: ['STUDIO_LAUNCH_LOADED_BUILD_VERSION'],
      },
    }));

    await expect(tools.manageInstance({
      action: 'launch',
      source: 'local_file',
      local_place_file: '/tmp/custom-launch-place.rbxl',
      process_environment: { remove: ['STUDIO_LAUNCH_LOADED_BUILD_VERSION; whoami'] },
    })).rejects.toThrow(/Invalid process environment variable name/);
  });

  test('Studio launch uses the exact executable and working directory, patches only the child environment, and persists no environment secrets', async () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
    const exactExecutable = 'C:\\Roblox\\version-custom\\RobloxStudioBeta.exe';
    const parentLoadedVersion = process.env.STUDIO_LAUNCH_LOADED_BUILD_VERSION;
    const studioWorkingDirectory = '/tmp/rsmcp-worker-7655';
    const liveProcessIds = new Set<number>();
    const resolveStudioExe = jest.fn(() => 'C:\\Roblox\\latest\\RobloxStudioBeta.exe');
    let capturedSpawnOptions: SpawnOptions | undefined;
    process.env.STUDIO_LAUNCH_LOADED_BUILD_VERSION = 'parent-value';

    const processAdapter = {
      currentBootId: () => 'boot-1',
      resolveStudioExe,
      spawnStudio: (_exe: string, _args: string[], options: SpawnOptions) => {
        capturedSpawnOptions = options;
        liveProcessIds.add(7655);
        return { pid: 7655, nativePid: 7655, unref: () => {} };
      },
      listStudioProcesses: () => [...liveProcessIds].map((Id) => ({
        Id,
        Name: 'RobloxStudioBeta',
        Path: exactExecutable,
        MainWindowTitle: 'Custom Launch - Roblox Studio',
      })),
      stopProcess: (pid: number) => liveProcessIds.delete(pid),
    };

    try {
      const manager = new StudioInstanceManager({ registryDir, processAdapter });
      const record = await manager.launch({
        source: 'local_file',
        localPlaceFile: '/tmp/custom-launch-place.rbxl',
        studioExecutable: exactExecutable,
        studioWorkingDirectory,
        processEnvironment: {
          set: {
            STUDIO_LAUNCH_LOADER: 'C:\\LaunchTools\\secret-loader.dll',
            STUDIO_LAUNCH_BUILD_VERSION: '0.0.0+build.123',
          },
          remove: ['STUDIO_LAUNCH_LOADED_BUILD_VERSION'],
        },
      });

      expect(resolveStudioExe).not.toHaveBeenCalled();
      expect(record.exe).toBe(exactExecutable);
      expect(record.studioWorkingDirectory).toBe(studioWorkingDirectory);
      expect(capturedSpawnOptions?.cwd).toBe(studioWorkingDirectory);
      expect((capturedSpawnOptions?.env as NodeJS.ProcessEnv).STUDIO_LAUNCH_LOADER).toBe('C:\\LaunchTools\\secret-loader.dll');
      expect((capturedSpawnOptions?.env as NodeJS.ProcessEnv).STUDIO_LAUNCH_BUILD_VERSION).toBe('0.0.0+build.123');
      expect((capturedSpawnOptions?.env as NodeJS.ProcessEnv).STUDIO_LAUNCH_LOADED_BUILD_VERSION).toBeUndefined();
      expect(process.env.STUDIO_LAUNCH_LOADED_BUILD_VERSION).toBe('parent-value');

      const registryRecord = fs.readFileSync(
        path.join(registryDir, `${record.recordId}.json`),
        'utf8',
      );
      expect(registryRecord).toContain(exactExecutable.replace(/\\/g, '\\\\'));
      expect(registryRecord).toContain('"studioWorkingDirectory": "/tmp/rsmcp-worker-7655"');
      expect(registryRecord).not.toContain('STUDIO_LAUNCH_LOADER');
      expect(registryRecord).not.toContain('secret-loader.dll');
      expect(registryRecord).not.toContain('processEnvironment');

      await manager.close(record);
    } finally {
      if (parentLoadedVersion === undefined) delete process.env.STUDIO_LAUNCH_LOADED_BUILD_VERSION;
      else process.env.STUDIO_LAUNCH_LOADED_BUILD_VERSION = parentLoadedVersion;
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('Studio launch stops its owned process if the initial registry write fails', async () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
    const registry = new ManagedInstanceRegistry(registryDir);
    const liveProcessIds = new Set<number>();
    const stopped: number[] = [];
    jest.spyOn(registry, 'upsert').mockImplementation(() => {
      throw new Error('disk unavailable');
    });
    const processAdapter = {
      currentBootId: () => 'boot-1',
      resolveStudioExe: () => 'RobloxStudioBeta.exe',
      spawnStudio: () => {
        liveProcessIds.add(7654);
        return { pid: 9004, nativePid: 7654, unref: () => {} };
      },
      listStudioProcesses: () => [...liveProcessIds].map((Id) => ({
        Id,
        Name: 'RobloxStudioBeta',
        Path: 'RobloxStudioBeta.exe',
        MainWindowTitle: 'Persistence Test - Roblox Studio',
      })),
      stopProcess: (pid: number) => {
        stopped.push(pid);
        liveProcessIds.delete(pid);
      },
    };

    try {
      const manager = new StudioInstanceManager({ registry, processAdapter });
      await expect(manager.launch({
        source: 'local_file',
        localPlaceFile: '/tmp/persistence-test.rbxl',
      })).rejects.toThrow(/managed-instance record could not be persisted.*disk unavailable/);
      expect(stopped).toEqual([7654]);
      expect(liveProcessIds.size).toBe(0);
    } finally {
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });
  test('Studio launch stops its owned process when creation identity cannot be captured', async () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
    const registry = new ManagedInstanceRegistry(registryDir);
    const liveProcessIds = new Set<number>();
    const stopped: number[] = [];
    const processAdapter = {
      currentBootId: () => 'boot-1',
      resolveStudioExe: () => 'RobloxStudioBeta.exe',
      spawnStudio: () => {
        liveProcessIds.add(7655);
        return {
          pid: 9005,
          nativePid: 7655,
          unref: () => {},
          abort: () => {
            stopped.push(7655);
            liveProcessIds.delete(7655);
          },
        };
      },
      listStudioProcesses: () => [...liveProcessIds].map((Id) => ({
        Id,
        Name: 'RobloxStudioBeta',
        Path: 'RobloxStudioBeta.exe',
        MainWindowTitle: 'Identity Test - Roblox Studio',
      })),
      stopProcess: () => {
        throw new Error('PID-only cleanup must not run.');
      },
    };

    try {
      const manager = new StudioInstanceManager({ registry, processAdapter });
      await expect(manager.launch({
        source: 'local_file',
        localPlaceFile: '/tmp/identity-test.rbxl',
        requireProcessIdentity: true,
      })).rejects.toThrow(/exact creation identity and suspended-process control handles/);
      expect(stopped).toEqual([7655]);
      expect(liveProcessIds.size).toBe(0);
    } finally {
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('identity-required launch rejects adapters without suspended-process controls', async () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
    const registry = new ManagedInstanceRegistry(registryDir);
    const stopped: Array<{ pid: number; startedAt?: string }> = [];
    const processAdapter = {
      currentBootId: () => 'boot-1',
      resolveStudioExe: () => 'RobloxStudioBeta.exe',
      spawnStudio: () => ({
        pid: 9008,
        nativePid: 7659,
        nativeStartedAt: '133700123460',
        unref: () => {},
      }),
      listStudioProcesses: () => [{
        Id: 7659,
        Name: 'RobloxStudioBeta',
        Path: 'RobloxStudioBeta.exe',
        MainWindowTitle: 'Missing Controls Test - Roblox Studio',
        StartTimeUtcFileTime: '133700123460',
      }],
      stopProcess: (pid: number, startedAt?: string) => {
        stopped.push({ pid, startedAt });
      },
    };

    try {
      const manager = new StudioInstanceManager({ registry, processAdapter });
      await expect(manager.launch({
        source: 'local_file',
        localPlaceFile: '/tmp/missing-controls-test.rbxl',
        requireProcessIdentity: true,
      })).rejects.toThrow(/suspended-process control handles/);
      expect(stopped).toEqual([{ pid: 7659, startedAt: '133700123460' }]);
    } finally {
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('identity-required launch retains ownership until explicitly completed', async () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
    const registry = new ManagedInstanceRegistry(registryDir);
    const liveProcessIds = new Set<number>();
    const resumed: number[] = [];
    const released: number[] = [];
    const stopped: number[] = [];
    const processAdapter = {
      currentBootId: () => 'boot-1',
      resolveStudioExe: () => 'RobloxStudioBeta.exe',
      spawnStudio: () => {
        liveProcessIds.add(7656);
        return {
          pid: 9006,
          nativePid: 7656,
          nativeStartedAt: '133700123457',
          unref: () => {},
          authorize: () => resumed.push(7656),
          release: () => released.push(7656),
          abort: () => {
            stopped.push(7656);
            liveProcessIds.delete(7656);
          },
        };
      },
      listStudioProcesses: () => [...liveProcessIds].map((Id) => ({
        Id,
        Name: 'RobloxStudioBeta',
        Path: 'RobloxStudioBeta.exe',
        MainWindowTitle: 'Authorization Test - Roblox Studio',
        StartTimeUtcFileTime: '133700123457',
      })),
      stopProcess: (pid: number) => {
        stopped.push(pid);
        liveProcessIds.delete(pid);
      },
    };

    try {
      const manager = new StudioInstanceManager({
        registry,
        processAdapter,
        confirmedExitMisses: 1,
        confirmedExitGraceMs: 0,
        snapshotCacheMs: 0,
      });
      const tools = new RobloxStudioTools(new BridgeService());
      Object.defineProperty(tools, 'instanceManager', { value: manager });
      const launchStatus = JSON.parse((await tools.manageInstance({
        action: 'launch',
        source: 'local_file',
        local_place_file: '/tmp/authorization-test.rbxl',
        require_process_identity: true,
      })).content[0].text);
      expect(launchStatus).toEqual(expect.objectContaining({
        launch_id: expect.any(String),
        process_authorized: false,
        process_running: true,
        message: 'Studio launch requested.',
      }));
      const launchId = launchStatus.launch_id;
      if (typeof launchId !== 'string') throw new Error('launch_id was not returned');
      const launched = manager.peekByLaunchId(launchId)!;
      expect(launched.processAuthorizationState).toBe('pending');
      expect(launched.connectionDeadlineAt).toBeUndefined();
      expect(resumed).toEqual([]);

      const authorizedStatus = JSON.parse((await tools.manageInstance({
        action: 'authorize',
        launch_id: launched.recordId,
      })).content[0].text);
      expect(authorizedStatus).toEqual(expect.objectContaining({
        launch_id: launched.recordId,
        process_authorized: true,
        process_running: true,
      }));
      const authorized = manager.peekByLaunchId(launched.recordId!)!;
      expect(authorized.processAuthorizationState).toBe('authorized');
      expect(resumed).toEqual([7656]);
      expect(released).toEqual([]);

      const completedStatus = JSON.parse((await tools.manageInstance({
        action: 'complete',
        launch_id: launched.recordId,
      })).content[0].text);
      expect(completedStatus).toEqual(expect.objectContaining({
        launch_id: launched.recordId,
        process_authorized: true,
        process_ownership_released: true,
        process_running: true,
      }));
      const completed = manager.peekByLaunchId(launched.recordId!)!;
      expect(completed.processAuthorizationState).toBe('released');
      expect(released).toEqual([7656]);

      await manager.close(completed);
      expect(stopped).toEqual([7656]);

      const interrupted = await manager.launch({
        source: 'local_file',
        localPlaceFile: '/tmp/interrupted-authorization-test.rbxl',
        requireProcessIdentity: true,
      });
      await manager.authorizeByLaunchId(interrupted.recordId!);
      await manager.close(interrupted);
      expect(released).toEqual([7656]);
      expect(stopped).toEqual([7656, 7656]);

      const crashed = await manager.launch({
        source: 'local_file',
        localPlaceFile: '/tmp/crashed-authorization-test.rbxl',
        requireProcessIdentity: true,
      });
      await manager.authorizeByLaunchId(crashed.recordId!);
      liveProcessIds.delete(7656);
      await manager.list();
      expect(crashed.state).toBe('exited');
      expect(released).toEqual([7656]);
      expect(stopped).toEqual([7656, 7656, 7656]);
    } finally {
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('identity-required launch aborts when its caller disappears before authorization', async () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
    const registry = new ManagedInstanceRegistry(registryDir);
    const stopped: number[] = [];
    jest.useFakeTimers();

    try {
      const manager = new StudioInstanceManager({
        registry,
        launchCompletionTimeoutMs: 1000,
        processAdapter: {
          currentBootId: () => 'boot-1',
          resolveStudioExe: () => 'RobloxStudioBeta.exe',
          spawnStudio: () => ({
            pid: 9010,
            nativePid: 7660,
            nativeStartedAt: '133700123461',
            unref: () => {},
            authorize: () => {},
            release: () => {},
            abort: () => {
              stopped.push(7660);
            },
          }),
          listStudioProcesses: () => [{
            Id: 7660,
            Name: 'RobloxStudioBeta',
            Path: 'RobloxStudioBeta.exe',
            MainWindowTitle: 'Pre-Authorization Lease Test - Roblox Studio',
            StartTimeUtcFileTime: '133700123461',
          }],
          stopProcess: () => {},
        },
      });

      const launched = await manager.launch({
        source: 'local_file',
        localPlaceFile: '/tmp/pre-authorization-lease-test.rbxl',
        requireProcessIdentity: true,
      });
      expect(launched.processAuthorizationState).toBe('pending');
      expect(stopped).toEqual([]);

      await jest.advanceTimersByTimeAsync(1000);
      jest.useRealTimers();
      const persistenceDeadline = Date.now() + 2000;
      let persisted = await registry.findAnyByRecordId(launched.recordId!);
      while (persisted?.state !== 'failed' && Date.now() < persistenceDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        persisted = await registry.findAnyByRecordId(launched.recordId!);
      }

      expect(persisted?.state).toBe('failed');
      expect(launched.failureReason).toContain('did not complete Studio launch ownership transfer');
      expect(stopped).toEqual([7660]);
    } finally {
      jest.useRealTimers();
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('ownership lease does not race active authorization or release', async () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
    let authorizeStarted = false;
    let releaseStarted = false;
    let resolveAuthorize: (() => void) | undefined;
    let resolveRelease: (() => void) | undefined;
    const stopped: number[] = [];
    jest.useFakeTimers();

    try {
      const manager = new StudioInstanceManager({
        registry: new ManagedInstanceRegistry(registryDir),
        launchCompletionTimeoutMs: 1000,
        processAdapter: {
          currentBootId: () => 'boot-1',
          resolveStudioExe: () => 'RobloxStudioBeta.exe',
          spawnStudio: () => ({
            pid: 9011,
            nativePid: 7661,
            nativeStartedAt: '133700123462',
            unref: () => {},
            authorize: () => {
              authorizeStarted = true;
              return new Promise<void>((resolve) => {
                resolveAuthorize = resolve;
              });
            },
            release: () => {
              releaseStarted = true;
              return new Promise<void>((resolve) => {
                resolveRelease = resolve;
              });
            },
            abort: () => {
              stopped.push(7661);
            },
          }),
          listStudioProcesses: () => [{
            Id: 7661,
            Name: 'RobloxStudioBeta',
            Path: 'RobloxStudioBeta.exe',
            MainWindowTitle: 'Ownership Lease Race Test - Roblox Studio',
            StartTimeUtcFileTime: '133700123462',
          }],
          stopProcess: () => {},
        },
      });
      const launched = await manager.launch({
        source: 'local_file',
        localPlaceFile: '/tmp/ownership-lease-race-test.rbxl',
        requireProcessIdentity: true,
      });

      await jest.advanceTimersByTimeAsync(999);
      const authorizing = manager.authorizeByLaunchId(launched.recordId!);
      await Promise.resolve();
      expect(authorizeStarted).toBe(true);
      await jest.advanceTimersByTimeAsync(2);
      expect(stopped).toEqual([]);
      resolveAuthorize!();
      const authorized = await authorizing;
      expect(authorized.processAuthorizationState).toBe('authorized');

      await jest.advanceTimersByTimeAsync(999);
      const completing = manager.completeByLaunchId(launched.recordId!);
      await Promise.resolve();
      expect(releaseStarted).toBe(true);
      await jest.advanceTimersByTimeAsync(2);
      expect(stopped).toEqual([]);
      resolveRelease!();
      const completed = await completing;
      expect(completed.processAuthorizationState).toBe('released');
    } finally {
      jest.useRealTimers();
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('failed launch authorization aborts the suspended process', async () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
    const registry = new ManagedInstanceRegistry(registryDir);
    const liveProcessIds = new Set<number>();
    const stopped: number[] = [];
    const processAdapter = {
      currentBootId: () => 'boot-1',
      resolveStudioExe: () => 'RobloxStudioBeta.exe',
      spawnStudio: () => {
        liveProcessIds.add(7657);
        return {
          pid: 9007,
          nativePid: 7657,
          nativeStartedAt: '133700123458',
          unref: () => {},
          release: () => {},
          authorize: () => {
            throw new Error('resume failed');
          },
          abort: () => {
            stopped.push(7657);
            liveProcessIds.delete(7657);
          },
        };
      },
      listStudioProcesses: () => [...liveProcessIds].map((Id) => ({
        Id,
        Name: 'RobloxStudioBeta',
        Path: 'RobloxStudioBeta.exe',
        MainWindowTitle: 'Authorization Failure Test - Roblox Studio',
        StartTimeUtcFileTime: '133700123458',
      })),
      stopProcess: () => {
        throw new Error('PID-only cleanup must not run.');
      },
    };

    try {
      const manager = new StudioInstanceManager({ registry, processAdapter });
      const launched = await manager.launch({
        source: 'local_file',
        localPlaceFile: '/tmp/authorization-failure-test.rbxl',
        requireProcessIdentity: true,
      });
      await expect(manager.authorizeByLaunchId(launched.recordId!)).rejects.toThrow('resume failed');
      expect(stopped).toEqual([7657]);
      expect(liveProcessIds.size).toBe(0);
      expect(launched.state).toBe('failed');
    } finally {
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('broker restart exact-stops an orphaned authorized launch', async () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
    const registry = new ManagedInstanceRegistry(registryDir);
    const stopped: Array<{ pid: number; startedAt?: string }> = [];
    await registry.upsert({
      version: 1,
      recordId: 'orphaned-authorized-launch',
      source: 'local_file',
      nativeProcessId: 7658,
      nativeProcessStartedAt: '133700123459',
      spawnPid: 7658,
      exe: 'RobloxStudioBeta.exe',
      args: ['--task', 'EditFile'],
      localPlaceFile: '/tmp/orphaned-authorization-test.rbxl',
      launchedAt: Date.now() - 1000,
      connectionDeadlineAt: Date.now() + 120000,
      state: 'launching',
      ownerPid: 2_147_483_647,
      bootId: 'boot-1',
      processObservationStatus: 'running',
      processAuthorizationState: 'authorized',
    });
    const processAdapter = {
      currentBootId: () => 'boot-1',
      listStudioProcesses: () => [{
        Id: 7658,
        Name: 'RobloxStudioBeta',
        Path: 'RobloxStudioBeta.exe',
        MainWindowTitle: 'Orphaned Authorization Test - Roblox Studio',
        StartTimeUtcFileTime: '133700123459',
      }],
      stopProcess: (pid: number, startedAt?: string) => {
        stopped.push({ pid, startedAt });
      },
    };

    try {
      const manager = new StudioInstanceManager({ registry, processAdapter });
      const recovered = await manager.getByLaunchId('orphaned-authorized-launch');
      expect(stopped).toEqual([{ pid: 7658, startedAt: '133700123459' }]);
      expect(recovered).toEqual(expect.objectContaining({
        state: 'failed',
        closedAt: expect.any(Number),
        failureReason: 'Orphaned unreleased Studio launch was stopped after its broker owner exited.',
      }));
    } finally {
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('manage_instance asynchronously associates and closes a no-wait local-file launch', async () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
    const liveProcessIds = new Set([1111]);
    const stopped: number[] = [];
    const localPlaceFile = '/home/chris/Projects/roblox-games/strain/.worktree-studio/place.rbxl';
    const processAdapter = {
      currentBootId: () => 'boot-1',
      resolveStudioExe: () => 'RobloxStudioBeta.exe',
      spawnStudio: () => {
        liveProcessIds.add(4321);
        return {
          pid: 9001,
          nativePid: 4321,
          nativeStartedAt: '133700123456',
          unref: () => {},
        };
      },
      listStudioProcesses: () => [...liveProcessIds].map((Id) => ({
        Id,
        Name: 'RobloxStudioBeta',
        Path: 'RobloxStudioBeta.exe',
        MainWindowTitle: Id === 4321 ? 'Roblox Studio' : 'Other - Roblox Studio',
        StartTimeUtcFileTime: Id === 4321 ? '133700123456' : '133700123000',
      })),
      stopProcess: (pid: number) => {
        stopped.push(pid);
        liveProcessIds.delete(pid);
      },
    };

    let releaseAssociation!: () => void;
    let associationReleased = false;
    const associationBlocked = new Promise<void>((resolve) => {
      releaseAssociation = () => {
        associationReleased = true;
        resolve();
      };
    });

    try {
      const bridge = new BridgeService();
      const tools = new RobloxStudioTools(bridge);
      const manager = new StudioInstanceManager({ registryDir, processAdapter });
      const pendingLaunches = manager.pendingLaunches.bind(manager);
      let associationStarted = false;
      manager.pendingLaunches = async () => {
        associationStarted = true;
        await associationBlocked;
        return pendingLaunches();
      };
      const getManagedInstance = manager.get.bind(manager);
      manager.get = async (instanceId: string) => associationReleased
        ? getManagedInstance(instanceId)
        : undefined;
      (tools as any).instanceManager = manager;

      const launched = JSON.parse((await tools.manageInstance({
        action: 'launch',
        source: 'local_file',
        local_place_file: localPlaceFile,
        wait_for_connection: false,
      })).content[0].text);

      expect(launched).toEqual(expect.objectContaining({
        launch_id: expect.any(String),
        pid: 4321,
        process_started_at_file_time: '133700123456',
        state: 'launching',
        process_running: true,
        local_place_file: localPlaceFile,
        message: 'Studio launch requested.',
      }));

      const retainedStatus = JSON.parse((await tools.manageInstance({
        action: 'status',
        launch_id: launched.launch_id,
      })).content[0].text);
      expect(retainedStatus).toEqual(expect.objectContaining({
        launch_id: launched.launch_id,
        pid: 4321,
        process_started_at_file_time: '133700123456',
        state: 'launching',
        process_running: true,
      }));

      bridge.registerInstance({
        ...READY,
        pluginSessionId: 'session-async',
        instanceId: 'anon:async',
        placeName: 'place.rbxl',
        dataModelName: 'place.rbxl',
      });
      await Promise.resolve();
      expect(associationStarted).toBe(true);

      const statusRequest = tools.manageInstance({
        action: 'status',
        instance_id: 'anon:async',
      });
      releaseAssociation();
      const status = JSON.parse((await statusRequest).content[0].text);
      expect(status).toEqual(expect.objectContaining({
        launch_id: launched.launch_id,
        instance_id: 'anon:async',
        managed: true,
        state: 'connected',
        pid: 4321,
        process_running: true,
        roles: ['edit'],
      }));

      const closed = JSON.parse((await tools.manageInstance({
        action: 'close',
        instance_id: 'anon:async',
      })).content[0].text);
      expect(closed).toEqual(expect.objectContaining({
        launch_id: launched.launch_id,
        instance_id: 'anon:async',
        state: 'exited',
        close_status: 'closed',
        message: 'Studio instance closed.',
      }));
      expect(stopped).toEqual([4321]);
    } finally {
      releaseAssociation();
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('manage_instance reports and closes an async launch that never connects', async () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
    const liveProcessIds = new Set<number>();
    const stopped: number[] = [];
    const localPlaceFile = '/tmp/strain-acceptance-b/.worktree-studio/place.rbxl';
    const processAdapter = {
      currentBootId: () => 'boot-1',
      resolveStudioExe: () => 'RobloxStudioBeta.exe',
      spawnStudio: () => {
        liveProcessIds.add(5432);
        return { pid: 9002, nativePid: 5432, unref: () => {} };
      },
      listStudioProcesses: () => [...liveProcessIds].map((Id) => ({
        Id,
        Name: 'RobloxStudioBeta',
        Path: 'RobloxStudioBeta.exe',
        MainWindowTitle: 'Roblox Studio',
      })),
      stopProcess: (pid: number) => {
        stopped.push(pid);
        liveProcessIds.delete(pid);
      },
    };

    try {
      const bridge = new BridgeService();
      const tools = new RobloxStudioTools(bridge);
      (tools as any).instanceManager = new StudioInstanceManager({ registryDir, processAdapter });

      const launched = JSON.parse((await tools.manageInstance({
        action: 'launch',
        source: 'local_file',
        local_place_file: localPlaceFile,
        wait_for_connection: false,
        timeout_ms: 10,
      })).content[0].text);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const status = JSON.parse((await tools.manageInstance({
        action: 'status',
        launch_id: launched.launch_id,
      })).content[0].text);
      expect(status).toEqual(expect.objectContaining({
        launch_id: launched.launch_id,
        state: 'failed',
        pid: 5432,
        process_running: true,
        failure_reason: 'Studio launched, but the MCP plugin did not connect before timeout.',
      }));

      const closed = JSON.parse((await tools.manageInstance({
        action: 'close',
        launch_id: launched.launch_id,
      })).content[0].text);
      expect(closed).toEqual(expect.objectContaining({
        launch_id: launched.launch_id,
        state: 'failed',
        process_running: false,
        close_status: 'closed',
        message: 'Studio instance closed.',
      }));
      const closedAgain = JSON.parse((await tools.manageInstance({
        action: 'close',
        launch_id: launched.launch_id,
      })).content[0].text);
      expect(closedAgain).toEqual(expect.objectContaining({
        launch_id: launched.launch_id,
        close_status: 'already_closed',
        message: 'Studio instance was already closed.',
      }));
      expect(stopped).toEqual([5432]);
    } finally {
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('manage_instance retains terminal status after an unconnected process exits', async () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
    const liveProcessIds = new Set<number>();
    const processAdapter = {
      currentBootId: () => 'boot-1',
      resolveStudioExe: () => 'RobloxStudioBeta.exe',
      spawnStudio: () => {
        liveProcessIds.add(6543);
        return { pid: 9003, nativePid: 6543, unref: () => {} };
      },
      listStudioProcesses: () => [...liveProcessIds].map((Id) => ({
        Id,
        Name: 'RobloxStudioBeta',
        Path: 'RobloxStudioBeta.exe',
        MainWindowTitle: 'Roblox Studio',
      })),
      stopProcess: () => {},
    };

    try {
      const bridge = new BridgeService();
      const tools = new RobloxStudioTools(bridge);
      (tools as any).instanceManager = new StudioInstanceManager({
        registryDir,
        processAdapter,
        confirmedExitMisses: 1,
        confirmedExitGraceMs: 0,
      });

      const launched = JSON.parse((await tools.manageInstance({
        action: 'launch',
        source: 'local_file',
        local_place_file: '/tmp/exited-place.rbxl',
        wait_for_connection: false,
      })).content[0].text);
      liveProcessIds.clear();

      const status = JSON.parse((await tools.manageInstance({
        action: 'status',
        launch_id: launched.launch_id,
      })).content[0].text);
      expect(status).toEqual(expect.objectContaining({
        launch_id: launched.launch_id,
        state: 'exited',
        pid: 6543,
        process_running: false,
        failure_reason: 'Studio process exited before the MCP plugin connected.',
      }));
      expect(fs.existsSync(path.join(registryDir, `${launched.launch_id}.json`))).toBe(true);
    } finally {
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('overlapping launches retain distinct adapter-provided native process ids', async () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
    let spawnCount = 0;
    const processAdapter = {
      currentBootId: () => 'boot-1',
      resolveStudioExe: () => 'RobloxStudioBeta.exe',
      spawnStudio: () => {
        spawnCount += 1;
        return { pid: 9000 + spawnCount, nativePid: 6000 + spawnCount, unref: () => {} };
      },
      listStudioProcesses: () => spawnCount < 2
        ? []
        : [
          { Id: 6001, Name: 'RobloxStudioBeta', Path: 'RobloxStudioBeta.exe', MainWindowTitle: 'First - Roblox Studio' },
          { Id: 6002, Name: 'RobloxStudioBeta', Path: 'RobloxStudioBeta.exe', MainWindowTitle: 'Second - Roblox Studio' },
        ],
      stopProcess: () => {},
    };

    try {
      const manager = new StudioInstanceManager({ registryDir, processAdapter });
      const [first, second] = await Promise.all([
        manager.launch({ source: 'local_file', localPlaceFile: '/tmp/first.rbxl' }),
        manager.launch({ source: 'local_file', localPlaceFile: '/tmp/second.rbxl' }),
      ]);
      expect([first.nativeProcessId, second.nativeProcessId]).toEqual([6001, 6002]);
    } finally {
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('process observation errors preserve durable ownership and expose unknown liveness', async () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
    const pid = 6611;
    const startedAt = '100';
    let spawned = false;
    let observationFails = false;
    let observedAt = 1000;
    const processAdapter = {
      currentBootId: () => 'boot-1',
      resolveStudioExe: () => 'RobloxStudioBeta.exe',
      spawnStudio: () => {
        spawned = true;
        return { pid, nativePid: pid, nativeStartedAt: startedAt, unref: () => {} };
      },
      observeStudioProcesses: () => observationFails
        ? { status: 'error' as const, observedAt: ++observedAt, error: 'PowerShell unavailable' }
        : {
          status: 'ok' as const,
          observedAt: ++observedAt,
          processes: spawned ? [{
            Id: pid,
            Name: 'RobloxStudioBeta',
            Path: 'RobloxStudioBeta.exe',
            StartTimeUtcFileTime: startedAt,
          }] : [],
        },
      stopProcess: () => { spawned = false; },
    };

    try {
      const manager = new StudioInstanceManager({ registryDir, processAdapter });
      const record = await manager.launch({ source: 'local_file', localPlaceFile: '/tmp/unknown.rbxl' });
      await manager.attachInstanceId(record, 'anon:unknown');
      observationFails = true;

      await manager.refresh(record);
      await manager.refresh(record);

      expect(record).toEqual(expect.objectContaining({
        instanceId: 'anon:unknown',
        state: 'connected',
        processObservationStatus: 'unknown',
        lastProcessObservationError: 'PowerShell unavailable',
        consecutiveConfirmedMisses: 0,
      }));
      expect(record.closedAt).toBeUndefined();
      const persisted = JSON.parse(fs.readFileSync(path.join(registryDir, `${record.recordId}.json`), 'utf8'));
      expect(persisted).toEqual(expect.objectContaining({
        state: 'connected',
        processObservationStatus: 'unknown',
        lastProcessObservationError: 'PowerShell unavailable',
      }));
      expect(persisted.closedAt).toBeUndefined();
    } finally {
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('connected ownership survives one successful miss and closes only after confirmed absence', async () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
    const pid = 6612;
    let spawned = false;
    let observedAt = 1000;
    const processAdapter = {
      currentBootId: () => 'boot-1',
      resolveStudioExe: () => 'RobloxStudioBeta.exe',
      spawnStudio: () => {
        spawned = true;
        return { pid, nativePid: pid, unref: () => {} };
      },
      observeStudioProcesses: () => ({
        status: 'ok' as const,
        observedAt,
        processes: spawned ? [{ Id: pid, Name: 'RobloxStudioBeta', Path: 'RobloxStudioBeta.exe' }] : [],
      }),
      stopProcess: () => { spawned = false; },
    };

    try {
      const manager = new StudioInstanceManager({
        registryDir,
        processAdapter,
        confirmedExitMisses: 2,
        confirmedExitGraceMs: 5000,
      });
      const record = await manager.launch({ source: 'local_file', localPlaceFile: '/tmp/grace.rbxl' });
      observedAt = 1500;
      await manager.attachInstanceId(record, 'anon:grace');
      spawned = false;
      observedAt = 2000;

      await manager.refresh(record);
      expect(record.closedAt).toBeUndefined();
      expect(record.consecutiveConfirmedMisses).toBe(1);

      observedAt = 8000;
      await manager.refresh(record);
      expect(record).toEqual(expect.objectContaining({
        state: 'exited',
        consecutiveConfirmedMisses: 2,
        failureReason: 'Studio process exited.',
      }));
      expect(record.closedAt).toEqual(expect.any(Number));

      spawned = true;
      observedAt = 9000;
      await manager.attachInstanceId(record, 'anon:grace');
      expect(record).toEqual(expect.objectContaining({
        state: 'connected',
        processObservationStatus: 'running',
        consecutiveConfirmedMisses: 0,
      }));
      expect(record.closedAt).toBeUndefined();
      expect(record.exitedAt).toBeUndefined();
    } finally {
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('status refreshes ten managed records from one process snapshot', async () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
    let nextPid = 6700;
    let snapshotCalls = 0;
    const live = new Map<number, string>();
    const processAdapter = {
      currentBootId: () => 'boot-1',
      resolveStudioExe: () => 'RobloxStudioBeta.exe',
      spawnStudio: () => {
        const pid = ++nextPid;
        const startedAt = String(pid * 100);
        live.set(pid, startedAt);
        return { pid, nativePid: pid, nativeStartedAt: startedAt, unref: () => {} };
      },
      observeStudioProcesses: () => {
        snapshotCalls += 1;
        return {
          status: 'ok' as const,
          observedAt: Date.now(),
          processes: [...live].map(([Id, StartTimeUtcFileTime]) => ({
            Id,
            Name: 'RobloxStudioBeta',
            Path: 'RobloxStudioBeta.exe',
            StartTimeUtcFileTime,
          })),
        };
      },
      stopProcess: (pid: number) => { live.delete(pid); },
    };

    try {
      const manager = new StudioInstanceManager({ registryDir, processAdapter });
      for (let index = 0; index < 10; index += 1) {
        await manager.launch({ source: 'local_file', localPlaceFile: `/tmp/snapshot-${index}.rbxl` });
      }
      snapshotCalls = 0;

      expect(await manager.list()).toHaveLength(10);
      expect(snapshotCalls).toBe(1);
    } finally {
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('health remains responsive while an asynchronous lifecycle adapter is pending', async () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
    let releaseSpawn!: () => void;
    let signalSpawnStarted!: () => void;
    const spawnStarted = new Promise<void>((resolve) => { signalSpawnStarted = resolve; });
    const spawnBlocked = new Promise<void>((resolve) => { releaseSpawn = resolve; });
    let spawned = false;
    const processAdapter = {
      currentBootId: () => 'boot-1',
      resolveStudioExe: () => 'RobloxStudioBeta.exe',
      observeStudioProcesses: () => ({
        status: 'ok' as const,
        observedAt: Date.now(),
        processes: spawned ? [{ Id: 6801, Name: 'RobloxStudioBeta', Path: 'RobloxStudioBeta.exe' }] : [],
      }),
      spawnStudio: async () => {
        signalSpawnStarted();
        await spawnBlocked;
        spawned = true;
        return { pid: 6801, nativePid: 6801, unref: () => {} };
      },
      stopProcess: () => { spawned = false; },
    };
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    const manager = new StudioInstanceManager({ registryDir, processAdapter });
    (tools as any).instanceManager = manager;
    const app = createHttpServer(tools, bridge, new Set(['manage_instance']));
    const server = await new Promise<import('http').Server>((resolve, reject) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
      listening.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Could not determine test server port.');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const launch = fetch(`${baseUrl}/mcp/manage_instance`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'launch',
          source: 'local_file',
          local_place_file: '/tmp/health-pending.rbxl',
          wait_for_connection: false,
        }),
      });
      await spawnStarted;

      const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(100) });
      expect(health.status).toBe(200);

      releaseSpawn();
      expect((await launch).status).toBe(200);
    } finally {
      releaseSpawn();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('health remains responsive while registry lock acquisition is pending', async () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
    fs.mkdirSync(path.join(registryDir, '.lock'));
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    (tools as any).instanceManager = new StudioInstanceManager({
      registryDir,
      processAdapter: {
        currentBootId: () => 'boot-1',
        observeStudioProcesses: () => ({ status: 'ok', observedAt: Date.now(), processes: [] }),
      },
    });
    const app = createHttpServer(tools, bridge, new Set(['manage_instance']));
    const server = await new Promise<import('http').Server>((resolve, reject) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
      listening.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Could not determine test server port.');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const status = fetch(`${baseUrl}/mcp/manage_instance`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'status' }),
      });
      await new Promise((resolve) => setTimeout(resolve, 25));

      const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(100) });
      expect(health.status).toBe(200);

      fs.rmSync(path.join(registryDir, '.lock'), { recursive: true, force: true });
      expect((await status).status).toBe(200);
    } finally {
      fs.rmSync(path.join(registryDir, '.lock'), { recursive: true, force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('managed instance registry reclaims a fresh lock owned by a dead process', async () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
    const lockDir = path.join(registryDir, '.lock');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
      pid: 2_147_483_647,
      token: 'dead-owner',
      createdAt: Date.now(),
    }));

    try {
      const startedAt = Date.now();
      await expect(new ManagedInstanceRegistry(registryDir).listOpen({
        currentBootId: 'boot-1',
      })).resolves.toEqual([]);
      expect(Date.now() - startedAt).toBeLessThan(1000);
    } finally {
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  }, 10_000);

  test('managed close refuses a recycled native Studio pid with a different start time', async () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
    let processStartedAt = '100';
    const stopped: number[] = [];
    const processAdapter = {
      currentBootId: () => 'boot-1',
      resolveStudioExe: () => 'RobloxStudioBeta.exe',
      spawnStudio: () => ({ pid: 9004, nativePid: 7654, nativeStartedAt: '100', unref: () => {} }),
      listStudioProcesses: () => [{
        Id: 7654,
        Name: 'RobloxStudioBeta',
        Path: 'RobloxStudioBeta.exe',
        MainWindowTitle: 'Roblox Studio',
        StartTimeUtcFileTime: processStartedAt,
      }],
      stopProcess: (pid: number) => stopped.push(pid),
    };

    try {
      const manager = new StudioInstanceManager({ registryDir, processAdapter });
      const record = await manager.launch({ source: 'local_file', localPlaceFile: '/tmp/recycled.rbxl' });
      processStartedAt = '200';

      expect(await manager.closeByLaunchId(record.recordId as string)).toEqual(expect.objectContaining({
        status: 'already_closed',
        launchId: record.recordId,
      }));
      expect(stopped).toEqual([]);
      expect(await manager.getByLaunchId(record.recordId as string)).toEqual(expect.objectContaining({
        state: 'exited',
        failureReason: 'Studio process identity changed; the retained PID was not reused.',
      }));
    } finally {
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('manage_instance close accepts an explicit connected unmanaged instance', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance({
      ...READY,
      instanceId: 'anon:external',
      placeName: 'ExternalPlace',
      dataModelName: 'ExternalPlace',
    });
    bridge.registerInstance({
      ...READY,
      pluginSessionId: 'session-server',
      instanceId: 'anon:external',
      role: 'server',
      placeName: 'ExternalPlace',
      dataModelName: 'ExternalPlace',
      isRunning: true,
    });
    const closeConnectedInstance = jest.fn();
    const unregisterInstanceIdEverywhere = jest.spyOn(bridge, 'unregisterInstanceIdEverywhere');
    (tools as any).instanceManager = {
      get: () => undefined,
      closeByInstanceId: () => ({ status: 'not_found' }),
      closeConnectedInstance,
    };

    const result = await tools.manageInstance({
      action: 'close',
      instance_id: 'anon:external',
    });

    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({
      instance_id: 'anon:external',
      close_status: 'closed',
      message: 'Studio instance closed.',
    });
    expect(closeConnectedInstance).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: 'anon:external',
      role: 'edit',
      dataModelName: 'ExternalPlace',
    }));
    expect(unregisterInstanceIdEverywhere).toHaveBeenCalledWith('anon:external');
    expect(bridge.getPublicInstances()).toEqual([]);
  });

  test('manage_instance close recovers a managed baseplate from the shared registry', async () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
    const baseplateDir = path.join(os.tmpdir(), 'robloxstudio-mcp-baseplates');
    const placeFile = path.join(baseplateDir, 'Baseplate-123-456.rbxl');
    fs.mkdirSync(baseplateDir, { recursive: true });
    fs.writeFileSync(placeFile, '<roblox />', 'utf8');
    fs.writeFileSync(`${placeFile}.lock`, '', 'utf8');

    const liveProcessIds = new Set([4321]);
    let listCalls = 0;
    const stopped: number[] = [];
    const processAdapter = {
      currentBootId: () => 'boot-1',
      resolveStudioExe: () => 'RobloxStudioBeta.exe',
      spawnStudio: () => ({ pid: 4321, unref: () => {} }),
      listStudioProcesses: () => {
        listCalls += 1;
        if (listCalls === 1) return [];
        return [...liveProcessIds].map((Id) => ({
          Id,
          Path: 'RobloxStudioBeta.exe',
          MainWindowTitle: '',
        }));
      },
      stopProcess: (processId: number) => {
        stopped.push(processId);
        liveProcessIds.delete(processId);
      },
    };

    try {
      const launcher = new StudioInstanceManager({ registryDir, processAdapter });
      const record = await launcher.launch({ source: 'baseplate', localPlaceFile: placeFile });
      await launcher.attachInstanceId(record, 'anon:shared-baseplate');

      const bridge = new BridgeService();
      const tools = new RobloxStudioTools(bridge);
      (tools as any).instanceManager = new StudioInstanceManager({ registryDir, processAdapter });

      const result = await tools.manageInstance({
        action: 'close',
        instance_id: 'anon:shared-baseplate',
      });

      const body = JSON.parse(result.content[0].text);
      expect(body).toEqual(expect.objectContaining({
        instance_id: 'anon:shared-baseplate',
        message: 'Studio instance closed.',
        state: 'exited',
        process_running: false,
      }));
      expect(stopped).toEqual([4321]);
      expect(fs.existsSync(placeFile)).toBe(false);
      expect(fs.existsSync(`${placeFile}.lock`)).toBe(false);
    } finally {
      fs.rmSync(placeFile, { force: true });
      fs.rmSync(`${placeFile}.lock`, { force: true });
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('manage_instance close prunes previous-boot registry records without stopping recycled pids', async () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
    const baseplateDir = path.join(os.tmpdir(), 'robloxstudio-mcp-baseplates');
    const placeFile = path.join(baseplateDir, 'Baseplate-124-456.rbxl');
    fs.mkdirSync(baseplateDir, { recursive: true });
    fs.writeFileSync(placeFile, '<roblox />', 'utf8');

    const stopped: number[] = [];
    let listCalls = 0;
    const launchAdapter = {
      currentBootId: () => 'boot-1',
      resolveStudioExe: () => 'RobloxStudioBeta.exe',
      spawnStudio: () => ({ pid: 4322, unref: () => {} }),
      listStudioProcesses: () => {
        listCalls += 1;
        if (listCalls === 1) return [];
        return [{ Id: 4322, Path: 'RobloxStudioBeta.exe', MainWindowTitle: '' }];
      },
      stopProcess: (processId: number) => {
        stopped.push(processId);
      },
    };
    const closeAdapter = {
      ...launchAdapter,
      currentBootId: () => 'boot-2',
    };

    try {
      const launcher = new StudioInstanceManager({ registryDir, processAdapter: launchAdapter });
      const record = await launcher.launch({ source: 'baseplate', localPlaceFile: placeFile });
      await launcher.attachInstanceId(record, 'anon:previous-boot');

      const bridge = new BridgeService();
      const tools = new RobloxStudioTools(bridge);
      (tools as any).instanceManager = new StudioInstanceManager({ registryDir, processAdapter: closeAdapter });

      const result = await tools.manageInstance({
        action: 'close',
        instance_id: 'anon:previous-boot',
      });

      expect(JSON.parse(result.content[0].text)).toEqual(expect.objectContaining({
        instance_id: 'anon:previous-boot',
        message: 'Studio instance was already closed.',
        state: 'exited',
        process_running: false,
      }));
      expect(stopped).toEqual([]);
      expect(fs.existsSync(placeFile)).toBe(false);
      expect(readRegistryEvents(registryDir)).toContainEqual(expect.objectContaining({
        event: 'registry_marked_previous_boot_exited',
        instanceId: 'anon:previous-boot',
      }));
    } finally {
      fs.rmSync(placeFile, { force: true });
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('manage_instance close returns success when another process already stopped the managed instance', async () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
    const baseplateDir = path.join(os.tmpdir(), 'robloxstudio-mcp-baseplates');
    const placeFile = path.join(baseplateDir, 'Baseplate-125-456.rbxl');
    fs.mkdirSync(baseplateDir, { recursive: true });
    fs.writeFileSync(placeFile, '<roblox />', 'utf8');

    const liveProcessIds = new Set([4323]);
    const stopped: number[] = [];
    let listCalls = 0;
    const processAdapter = {
      currentBootId: () => 'boot-1',
      resolveStudioExe: () => 'RobloxStudioBeta.exe',
      spawnStudio: () => ({ pid: 4323, unref: () => {} }),
      listStudioProcesses: () => {
        listCalls += 1;
        if (listCalls === 1) return [];
        return [...liveProcessIds].map((Id) => ({ Id, Path: 'RobloxStudioBeta.exe', MainWindowTitle: '' }));
      },
      stopProcess: (processId: number) => {
        stopped.push(processId);
        liveProcessIds.delete(processId);
      },
    };

    try {
      const launcher = new StudioInstanceManager({ registryDir, processAdapter });
      const record = await launcher.launch({ source: 'baseplate', localPlaceFile: placeFile });
      await launcher.attachInstanceId(record, 'anon:double-close');

      const bridge = new BridgeService();
      const tools = new RobloxStudioTools(bridge);
      (tools as any).instanceManager = new StudioInstanceManager({ registryDir, processAdapter });

      const first = await tools.manageInstance({ action: 'close', instance_id: 'anon:double-close' });
      expect(JSON.parse(first.content[0].text)).toEqual(expect.objectContaining({
        instance_id: 'anon:double-close',
        close_status: 'closed',
        message: 'Studio instance closed.',
        state: 'exited',
        process_running: false,
      }));

      const second = await tools.manageInstance({ action: 'close', instance_id: 'anon:double-close' });
      expect(JSON.parse(second.content[0].text)).toEqual(expect.objectContaining({
        instance_id: 'anon:double-close',
        close_status: 'already_closed',
        message: 'Studio instance was already closed.',
        state: 'exited',
        process_running: false,
      }));
      expect(stopped).toEqual([4323]);
      expect(readRegistryEvents(registryDir)).toContainEqual(expect.objectContaining({
        event: 'registry_close_already_stopped',
        instanceId: 'anon:double-close',
      }));
    } finally {
      fs.rmSync(placeFile, { force: true });
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('manage_instance close returns a compact error for an unclosable connected unmanaged instance', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance({
      ...READY,
      instanceId: 'anon:external',
      placeName: 'ExternalPlace',
      dataModelName: 'ExternalPlace',
    });
    (tools as any).instanceManager = {
      get: () => undefined,
      closeByInstanceId: () => ({ status: 'not_found' }),
      closeConnectedInstance: () => {
        throw new Error('Could not find a Studio process for connected instance "anon:external".');
      },
    };

    const result = await tools.manageInstance({
      action: 'close',
      instance_id: 'anon:external',
    });

    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({
      error: 'Could not find a Studio process for connected instance "anon:external".',
      instance_id: 'anon:external',
    });
    expect(bridge.getPublicInstances()).toHaveLength(1);
  });

  test('manage_instance status removes malformed data and retains recent terminal records', async () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(registryDir, 'malformed.json'), '{not-json', 'utf8');
    fs.writeFileSync(path.join(registryDir, 'closed-record.json'), JSON.stringify({
      version: 1,
      recordId: 'closed-record',
      instanceId: 'anon:closed',
      source: 'baseplate',
      exe: 'RobloxStudioBeta.exe',
      args: [],
      launchedAt: Date.now(),
      closedAt: Date.now(),
      ownerPid: process.pid,
      bootId: 'boot-1',
    }), 'utf8');
    fs.writeFileSync(path.join(registryDir, 'events-2000-01-01.jsonl'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(registryDir, `events-${today}.jsonl`), '{}\n', 'utf8');

    try {
      const bridge = new BridgeService();
      const tools = new RobloxStudioTools(bridge);
      (tools as any).instanceManager = new StudioInstanceManager({
        registryDir,
        processAdapter: {
          currentBootId: () => 'boot-1',
          listStudioProcesses: () => [],
        },
      });

      const result = await tools.manageInstance({ action: 'status' });
      expect(JSON.parse(result.content[0].text)).toEqual({
        managed: [],
        connected: [],
      });

      expect(fs.existsSync(path.join(registryDir, 'malformed.json'))).toBe(false);
      expect(fs.existsSync(path.join(registryDir, 'closed-record.json'))).toBe(true);
      expect(fs.existsSync(path.join(registryDir, 'events-2000-01-01.jsonl'))).toBe(false);
      expect(fs.existsSync(path.join(registryDir, `events-${today}.jsonl`))).toBe(true);
      expect(readRegistryEvents(registryDir)).toContainEqual(expect.objectContaining({
        event: 'registry_pruned_malformed_record',
      }));
    } finally {
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('manage_instance status self-heals same-boot records whose Studio process exited', async () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
    const baseplateDir = path.join(os.tmpdir(), 'robloxstudio-mcp-baseplates');
    const placeFile = path.join(baseplateDir, 'Baseplate-126-456.rbxl');
    fs.mkdirSync(baseplateDir, { recursive: true });
    fs.writeFileSync(placeFile, '<roblox />', 'utf8');

    const liveProcessIds = new Set([4324]);
    let listCalls = 0;
    const processAdapter = {
      currentBootId: () => 'boot-1',
      resolveStudioExe: () => 'RobloxStudioBeta.exe',
      spawnStudio: () => ({ pid: 4324, unref: () => {} }),
      listStudioProcesses: () => {
        listCalls += 1;
        if (listCalls === 1) return [];
        return [...liveProcessIds].map((Id) => ({ Id, Path: 'RobloxStudioBeta.exe', MainWindowTitle: '' }));
      },
      stopProcess: () => {
        throw new Error('status should not stop processes');
      },
    };

    try {
      const launcher = new StudioInstanceManager({ registryDir, processAdapter });
      const record = await launcher.launch({ source: 'baseplate', localPlaceFile: placeFile });
      await launcher.attachInstanceId(record, 'anon:stale-process');
      liveProcessIds.clear();

      const bridge = new BridgeService();
      const tools = new RobloxStudioTools(bridge);
      (tools as any).instanceManager = new StudioInstanceManager({
        registryDir,
        processAdapter,
        confirmedExitMisses: 1,
        confirmedExitGraceMs: 0,
      });

      const result = await tools.manageInstance({ action: 'status' });
      expect(JSON.parse(result.content[0].text)).toEqual({
        managed: [],
        connected: [],
      });
      expect(fs.existsSync(placeFile)).toBe(false);
      expect(readRegistryEvents(registryDir)).toContainEqual(expect.objectContaining({
        event: 'registry_marked_process_exited',
        instanceId: 'anon:stale-process',
      }));
    } finally {
      fs.rmSync(placeFile, { force: true });
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('manage_instance list_place_versions normalizes Open Cloud asset version rows', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    const listAssetVersions = jest.fn(async () => ({
      assetVersions: [
        {
          path: 'assets/123/versions/3135',
          createTime: '2026-06-25T15:03:29.611780400Z',
          moderationResult: { moderationState: 'Approved' },
        },
      ],
      nextPageToken: 'next',
    }));
    (tools as any).openCloudClient = {
      hasApiKey: () => true,
      listAssetVersions,
    };

    const result = await tools.manageInstance({
      action: 'list_place_versions',
      place_id: 123,
      max_page_size: 100,
      page_token: 'cursor',
    });

    expect(listAssetVersions).toHaveBeenCalledWith(123, 50, 'cursor');
    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({
      versions: [{
        version: 3135,
        created_at: '2026-06-25T15:03:29.611780400Z',
        path: 'assets/123/versions/3135',
        moderation_state: 'Approved',
      }],
      next_page_token: 'next',
    });

    await tools.manageInstance({
      action: 'list_place_versions',
      place_id: 123,
      max_page_size: 0,
    });
    expect(listAssetVersions).toHaveBeenLastCalledWith(123, 1, undefined);

    await tools.manageInstance({
      action: 'list_place_versions',
      place_id: 123,
      max_page_size: -10,
    });
    expect(listAssetVersions).toHaveBeenLastCalledWith(123, 1, undefined);

    await expect(tools.manageInstance({
      action: 'list_place_versions',
      place_id: 123,
      max_page_size: 'bad',
    })).rejects.toThrow('max_page_size must be a finite number.');
  });

  test('studio launch args use the documented place revision task with derived universe id', () => {
    expect(buildStudioLaunchArgs({
      source: 'place_revision',
      placeId: 123,
      universeId: 456,
      placeVersion: 7,
    })).toEqual([
      '--task', 'EditPlaceRevision',
      '--placeId', '123',
      '--universeId', '456',
      '--placeVersion', '7',
    ]);
  });

  test('Windows Studio launch arguments preserve spaces and quotes', () => {
    expect(quoteWindowsCommandLineArg('--task')).toBe('--task');
    expect(quoteWindowsCommandLineArg('C:\\My Place\\place.rbxl')).toBe('"C:\\My Place\\place.rbxl"');
    expect(quoteWindowsCommandLineArg('name"with-quote')).toBe('"name\\"with-quote"');
  });

  test('baseplate launch args open a managed copy of the bundled baseplate', () => {
    const args = buildStudioLaunchArgs({ source: 'baseplate' });
    const placeFile = args[3];
    const templateFile = path.join(process.cwd(), 'assets', 'Baseplate.rbxl');

    expect(args.slice(0, 3)).toEqual(['--task', 'EditFile', '--localPlaceFile']);
    expect(placeFile).toMatch(/Baseplate-\d+-\d+\.rbxl$/);
    expect(fs.existsSync(placeFile)).toBe(true);
    expect(fs.readFileSync(placeFile)).toEqual(fs.readFileSync(templateFile));

    fs.rmSync(placeFile, { force: true });
  });

  test('baseplate cleanup removes generated temp files and Studio lock sidecars', () => {
    const dir = path.join(os.tmpdir(), 'robloxstudio-mcp-baseplates');
    fs.mkdirSync(dir, { recursive: true });
    const placeFile = path.join(dir, 'Baseplate-123-456.rbxl');
    const lockFile = `${placeFile}.lock`;
    fs.writeFileSync(placeFile, '<roblox />', 'utf8');
    fs.writeFileSync(lockFile, '', 'utf8');

    cleanupManagedBaseplateFiles({ source: 'baseplate', localPlaceFile: placeFile });

    expect(fs.existsSync(placeFile)).toBe(false);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  test('baseplate cleanup does not remove caller-owned local place files', () => {
    const placeFile = path.join(os.tmpdir(), 'Baseplate-user-owned.rbxlx');
    fs.writeFileSync(placeFile, '<roblox />', 'utf8');

    cleanupManagedBaseplateFiles({ source: 'local_file', localPlaceFile: placeFile });
    cleanupManagedBaseplateFiles({ source: 'baseplate', localPlaceFile: placeFile });

    expect(fs.existsSync(placeFile)).toBe(true);
    fs.rmSync(placeFile, { force: true });
  });

  test('baseplate sweep deletes stale files from dead servers but keeps fresh and foreign files', () => {
    const dir = path.join(os.tmpdir(), 'robloxstudio-mcp-baseplates');
    fs.mkdirSync(dir, { recursive: true });
    // A pid that is guaranteed dead: a child that has already exited.
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);

    const stale = path.join(dir, `Baseplate-${deadPid}-100.rbxl`);
    const staleLock = `${stale}.lock`;
    const fresh = path.join(dir, `Baseplate-${deadPid}-200.rbxl`);
    const foreign = path.join(dir, 'Baseplate-user-owned.rbxlx');
    for (const file of [stale, staleLock, fresh, foreign]) fs.writeFileSync(file, '<roblox />', 'utf8');
    for (const file of [stale, staleLock, foreign]) fs.utimesSync(file, oldTime, oldTime);

    try {
      sweepStaleBaseplateFiles();

      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(staleLock)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
      expect(fs.existsSync(foreign)).toBe(true);
    } finally {
      for (const file of [stale, staleLock, fresh, foreign]) fs.rmSync(file, { force: true });
    }
  });

  test('baseplate sweep keeps stale files whose owner server is still running', () => {
    const dir = path.join(os.tmpdir(), 'robloxstudio-mcp-baseplates');
    fs.mkdirSync(dir, { recursive: true });
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    // The jest runner's parent process is alive for the duration of the test.
    const alivePid = process.ppid;
    const staleAlive = path.join(dir, `Baseplate-${alivePid}-100.rbxl`);
    fs.writeFileSync(staleAlive, '<roblox />', 'utf8');
    fs.utimesSync(staleAlive, oldTime, oldTime);

    try {
      sweepStaleBaseplateFiles();

      expect(fs.existsSync(staleAlive)).toBe(true);
    } finally {
      fs.rmSync(staleAlive, { force: true });
    }
  });

  test('baseplate launch sweeps stale files as a side effect', () => {
    const dir = path.join(os.tmpdir(), 'robloxstudio-mcp-baseplates');
    fs.mkdirSync(dir, { recursive: true });
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const stale = path.join(dir, `Baseplate-${deadPid}-300.rbxl`);
    fs.writeFileSync(stale, '<roblox />', 'utf8');
    fs.utimesSync(stale, oldTime, oldTime);

    const args = buildStudioLaunchArgs({ source: 'baseplate' });
    const generated = args[3];

    try {
      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(generated)).toBe(true);
    } finally {
      fs.rmSync(stale, { force: true });
      fs.rmSync(generated, { force: true });
    }
  });

  test('managed baseplate launch matching ignores unrelated existing Studio connections', () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    const matches = (tools as unknown as {
      _matchesManagedLaunch(record: Record<string, unknown>, instance: typeof READY): boolean;
    })._matchesManagedLaunch.bind(tools);
    const localPlaceFile = path.join(os.tmpdir(), 'Baseplate-race-test.rbxl');
    const record = {
      source: 'baseplate',
      localPlaceFile,
      launchedAt: Date.now(),
    };

    expect(matches(record, {
      ...READY,
      instanceId: 'place:90999018355158',
      placeId: 90999018355158,
      placeName: 'STRAIN',
      dataModelName: 'STRAIN',
    })).toBe(false);
    expect(matches(record, {
      ...READY,
      instanceId: 'anon:test',
      placeId: 0,
      placeName: 'Baseplate-race-test.rbxl',
      dataModelName: 'Baseplate-race-test.rbxl',
    })).toBe(true);
  });

  test('client broker forwards client-only viewport and profiler operations', () => {
    const cwd = process.cwd();
    const repoRoot = fs.existsSync(path.join(cwd, 'studio-plugin')) ? cwd : path.resolve(cwd, '../..');
    const source = fs.readFileSync(path.join(repoRoot, 'studio-plugin/src/modules/ClientBroker.ts'), 'utf8');
    expect(source).toContain('"/api/capture-script-profiler"');
    expect(source).toContain('payload.endpoint === "/api/capture-script-profiler"');
    expect(source).toContain('"/api/capture-micro-profiler"');
    expect(source).toContain('payload.endpoint === "/api/capture-micro-profiler"');
    expect(source).toContain('\t"/api/focus-viewport",');
    expect(source).toContain('payload.endpoint === "/api/focus-viewport"');
  });

  test('breakpoints decorates response with resolved target role', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);
    bridge.registerInstance({
      pluginSessionId: 'server-1',
      instanceId: 'place:test',
      role: 'server',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'Game',
      isRunning: true,
    });

    const resultPromise = tools.breakpoints('set', {
      script_path: 'game.ServerScriptService.Main',
      line: 12,
      log_message: '"probe"',
    }, 'server', 'place:test');

    const pending = bridge.getPendingRequest('place:test', 'server');
    expect(pending?.request).toMatchObject({
      endpoint: '/api/breakpoints',
      data: {
        action: 'set',
        script_path: 'game.ServerScriptService.Main',
        line: 12,
        log_message: '"probe"',
        __mcp_instance_id: 'place:test',
        __mcp_target_role: 'server',
      },
    });
    bridge.resolveRequest(pending!.requestId, { ok: true, breakpoint: { line: 12 } });

    const result = await resultPromise;
    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({ target: 'server', ok: true, breakpoint: { line: 12 } });
  });

  test('capture_script_profiler routes to one runtime peer and writes raw json to output_path', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);
    bridge.registerInstance({
      pluginSessionId: 'client-1',
      instanceId: 'place:test',
      role: 'client',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'Game',
      isRunning: true,
    });
    const outputPath = path.join(os.tmpdir(), `rsmcp-script-profiler-${Date.now()}.json`);

    const resultPromise = tools.captureScriptProfiler('client-1', {
      duration_ms: 250,
      output_path: outputPath,
    }, 'place:test');

    const pending = bridge.getPendingRequest('place:test', 'client-1');
    expect(pending?.request).toMatchObject({
      endpoint: '/api/capture-script-profiler',
      data: {
        duration_ms: 250,
        __mcp_include_raw_json: true,
        __mcp_instance_id: 'place:test',
        __mcp_target_role: 'client-1',
      },
    });
    bridge.resolveRequest(pending!.requestId, {
      ok: true,
      raw_json: '{"Version":2}',
      top_functions: [],
      counts: { functions: 0, nodes: 0, categories: 0 },
    });

    const result = await resultPromise;
    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({
      target: 'client-1',
      ok: true,
      output_path: path.resolve(outputPath),
      top_functions: [],
      counts: { functions: 0, nodes: 0, categories: 0 },
    });
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('{"Version":2}');
    fs.rmSync(outputPath, { force: true });
  });

  test('capture_micro_profiler routes to one runtime peer and writes raw snapshot to output_path', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);
    bridge.registerInstance({
      pluginSessionId: 'server-1',
      instanceId: 'place:test',
      role: 'server',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'Game',
      isRunning: true,
    });
    const outputPath = path.join(os.tmpdir(), `rsmcp-micro-profiler-${Date.now()}.mp`);
    const summaryOutputPath = path.join(os.tmpdir(), `rsmcp-micro-profiler-${Date.now()}.json`);

    const resultPromise = tools.captureMicroProfiler('server', {
      duration_ms: 250,
      focus: 'script',
      max_events: 10000,
      max_groups: 10,
      max_timers_per_group: 3,
      summary_output_path: summaryOutputPath,
      output_path: outputPath,
      baseline_label: 'empty_baseplate',
      current_label: 'game',
      max_comparison_rows: 5,
      baseline: {
        duration_ms: 250,
        top_groups: [{ group: 'Script', total_us: 100, exclusive_us: 40, count: 2 }],
        top_timers: [{ group: 'Script', name: '$Script', total_us: 80, exclusive_us: 30, count: 2 }],
      },
    }, 'place:test');

    const pending = bridge.getPendingRequest('place:test', 'server');
    expect(pending?.request).toMatchObject({
      endpoint: '/api/capture-micro-profiler',
      data: {
        duration_ms: 250,
        focus: 'script',
        max_events: 10000,
        max_groups: 10,
        max_timers_per_group: 3,
        __mcp_include_raw_buffer: true,
        __mcp_include_comparison_index: true,
        __mcp_instance_id: 'place:test',
        __mcp_target_role: 'server',
      },
    });
    bridge.resolveRequest(pending!.requestId, {
      ok: true,
      raw_snapshot_base64: Buffer.from('micro').toString('base64'),
      duration_ms: 250,
      top_timers: [{ group: 'Script', name: '$Script', total_us: 280, exclusive_us: 90, count: 3 }],
      top_groups: [{ group: 'Script', total_us: 300, exclusive_us: 100, count: 3 }],
      counts: { events_sampled: 0 },
    });

    const result = await resultPromise;
    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({
      target: 'server',
      ok: true,
      output_path: path.resolve(outputPath),
      summary_output_path: path.resolve(summaryOutputPath),
      duration_ms: 250,
      top_timers: [{ group: 'Script', name: '$Script', total_us: 280, exclusive_us: 90, count: 3 }],
      top_groups: [{ group: 'Script', total_us: 300, exclusive_us: 100, count: 3 }],
      counts: { events_sampled: 0 },
      baseline_comparison: {
        baseline_label: 'empty_baseplate',
        current_label: 'game',
        basis: 'inclusive_us_per_second normalized by each capture analysis duration; deltas use current minus baseline.',
        coverage: { current: 'returned_rows', baseline: 'returned_rows' },
        duration_ms: { baseline: 250, current: 250 },
        groups: [{
          group: 'Script',
          matched_by: 'stable_label',
          match_confidence: 'medium',
          current_inclusive_us: 300,
          baseline_inclusive_us: 100,
          delta_inclusive_us: 200,
          current_inclusive_us_per_s: 1200,
          baseline_inclusive_us_per_s: 400,
          delta_inclusive_us_per_s: 800,
          current_exclusive_us: 100,
          baseline_exclusive_us: 40,
          delta_exclusive_us: 60,
          current_exclusive_us_per_s: 400,
          baseline_exclusive_us_per_s: 160,
          delta_exclusive_us_per_s: 240,
          current_count: 3,
          baseline_count: 2,
          delta_count: 1,
          current_count_per_s: 12,
          baseline_count_per_s: 8,
          delta_count_per_s: 4,
          delta_pct: 200,
        }],
        timers: [{
          group: 'Script',
          name: '$Script',
          matched_by: 'stable_label',
          match_confidence: 'medium',
          current_inclusive_us: 280,
          baseline_inclusive_us: 80,
          delta_inclusive_us: 200,
          current_inclusive_us_per_s: 1120,
          baseline_inclusive_us_per_s: 320,
          delta_inclusive_us_per_s: 800,
          current_exclusive_us: 90,
          baseline_exclusive_us: 30,
          delta_exclusive_us: 60,
          current_exclusive_us_per_s: 360,
          baseline_exclusive_us_per_s: 120,
          delta_exclusive_us_per_s: 240,
          current_count: 3,
          baseline_count: 2,
          delta_count: 1,
          current_count_per_s: 12,
          baseline_count_per_s: 8,
          delta_count_per_s: 4,
          delta_pct: 250,
        }],
        threads: [],
        call_edges: [],
      },
    });
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('micro');
    const summary = JSON.parse(fs.readFileSync(summaryOutputPath, 'utf8'));
    expect(summary.baseline_comparison.groups[0].delta_inclusive_us_per_s).toBe(800);
    fs.rmSync(outputPath, { force: true });
    fs.rmSync(summaryOutputPath, { force: true });
  });

  test('generate_model routes to edit context and returns brief model path response', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);

    const resultPromise = tools.generateModel({
      prompt: 'low-poly sci-fi crate',
      name: 'GeneratedCrate',
      schema: 'Body1',
      timeout_ms: 60000,
    }, 'place:test');

    const pending = bridge.getPendingRequest('place:test', 'edit');
    expect(pending?.request).toMatchObject({
      endpoint: '/api/generate-model',
      data: {
        prompt: 'low-poly sci-fi crate',
        name: 'GeneratedCrate',
        schema: 'Body1',
      },
    });
    bridge.resolveRequest(pending!.requestId, {
      success: true,
      modelPath: 'game.ServerStorage.__MCPGeneratedModels.GeneratedCrate',
    });

    const result = await resultPromise;
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: true,
      modelPath: 'game.ServerStorage.__MCPGeneratedModels.GeneratedCrate',
    });
  });

  test('generate_model sends schema_groups without a conflicting default schema', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);

    const resultPromise = tools.generateModel({
      prompt: 'low-poly vehicle',
      name: 'SegmentedVehicle',
      schema_groups: ['Body', 'Front Left Wheel', 'Front Right Wheel', 'Rear Left Wheel', 'Rear Right Wheel'],
    }, 'place:test');

    const pending = bridge.getPendingRequest('place:test', 'edit');
    expect(pending?.request.endpoint).toBe('/api/generate-model');
    expect(pending?.request.data.schema_groups).toEqual([
      'Body',
      'Front Left Wheel',
      'Front Right Wheel',
      'Rear Left Wheel',
      'Rear Right Wheel',
    ]);
    expect(pending?.request.data).not.toHaveProperty('schema');
    bridge.resolveRequest(pending!.requestId, {
      success: true,
      modelPath: 'game.ServerStorage.__MCPGeneratedModels.SegmentedVehicle',
    });

    await resultPromise;
  });

  test('generate_model source image upload uses backing textureId instead of Decal wrapper id', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge) as any;
    tools.cookieClient = { hasCookie: () => false };
    tools.openCloudClient = {
      hasApiKey: () => true,
      createAsset: jest.fn(async () => ({
        response: { assetId: '555', displayName: 'Studio Assistant Source Image', assetType: 'Decal' },
      })),
      getAssetDetails: jest.fn(async () => ({
        asset: { id: 555, textureId: 777, name: 'Studio Assistant Source Image' },
      })),
    };
    tools.resolveImageId = jest.fn(async () => {
      throw new Error('Studio resolver should not be needed when textureId is available');
    });

    // The Open Cloud upload path requires a creator identity from the environment.
    const prevUserId = process.env.ROBLOX_CREATOR_USER_ID;
    const prevGroupId = process.env.ROBLOX_CREATOR_GROUP_ID;
    process.env.ROBLOX_CREATOR_USER_ID = '123456';
    delete process.env.ROBLOX_CREATOR_GROUP_ID;

    try {
      const imageId = await tools.uploadGenerateModelReferenceImage(Buffer.from('not actually png'), 'place:test');

      expect(imageId).toBe(777);
      expect(tools.openCloudClient.createAsset).toHaveBeenCalledWith(
        expect.objectContaining({
          assetType: 'Decal',
          displayName: 'Studio Assistant Source Image',
          description: 'Studio Assistant Source Image',
          creationContext: { creator: { userId: '123456' } },
        }),
        expect.any(Buffer),
        'generate-model-reference.png',
      );
      expect(tools.resolveImageId).not.toHaveBeenCalled();
    } finally {
      if (prevUserId === undefined) delete process.env.ROBLOX_CREATOR_USER_ID;
      else process.env.ROBLOX_CREATOR_USER_ID = prevUserId;
      if (prevGroupId === undefined) delete process.env.ROBLOX_CREATOR_GROUP_ID;
      else process.env.ROBLOX_CREATOR_GROUP_ID = prevGroupId;
    }
  });

  test('generate_model source image cookie upload uses the direct Image asset id', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge) as any;
    tools.cookieClient = {
      hasCookie: () => true,
      uploadImage: jest.fn(async () => ({ assetId: 888 })),
    };
    tools.openCloudClient = { hasApiKey: () => false };

    const imageId = await tools.uploadGenerateModelReferenceImage(
      Buffer.from('not actually png'),
      'place:test',
    );

    expect(imageId).toBe(888);
    expect(tools.cookieClient.uploadImage).toHaveBeenCalledWith({
      fileContent: expect.any(Buffer),
      fileName: 'generate-model-reference.png',
      displayName: 'Studio Assistant Source Image',
      description: 'Studio Assistant Source Image',
      userId: process.env.ROBLOX_CREATOR_USER_ID,
      groupId: process.env.ROBLOX_CREATOR_GROUP_ID,
    });
  });

  test('get_script_source returns structured truncation metadata', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);

    const resultPromise = tools.getScriptSource('game.ServerScriptService.Manager', undefined, undefined, 'place:test');
    const pending = bridge.getPendingRequest('place:test', 'edit');
    expect(pending?.request.endpoint).toBe('/api/get-script-source');
    bridge.resolveRequest(pending!.requestId, {
      success: true,
      instancePath: 'game.ServerScriptService.Manager',
      className: 'Script',
      topService: 'ServerScriptService',
      lineCount: 1700,
      startLine: 1,
      endLine: 300,
      truncated: true,
      note: 'Truncated to first 300 lines; use line_range to read more.',
      numberedSource: '1  print("start")\n300 print("still here")',
    });

    const result = await resultPromise;
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({
      path: 'game.ServerScriptService.Manager',
      className: 'Script',
      lineCount: 1700,
      startLine: 1,
      endLine: 300,
      truncated: true,
      note: 'Truncated to first 300 lines; use line_range to read more.',
      source: '1  print("start")\n300 print("still here")',
    });
  });

  test('start_playtest reports already running when runtime peers are connected', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);
    bridge.registerInstance({
      pluginSessionId: 'server-1',
      instanceId: 'place:test',
      role: 'server',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'Game',
      isRunning: true,
    });
    bridge.registerInstance({
      pluginSessionId: 'client-1',
      instanceId: 'place:test',
      role: 'client',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'Game',
      isRunning: true,
    });

    const result = await tools.startPlaytest('play', undefined, 'place:test');
    expect(bridge.getPendingRequest('place:test', 'edit')).toBeNull();
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({
      success: false,
      error: 'Playtest already running.',
      message: 'A playtest is already running for this Studio place. Stop the current playtest before starting another.',
      runtimeReady: true,
      timedOut: false,
      roles: ['edit', 'server', 'client-1'],
      runtimeRoles: ['server', 'client-1'],
    });
  });

  test('start_playtest play mode waits for fresh server and client peers', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);

    const resultPromise = tools.startPlaytest('play');
    const pending = bridge.getPendingRequest('place:test', 'edit');
    expect(pending).toBeTruthy();
    bridge.resolveRequest(pending!.requestId, { success: true, message: 'started' });

    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    bridge.registerInstance({
      pluginSessionId: 'server-1',
      instanceId: 'place:test',
      role: 'server',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    bridge.registerInstance({
      pluginSessionId: 'client-1',
      instanceId: 'place:test',
      role: 'client',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });

    const result = await resultPromise;
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({
      success: true,
      runtimeReady: true,
      timedOut: false,
    });
    expect(body.roles).toContain('server');
    expect(body.roles).toContain('client-1');
  });

  test('start_playtest run mode waits only for a fresh server peer', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);

    const resultPromise = tools.startPlaytest('run');
    const pending = bridge.getPendingRequest('place:test', 'edit');
    expect(pending).toBeTruthy();
    bridge.resolveRequest(pending!.requestId, { success: true, message: 'started' });

    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    bridge.registerInstance({
      pluginSessionId: 'server-1',
      instanceId: 'place:test',
      role: 'server',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });

    const result = await resultPromise;
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({
      success: true,
      runtimeReady: true,
      timedOut: false,
    });
    expect(body.roles).toContain('server');
    expect(body.roles).not.toContain('client-1');
  });

  test('stop_playtest waits for runtime peers to disconnect', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);
    bridge.registerInstance({
      pluginSessionId: 'server-1',
      instanceId: 'place:test',
      role: 'server',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });
    bridge.registerInstance({
      pluginSessionId: 'client-1',
      instanceId: 'place:test',
      role: 'client',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });

    const resultPromise = tools.stopPlaytest();
    const pending = bridge.getPendingRequest('place:test', 'edit');
    expect(pending).toBeTruthy();
    bridge.resolveRequest(pending!.requestId, { success: true, message: 'stopping' });

    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    bridge.unregisterInstance('server-1');
    bridge.unregisterInstance('client-1');

    const result = await resultPromise;
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({
      success: true,
      runtimeStopped: true,
      timedOut: false,
    });
    expect(body.roles).toEqual(['edit']);
  });

  test('stop_playtest reports stuck teardown when runtime peers do not disconnect', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);
    bridge.registerInstance({
      pluginSessionId: 'server-1',
      instanceId: 'place:test',
      role: 'server',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });
    bridge.registerInstance({
      pluginSessionId: 'client-1',
      instanceId: 'place:test',
      role: 'client',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });
    (tools as any)._waitForRuntimeRoles = async () => ({
      ok: false,
      roles: ['edit', 'server', 'client-1'],
      timedOut: true,
    });

    const resultPromise = tools.stopPlaytest();
    const pending = bridge.getPendingRequest('place:test', 'edit');
    expect(pending).toBeTruthy();
    bridge.resolveRequest(pending!.requestId, { success: true, message: 'Playtest stopped.' });

    const result = await resultPromise;
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({
      success: false,
      error: 'Playtest teardown did not complete.',
      runtimeStopped: false,
      timedOut: true,
      stopSignalAccepted: true,
      roles: ['edit', 'server', 'client-1'],
      runtimeRoles: ['server', 'client-1'],
    });
    expect(body.message).toContain('did not disconnect');
    expect(body.possibleCause).toContain('BindToClose');
    expect(body.possibleCause).toContain('No runtime hard-stop or synthetic keyboard fallback');
    expect(body.fallbacks).toBeUndefined();
  });

  test('stop_playtest reports edit request failure when runtime peers remain', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);
    bridge.registerInstance({
      pluginSessionId: 'server-1',
      instanceId: 'place:test',
      role: 'server',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });

    const resultPromise = tools.stopPlaytest();
    const pending = bridge.getPendingRequest('place:test', 'edit');
    expect(pending).toBeTruthy();
    bridge.rejectRequest(pending!.requestId, new Error('edit peer timed out'));

    const result = await resultPromise;
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({
      success: false,
      error: 'Playtest teardown did not complete.',
      message: 'Edit stop request failed, and runtime peers are still connected.',
      runtimeStopped: false,
      timedOut: false,
      roles: ['edit', 'server'],
      stopSignalAccepted: false,
      runtimeRoles: ['server'],
    });
    expect(body.detail).toContain('edit peer timed out');
    expect(body.stopRequestError).toContain('edit peer timed out');
    expect(body.fallbacks).toBeUndefined();
  });

  test('stop_playtest accepts stale anon id after publish and waits for runtime peers', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance({
      ...READY,
      pluginSessionId: 'edit-stale',
      instanceId: 'anon:old-file-id',
      placeId: 0,
    });
    bridge.updateInstanceMetadata('edit-stale', { placeId: 12345 });
    bridge.registerInstance({
      pluginSessionId: 'server-1',
      instanceId: 'place:12345',
      role: 'server',
      placeId: 12345,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });
    bridge.registerInstance({
      pluginSessionId: 'client-1',
      instanceId: 'place:12345',
      role: 'client',
      placeId: 12345,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });

    const resultPromise = tools.stopPlaytest('anon:old-file-id');
    const pending = bridge.getPendingRequest('place:12345', 'edit');
    expect(pending).toBeTruthy();
    bridge.resolveRequest(pending!.requestId, { success: true, message: 'stopping' });

    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    bridge.unregisterInstance('server-1');
    bridge.unregisterInstance('client-1');

    const result = await resultPromise;
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({
      success: true,
      runtimeStopped: true,
      timedOut: false,
    });
    expect(body.roles).toEqual(['edit']);
  });

  test('solo_playtest start returns a brief ready response', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);

    const resultPromise = tools.soloPlaytest('start', 'run', 1);
    const pending = bridge.getPendingRequest('place:test', 'edit');
    expect(pending).toBeTruthy();
    bridge.resolveRequest(pending!.requestId, { success: true, message: 'started' });
    bridge.registerInstance({
      pluginSessionId: 'server-1',
      instanceId: 'place:test',
      role: 'server',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });

    const result = await resultPromise;
    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({
      success: true,
      action: 'start',
      message: 'Playtest started.',
      roles: ['edit', 'server'],
    });
  });

  test('solo_playtest stop returns a brief stopped response', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);
    bridge.registerInstance({
      pluginSessionId: 'server-1',
      instanceId: 'place:test',
      role: 'server',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });

    const resultPromise = tools.soloPlaytest('stop', undefined, 1);
    const pending = bridge.getPendingRequest('place:test', 'edit');
    expect(pending).toBeTruthy();
    bridge.resolveRequest(pending!.requestId, { success: true, message: 'stopping' });
    bridge.unregisterInstance('server-1');

    const result = await resultPromise;
    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({
      success: true,
      action: 'stop',
      message: 'Playtest stopped.',
    });
  });

  test('multiplayer_playtest status returns a brief state summary', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);
    (tools as any)._buildMultiplayerState = async () => ({
      phase: 'running',
      peers: [{ role: 'edit' }, { role: 'server' }, { role: 'client-1' }],
      clientRoles: ['client-1'],
      playerCount: 1,
      testArgs: { noisy: true },
    });

    const result = await tools.multiplayerPlaytest('status', undefined, undefined, undefined, undefined, undefined, 'place:test');
    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({
      success: true,
      action: 'status',
      phase: 'running',
      roles: ['edit', 'server', 'client-1'],
      playerCount: 1,
    });
  });

  test('multiplayer_playtest start waits for detected server and client peers', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge) as any;
    tools._buildMultiplayerState = async () => ({
      peers: [{ role: 'edit' }, { role: 'server' }, { role: 'client-1' }],
      clientRoles: ['client-1'],
      playerCount: 1,
    });
    bridge.registerInstance(READY);

    const resultPromise = tools.multiplayerPlaytest('start', 1, undefined, undefined, undefined, 2, 'place:test');
    const pending = bridge.getPendingRequest('place:test', 'edit');
    expect(pending?.request).toMatchObject({
      endpoint: '/api/multiplayer-test-start',
      data: { numPlayers: 1, testArgs: {} },
    });
    bridge.resolveRequest(pending!.requestId, {
      success: true,
      message: 'Multiplayer Studio test starting with 1 player(s).',
    });
    bridge.registerInstance({
      pluginSessionId: 'server-1',
      instanceId: 'place:test',
      role: 'server',
      placeId: 0,
      placeName: 'Game',
      dataModelName: 'Game',
      isRunning: true,
    });
    bridge.registerInstance({
      pluginSessionId: 'client-1',
      instanceId: 'place:test',
      role: 'client',
      placeId: 0,
      placeName: 'Game',
      dataModelName: 'Game',
      isRunning: true,
    });

    const result = await resultPromise;
    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({
      success: true,
      action: 'start',
      message: 'Multiplayer playtest started.',
      roles: ['edit', 'server', 'client-1'],
      playerCount: 1,
    });
  });

  test('multiplayer start reports failure when peers are not detected before timeout', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge) as any;
    tools._buildMultiplayerState = async () => ({
      peers: [{ role: 'edit' }],
      clientRoles: [],
      playerCount: 0,
    });
    bridge.registerInstance(READY);

    const resultPromise = tools.multiplayerPlaytest('start', 1, undefined, undefined, undefined, 0.1, 'place:test');
    const pending = bridge.getPendingRequest('place:test', 'edit');
    bridge.resolveRequest(pending!.requestId, {
      success: true,
      message: 'Multiplayer Studio test starting with 1 player(s).',
    });

    const result = await resultPromise;
    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({
      success: false,
      action: 'start',
      error: 'multiplayer_start_not_detected',
      message: 'Multiplayer Studio test start was requested, but MCP did not detect the required server/client peers before timeout.',
      roles: ['edit'],
    });
  });

  test('multiplayer_playtest add_players returns a brief result', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge) as any;
    tools.multiplayerTestAddPlayers = jest.fn(async () => ({
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          ready: true,
          roles: ['edit', 'server', 'client-1', 'client-2'],
          wait: { ok: true, timedOut: false },
          state: {
            clientRoles: ['client-1', 'client-2'],
            playerCount: 2,
            players: [{ name: 'Player1' }, { name: 'Player2' }],
          },
        }),
      }],
    }));

    const result = await tools.multiplayerPlaytest('add_players', 1, undefined, undefined, undefined, 2, 'place:test');
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: true,
      action: 'add_players',
      message: 'Players added.',
      roles: ['edit', 'server', 'client-1', 'client-2'],
      playerCount: 2,
    });
  });

  test('multiplayer_playtest leave_client returns a brief result', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge) as any;
    tools.multiplayerTestLeaveClient = jest.fn(async () => ({
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          left: true,
          roles: ['edit', 'server', 'client-1'],
          state: { playerCount: 1, players: [{ name: 'Player1' }] },
        }),
      }],
    }));

    const result = await tools.multiplayerPlaytest('leave_client', undefined, 'client-2', undefined, undefined, 2, 'place:test');
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: true,
      action: 'leave_client',
      message: 'Client left.',
      roles: ['edit', 'server', 'client-1'],
    });
  });

  test('multiplayer_playtest end calls the server and confirms teardown', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge) as any;
    tools._waitForMultiplayerEditDone = jest.fn(async () => true);
    tools._waitForRuntimeRoles = jest.fn(async () => ({ ok: true, timedOut: false, roles: ['edit'] }));
    tools._buildMultiplayerState = jest.fn(async () => ({ phase: 'completed', peers: [{ role: 'edit' }] }));
    bridge.registerInstance(READY);
    bridge.registerInstance({
      pluginSessionId: 'server-1',
      instanceId: 'place:test',
      role: 'server',
      placeId: 0,
      placeName: 'Game',
      dataModelName: 'Game',
      isRunning: true,
    });

    const wrapperPromise = tools.multiplayerPlaytest('end', undefined, undefined, undefined, 'done', 1, 'place:test');
    const pending = bridge.getPendingRequest('place:test', 'server');
    expect(pending?.request).toMatchObject({
      endpoint: '/api/multiplayer-test-end',
      data: { value: 'done' },
    });
    bridge.resolveRequest(pending!.requestId, {
      success: true,
      message: 'Multiplayer Studio test end requested.',
      value: 'done',
    });

    const wrapperResult = await wrapperPromise;
    const wrapperBody = JSON.parse(wrapperResult.content[0].text);
    expect(wrapperBody).toEqual({
      success: true,
      action: 'end',
      message: 'Multiplayer playtest ended.',
      teardownConfirmed: true,
    });
    expect(tools._waitForMultiplayerEditDone).toHaveBeenCalledWith('place:test', 1);
    expect(tools._waitForRuntimeRoles).toHaveBeenCalledWith('place:test', { noRuntime: true }, 1);
  });

  test('multiplayer start keeps waiting when edit phase completes before peers register', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge) as any;
    const exactChecks = jest.fn()
      .mockResolvedValueOnce({ ok: false, roles: ['edit'], timedOut: true })
      .mockResolvedValueOnce({ ok: true, roles: ['edit', 'server', 'client-1'], timedOut: false });
    tools._waitForExactClientCount = exactChecks;
    tools.client = {
      request: jest.fn(async () => ({
        session: { phase: 'completed' },
      })),
    };

    const result = await tools._waitForMultiplayerStart('place:test', 1, 1);

    expect(result).toEqual({
      ok: true,
      roles: ['edit', 'server', 'client-1'],
      timedOut: false,
      error: undefined,
    });
    expect(exactChecks).toHaveBeenCalledTimes(2);
  });

  test('get_scene_analysis fans out to connected peers', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);
    bridge.registerInstance({
      pluginSessionId: 'server-1',
      instanceId: 'place:test',
      role: 'server',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });

    const resultPromise = tools.getSceneAnalysis('script_memory', 'all', 5, false, 'place:test');
    const editPending = bridge.getPendingRequest('place:test', 'edit');
    const serverPending = bridge.getPendingRequest('place:test', 'server');
    expect(editPending?.request).toMatchObject({
      endpoint: '/api/get-scene-analysis',
      data: { mode: 'script_memory', topN: 5, raw: false },
    });
    expect(serverPending?.request).toMatchObject({
      endpoint: '/api/get-scene-analysis',
      data: { mode: 'script_memory', topN: 5, raw: false },
    });

    bridge.resolveRequest(editPending!.requestId, { mode: 'script_memory', peer: 'edit' });
    bridge.resolveRequest(serverPending!.requestId, { mode: 'script_memory', peer: 'server' });

    const result = await resultPromise;
    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({
      edit: { mode: 'script_memory', peer: 'edit' },
      server: { mode: 'script_memory', peer: 'server' },
    });
  });

  test('set_network_profile fans out to connected clients only', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);
    bridge.registerInstance({
      pluginSessionId: 'server-1',
      instanceId: 'place:test',
      role: 'server',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });
    bridge.registerInstance({
      pluginSessionId: 'client-1',
      instanceId: 'place:test',
      role: 'client',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });
    bridge.registerInstance({
      pluginSessionId: 'client-2',
      instanceId: 'place:test',
      role: 'client',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });

    const resultPromise = tools.setNetworkProfile('good', 'all-clients', undefined, 'place:test');
    const editPending = bridge.getPendingRequest('place:test', 'edit');
    const serverPending = bridge.getPendingRequest('place:test', 'server');
    const client1Pending = bridge.getPendingRequest('place:test', 'client-1');
    const client2Pending = bridge.getPendingRequest('place:test', 'client-2');

    expect(editPending).toBeNull();
    expect(serverPending).toBeNull();
    expect(client1Pending?.request).toMatchObject({ endpoint: '/api/execute-luau' });
    expect(client2Pending?.request).toMatchObject({ endpoint: '/api/execute-luau' });
    expect(client1Pending?.request.data.code).toContain('NetworkSettings');
    expect(client1Pending?.request.data.code).toContain('InboundNetworkMinDelayMs');
    expect(client1Pending?.request.data.code).toContain('50');
    expect(client1Pending?.request.data.code).toContain('10');

    bridge.resolveRequest(client1Pending!.requestId, {
      success: true,
      returnValue: JSON.stringify({
        profile: 'good',
        applied: { InboundNetworkMinDelayMs: 50 },
        after: { InboundNetworkMinDelayMs: 50 },
      }),
    });
    bridge.resolveRequest(client2Pending!.requestId, {
      success: true,
      returnValue: JSON.stringify({
        profile: 'good',
        applied: { InboundNetworkMinDelayMs: 50 },
        after: { InboundNetworkMinDelayMs: 50 },
      }),
    });

    const result = await resultPromise;
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({
      profile: 'good',
      target: 'all-clients',
      applied: {
        InboundNetworkMinDelayMs: 50,
        OutboundNetworkMinDelayMs: 50,
        InboundNetworkJitterMs: 10,
        OutboundNetworkJitterMs: 10,
        InboundNetworkLossPercent: 0,
        OutboundNetworkLossPercent: 0,
      },
      targets: {
        'client-1': { profile: 'good', after: { InboundNetworkMinDelayMs: 50 } },
        'client-2': { profile: 'good', after: { InboundNetworkMinDelayMs: 50 } },
      },
    });
  });

  test('set_network_profile rejects non-client targets', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);

    await expect(tools.setNetworkProfile('good', 'server', undefined, 'place:test')).rejects.toThrow(/client-N|all-clients/);
  });

  test('set_network_profile rejects the tool call when any fanout target fails', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);
    bridge.registerInstance({
      pluginSessionId: 'client-1',
      instanceId: 'place:test',
      role: 'client',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });
    bridge.registerInstance({
      pluginSessionId: 'client-2',
      instanceId: 'place:test',
      role: 'client',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });

    const resultPromise = tools.setNetworkProfile('good', 'all-clients', undefined, 'place:test');
    const client1Pending = bridge.getPendingRequest('place:test', 'client-1');
    const client2Pending = bridge.getPendingRequest('place:test', 'client-2');
    bridge.resolveRequest(client1Pending!.requestId, {
      success: true,
      returnValue: JSON.stringify({
        profile: 'good',
        applied: { InboundNetworkMinDelayMs: 50 },
        after: { InboundNetworkMinDelayMs: 50 },
      }),
    });
    bridge.rejectRequest(client2Pending!.requestId, new Error('client-2 disconnected'));

    await expect(resultPromise).rejects.toThrow(/set_network_profile failed.*client-2.*disconnected/);
  });

  test('set_network_profile rejects packet loss above Roblox engine limit', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);

    await expect(tools.setNetworkProfile('custom', 'client-1', {
      InboundNetworkLossPercent: 0.5001,
    })).rejects.toThrow(/Roblox engine limits packet loss simulation to 0\.5%/);

    await expect(tools.setNetworkProfile('custom', 'client-1', {
      OutboundNetworkLossPercent: 1,
    })).rejects.toThrow(/Roblox engine limits packet loss simulation to 0\.5%/);
  });

  test('set_network_profile rejects negative network overrides', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);

    await expect(tools.setNetworkProfile('custom', 'client-1', {
      InboundNetworkMinDelayMs: -1,
    })).rejects.toThrow(/InboundNetworkMinDelayMs.*greater than or equal to 0/);

    await expect(tools.setNetworkProfile('custom', 'client-1', {
      OutboundNetworkJitterMs: -0.1,
    })).rejects.toThrow(/OutboundNetworkJitterMs.*greater than or equal to 0/);

    await expect(tools.setNetworkProfile('custom', 'client-1', {
      InboundNetworkLossPercent: -0.1,
    })).rejects.toThrow(/InboundNetworkLossPercent.*greater than or equal to 0/);
  });

  test('set_network_profile allows packet loss at Roblox engine limit', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);
    bridge.registerInstance({
      pluginSessionId: 'client-1',
      instanceId: 'place:test',
      role: 'client',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });

    const resultPromise = tools.setNetworkProfile('custom', 'client-1', {
      InboundNetworkLossPercent: 0.5,
    }, 'place:test');
    const pending = bridge.getPendingRequest('place:test', 'client-1');
    expect(pending?.request).toMatchObject({ endpoint: '/api/execute-luau' });
    expect(pending?.request.data.code).toContain('\\"InboundNetworkLossPercent\\":0.5');
    bridge.resolveRequest(pending!.requestId, {
      success: true,
      returnValue: JSON.stringify({
        profile: 'custom',
        applied: { InboundNetworkLossPercent: 0.5 },
        after: { InboundNetworkLossPercent: 0.5 },
      }),
    });

    const result = await resultPromise;
    const body = JSON.parse(result.content[0].text);
    expect(body.targets['client-1']).toMatchObject({
      applied: { InboundNetworkLossPercent: 0.5 },
      after: { InboundNetworkLossPercent: 0.5 },
    });
  });

  test('get_simulation_state reads edit and connected clients while skipping server', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);
    bridge.registerInstance({
      pluginSessionId: 'server-1',
      instanceId: 'place:test',
      role: 'server',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });
    bridge.registerInstance({
      pluginSessionId: 'client-1',
      instanceId: 'place:test',
      role: 'client',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });

    const resultPromise = tools.getSimulationState('both', 'edit-and-clients', 'place:test');
    const editNetworkPending = bridge.getPendingRequest('place:test', 'edit');
    const clientNetworkPending = bridge.getPendingRequest('place:test', 'client-1');
    const serverPending = bridge.getPendingRequest('place:test', 'server');
    expect(serverPending).toBeNull();
    expect(editNetworkPending?.request).toMatchObject({ endpoint: '/api/execute-luau' });
    expect(clientNetworkPending?.request).toMatchObject({ endpoint: '/api/execute-luau' });
    expect(editNetworkPending?.request.data.code).toContain('NetworkSettings');
    expect(clientNetworkPending?.request.data.code).toContain('NetworkSettings');

    bridge.resolveRequest(editNetworkPending!.requestId, {
      success: true,
      returnValue: JSON.stringify({ success: true, state: ZERO_NETWORK_STATE }),
    });
    bridge.resolveRequest(clientNetworkPending!.requestId, {
      success: true,
      returnValue: JSON.stringify({ success: true, state: DIRTY_NETWORK_STATE }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const editDevicePending = bridge.getPendingRequest('place:test', 'edit');
    const clientDevicePending = bridge.getPendingRequest('place:test', 'client-1');
    expect(editDevicePending?.request).toMatchObject({ endpoint: '/api/execute-luau' });
    expect(clientDevicePending?.request).toMatchObject({ endpoint: '/api/execute-luau' });
    expect(editDevicePending?.request.data.code).toContain('StudioDeviceSimulatorService');
    expect(clientDevicePending?.request.data.code).toContain('StudioDeviceSimulatorService');

    bridge.resolveRequest(editDevicePending!.requestId, {
      success: true,
      returnValue: JSON.stringify({ activeDeviceId: 'default', isSimulating: false }),
    });
    bridge.resolveRequest(clientDevicePending!.requestId, {
      success: true,
      returnValue: JSON.stringify({ activeDeviceId: 'iphone_XR', isSimulating: true, orientation: 'LandscapeRight' }),
    });

    const result = await resultPromise;
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({
      include: 'both',
      target: 'edit-and-clients',
      roles: {
        edit: {
          network: { success: true, state: ZERO_NETWORK_STATE },
          deviceSimulator: { activeDeviceId: 'default', isSimulating: false },
        },
        'client-1': {
          network: { success: true, state: DIRTY_NETWORK_STATE },
          deviceSimulator: { activeDeviceId: 'iphone_XR', isSimulating: true },
        },
      },
      warnings: [],
    });
    expect(body.roles.server).toBeUndefined();
    expect(body.persistenceNotes).toEqual(expect.arrayContaining([
      expect.stringContaining('Normal Play'),
      expect.stringContaining('StudioTestService'),
    ]));
  });

  test('get_simulation_state respects network-only and device-only includes', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);

    const networkOnlyPromise = tools.getSimulationState('network', 'edit', 'place:test');
    const networkPending = bridge.getPendingRequest('place:test', 'edit');
    expect(networkPending?.request).toMatchObject({ endpoint: '/api/execute-luau' });
    expect(networkPending?.request.data.code).toContain('NetworkSettings');
    expect(networkPending?.request.data.code).not.toContain('StudioDeviceSimulatorService');
    bridge.resolveRequest(networkPending!.requestId, {
      success: true,
      returnValue: JSON.stringify({ success: true, state: ZERO_NETWORK_STATE }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bridge.getPendingRequest('place:test', 'edit')).toBeNull();
    const networkOnly = JSON.parse((await networkOnlyPromise).content[0].text);
    expect(networkOnly).toMatchObject({
      include: 'network',
      roles: { edit: { network: { state: ZERO_NETWORK_STATE } } },
    });
    expect(networkOnly.roles.edit.deviceSimulator).toBeUndefined();

    const deviceOnlyPromise = tools.getSimulationState('deviceSimulator', 'edit', 'place:test');
    const devicePending = bridge.getPendingRequest('place:test', 'edit');
    expect(devicePending?.request).toMatchObject({ endpoint: '/api/execute-luau' });
    expect(devicePending?.request.data.code).toContain('StudioDeviceSimulatorService');
    expect(devicePending?.request.data.code).not.toContain('NetworkSettings');
    bridge.resolveRequest(devicePending!.requestId, {
      success: true,
      returnValue: JSON.stringify({ activeDeviceId: 'default', isSimulating: false }),
    });

    const deviceOnly = JSON.parse((await deviceOnlyPromise).content[0].text);
    expect(deviceOnly).toMatchObject({
      include: 'deviceSimulator',
      roles: { edit: { deviceSimulator: { activeDeviceId: 'default', isSimulating: false } } },
    });
    expect(deviceOnly.roles.edit.network).toBeUndefined();
  });

  test('reset_simulation_state resets network and device state for edit and clients only', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);
    bridge.registerInstance({
      pluginSessionId: 'server-1',
      instanceId: 'place:test',
      role: 'server',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });
    bridge.registerInstance({
      pluginSessionId: 'client-1',
      instanceId: 'place:test',
      role: 'client',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });

    const resultPromise = tools.resetSimulationState(undefined, undefined, undefined, 'place:test');
    const editNetworkPending = bridge.getPendingRequest('place:test', 'edit');
    const clientNetworkPending = bridge.getPendingRequest('place:test', 'client-1');
    const serverPending = bridge.getPendingRequest('place:test', 'server');
    expect(serverPending).toBeNull();
    expect(editNetworkPending?.request.data.code).toContain('NetworkSettings');
    expect(editNetworkPending?.request.data.code).toContain('ns[key] = value');
    expect(clientNetworkPending?.request.data.code).toContain('NetworkSettings');
    expect(clientNetworkPending?.request.data.code).toContain('ns[key] = value');

    bridge.resolveRequest(editNetworkPending!.requestId, {
      success: true,
      returnValue: JSON.stringify({ success: true, applied: ZERO_NETWORK_STATE, before: DIRTY_NETWORK_STATE, after: ZERO_NETWORK_STATE }),
    });
    bridge.resolveRequest(clientNetworkPending!.requestId, {
      success: true,
      returnValue: JSON.stringify({ success: true, applied: ZERO_NETWORK_STATE, before: DIRTY_NETWORK_STATE, after: ZERO_NETWORK_STATE }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const editDevicePending = bridge.getPendingRequest('place:test', 'edit');
    const clientDevicePending = bridge.getPendingRequest('place:test', 'client-1');
    expect(editDevicePending?.request.data.code).toContain('StopSimulationAsync');
    expect(clientDevicePending?.request.data.code).toContain('StopSimulationAsync');

    bridge.resolveRequest(editDevicePending!.requestId, {
      success: true,
      returnValue: JSON.stringify({
        success: true,
        applied: { stopSimulation: true },
        before: { activeDeviceId: 'iphone_XR', isSimulating: true },
        after: { activeDeviceId: 'default', isSimulating: false },
      }),
    });
    bridge.resolveRequest(clientDevicePending!.requestId, {
      success: true,
      returnValue: JSON.stringify({
        success: true,
        applied: { stopSimulation: true },
        before: { activeDeviceId: 'iphone_XR', isSimulating: true },
        after: { activeDeviceId: 'default', isSimulating: false },
      }),
    });

    const result = await resultPromise;
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({
      success: true,
      target: 'edit-and-clients',
      network: true,
      deviceSimulator: true,
      roles: {
        edit: {
          network: true,
          deviceSimulator: true,
        },
        'client-1': {
          network: true,
          deviceSimulator: true,
        },
      },
      warnings: [],
    });
    expect(body.roles.server).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('"before"');
    expect(JSON.stringify(body)).not.toContain('"after"');
    expect(JSON.stringify(body)).not.toContain('"applied"');
    expect(body.persistenceNotes).toBeUndefined();
  });

  test('reset_simulation_state rejects the tool call when any reset operation fails', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);

    const resultPromise = tools.resetSimulationState('edit', true, false, 'place:test');
    const pending = bridge.getPendingRequest('place:test', 'edit');
    expect(pending?.request).toMatchObject({ endpoint: '/api/execute-luau' });
    bridge.rejectRequest(pending!.requestId, new Error('network reset boom'));

    await expect(resultPromise).rejects.toThrow(/reset_simulation_state failed.*edit\.network.*network reset boom/);
  });

  test('reset_simulation_state warns but does not fail when all-clients has no clients', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);

    const result = await tools.resetSimulationState('all-clients', true, false, 'place:test');
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({
      success: true,
      target: 'all-clients',
      network: true,
      deviceSimulator: false,
      roles: {},
    });
    expect(body.warnings).toEqual([expect.stringContaining('No connected playtest client roles')]);
    expect(bridge.getPendingRequest('place:test', 'edit')).toBeNull();
  });

  test('simulation state tools reject server target and empty reset', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);

    await expect(tools.getSimulationState('both', 'server', 'place:test')).rejects.toThrow(/edit|client-N|all-clients|edit-and-clients/);
    await expect(tools.resetSimulationState('server', undefined, undefined, 'place:test')).rejects.toThrow(/edit|client-N|all-clients|edit-and-clients/);
    await expect(tools.resetSimulationState('edit', false, false, 'place:test')).rejects.toThrow(/network=true and\/or deviceSimulator=true/);
  });

  test('get_device_simulator_state defaults to the edit peer', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);

    const resultPromise = tools.getDeviceSimulatorState(undefined, undefined, undefined, 'place:test');
    const pending = bridge.getPendingRequest('place:test', 'edit');
    expect(pending?.request).toMatchObject({ endpoint: '/api/execute-luau' });
    expect(pending?.request.data.code).toContain('StudioDeviceSimulatorService');
    expect(pending?.request.data.code).toContain('GetDeviceAsync');
    expect(pending?.request.data.code).toContain('GetDeviceListAsync');

    bridge.resolveRequest(pending!.requestId, {
      success: true,
      returnValue: JSON.stringify({
        activeDeviceId: 'default',
        isSimulating: false,
        devices: [{ DeviceId: 'iphone_XR' }],
      }),
    });

    const result = await resultPromise;
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({
      target: 'edit',
      role: 'edit',
      activeDeviceId: 'default',
      isSimulating: false,
      devices: [{ DeviceId: 'iphone_XR' }],
    });
  });

  test('set_device_simulator fans out to connected clients only', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);
    bridge.registerInstance({
      pluginSessionId: 'server-1',
      instanceId: 'place:test',
      role: 'server',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });
    bridge.registerInstance({
      pluginSessionId: 'client-1',
      instanceId: 'place:test',
      role: 'client',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });
    bridge.registerInstance({
      pluginSessionId: 'client-2',
      instanceId: 'place:test',
      role: 'client',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });

    const resultPromise = tools.setDeviceSimulator('all-clients', 'iphone_XR', 'LandscapeRight', undefined, undefined, undefined, undefined, 'place:test');
    const editPending = bridge.getPendingRequest('place:test', 'edit');
    const serverPending = bridge.getPendingRequest('place:test', 'server');
    const client1Pending = bridge.getPendingRequest('place:test', 'client-1');
    const client2Pending = bridge.getPendingRequest('place:test', 'client-2');

    expect(editPending).toBeNull();
    expect(serverPending).toBeNull();
    expect(client1Pending?.request).toMatchObject({ endpoint: '/api/execute-luau' });
    expect(client2Pending?.request).toMatchObject({ endpoint: '/api/execute-luau' });
    expect(client1Pending?.request.data.code).toContain('StudioDeviceSimulatorService');
    expect(client1Pending?.request.data.code).toContain('SetDeviceAsync');
    expect(client1Pending?.request.data.code).toContain('SetOrientationAsync');

    const payload = {
      success: true,
      applied: { deviceId: 'iphone_XR', orientation: 'LandscapeRight' },
      before: { activeDeviceId: 'default', isSimulating: false },
      after: { activeDeviceId: 'iphone_XR', isSimulating: true },
    };
    bridge.resolveRequest(client1Pending!.requestId, { success: true, returnValue: JSON.stringify(payload) });
    bridge.resolveRequest(client2Pending!.requestId, { success: true, returnValue: JSON.stringify(payload) });

    const result = await resultPromise;
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({
      target: 'all-clients',
      targets: {
        'client-1': { applied: { deviceId: 'iphone_XR', orientation: 'LandscapeRight' } },
        'client-2': { applied: { deviceId: 'iphone_XR', orientation: 'LandscapeRight' } },
      },
    });
  });

  test('set_device_simulator rejects server target and stopSimulation combinations', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);

    await expect(tools.setDeviceSimulator('server', 'iphone_XR', undefined, undefined, undefined, undefined, undefined, 'place:test')).rejects.toThrow(/edit|client-N/);
    await expect(tools.setDeviceSimulator('edit', 'iphone_XR', undefined, undefined, undefined, undefined, true, 'place:test')).rejects.toThrow(/stopSimulation=true cannot be combined/);
  });

  test('set_device_simulator rejects the tool call when any fanout target fails', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);
    bridge.registerInstance({
      pluginSessionId: 'client-1',
      instanceId: 'place:test',
      role: 'client',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });
    bridge.registerInstance({
      pluginSessionId: 'client-2',
      instanceId: 'place:test',
      role: 'client',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });

    const resultPromise = tools.setDeviceSimulator('all-clients', 'iphone_XR', undefined, undefined, undefined, undefined, undefined, 'place:test');
    const client1Pending = bridge.getPendingRequest('place:test', 'client-1');
    const client2Pending = bridge.getPendingRequest('place:test', 'client-2');
    bridge.resolveRequest(client1Pending!.requestId, {
      success: true,
      returnValue: JSON.stringify({
        success: true,
        applied: { deviceId: 'iphone_XR' },
        before: { activeDeviceId: 'default', isSimulating: false },
        after: { activeDeviceId: 'iphone_XR', isSimulating: true },
      }),
    });
    bridge.rejectRequest(client2Pending!.requestId, new Error('client-2 simulator failed'));

    await expect(resultPromise).rejects.toThrow(/set_device_simulator failed.*client-2.*simulator failed/);
  });

  test('capture_device_matrix rejects unsupported targets', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);

    await expect(tools.captureDeviceMatrix([{ deviceId: 'iphone_XR' }], 'server', undefined, undefined, undefined, undefined, 'place:test')).rejects.toThrow(/edit|client-N/);
    await expect(tools.captureDeviceMatrix([{ deviceId: 'iphone_XR' }], 'all-clients', undefined, undefined, undefined, undefined, 'place:test')).rejects.toThrow(/edit|client-N/);
  });

  test('capture_device_matrix rejects active custom device before mutating when restore is enabled', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);

    const resultPromise = tools.captureDeviceMatrix(
      [{ label: 'phone', deviceId: 'iphone_XR' }],
      'edit',
      'jpeg',
      80,
      0,
      true,
      'place:test',
    );

    const snapshotPending = bridge.getPendingRequest('place:test', 'edit');
    expect(snapshotPending?.request).toMatchObject({ endpoint: '/api/execute-luau' });
    bridge.resolveRequest(snapshotPending!.requestId, {
      success: true,
      returnValue: JSON.stringify({
        activeDeviceId: 'custom_phone',
        isSimulating: true,
        devices: [{ DeviceId: 'iphone_XR', IsCustom: false }],
      }),
    });

    await expect(resultPromise).rejects.toThrow(/cannot safely restore active custom device "custom_phone"/);
    expect(bridge.getPendingRequest('place:test', 'edit')).toBeNull();
  });

  test('capture_device_matrix rejects the tool call when an entry capture fails', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);

    const resultPromise = tools.captureDeviceMatrix(
      [{ label: 'phone', deviceId: 'iphone_XR' }],
      'edit',
      'jpeg',
      80,
      0,
      true,
      'place:test',
    );

    const snapshotPending = bridge.getPendingRequest('place:test', 'edit');
    bridge.resolveRequest(snapshotPending!.requestId, {
      success: true,
      returnValue: JSON.stringify({ activeDeviceId: 'default', isSimulating: false, devices: [] }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const setPending = bridge.getPendingRequest('place:test', 'edit');
    bridge.resolveRequest(setPending!.requestId, {
      success: true,
      returnValue: JSON.stringify({
        success: true,
        applied: { deviceId: 'iphone_XR' },
        before: { activeDeviceId: 'default', isSimulating: false },
        after: { activeDeviceId: 'iphone_XR', isSimulating: true },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const capturePending = bridge.getPendingRequest('place:test', 'edit');
    expect(capturePending?.request).toMatchObject({ endpoint: '/api/capture-screenshot' });
    bridge.resolveRequest(capturePending!.requestId, { error: 'screenshot boom' });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const restorePending = bridge.getPendingRequest('place:test', 'edit');
    expect(restorePending?.request.data.code).toContain('StopSimulationAsync');
    bridge.resolveRequest(restorePending!.requestId, {
      success: true,
      returnValue: JSON.stringify({
        success: true,
        applied: { stopSimulation: true },
        before: { activeDeviceId: 'iphone_XR', isSimulating: true },
        after: { activeDeviceId: 'default', isSimulating: false },
      }),
    });

    await expect(resultPromise).rejects.toThrow(/capture_device_matrix failed.*phone.*screenshot boom/);
  });

  test('capture_device_matrix rejects the tool call when restore fails', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);

    const resultPromise = tools.captureDeviceMatrix(
      [{ label: 'phone', deviceId: 'iphone_XR' }],
      'edit',
      'jpeg',
      80,
      0,
      true,
      'place:test',
    );

    const snapshotPending = bridge.getPendingRequest('place:test', 'edit');
    bridge.resolveRequest(snapshotPending!.requestId, {
      success: true,
      returnValue: JSON.stringify({ activeDeviceId: 'default', isSimulating: false, devices: [] }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const setPending = bridge.getPendingRequest('place:test', 'edit');
    bridge.resolveRequest(setPending!.requestId, {
      success: true,
      returnValue: JSON.stringify({
        success: true,
        applied: { deviceId: 'iphone_XR' },
        before: { activeDeviceId: 'default', isSimulating: false },
        after: { activeDeviceId: 'iphone_XR', isSimulating: true },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const capturePending = bridge.getPendingRequest('place:test', 'edit');
    bridge.resolveRequest(capturePending!.requestId, {
      width: 1,
      height: 1,
      data: Buffer.from([0, 0, 0, 255]).toString('base64'),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const restorePending = bridge.getPendingRequest('place:test', 'edit');
    expect(restorePending?.request.data.code).toContain('StopSimulationAsync');
    bridge.rejectRequest(restorePending!.requestId, new Error('restore boom'));

    await expect(resultPromise).rejects.toThrow(/capture_device_matrix failed.*restore.*restore boom/);
  });

  test('capture_device_matrix captures entries and restores prior state', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);

    const resultPromise = tools.captureDeviceMatrix(
      [{ label: 'phone', deviceId: 'iphone_XR' }],
      'edit',
      'jpeg',
      80,
      0,
      true,
      'place:test',
    );

    const snapshotPending = bridge.getPendingRequest('place:test', 'edit');
    expect(snapshotPending?.request).toMatchObject({ endpoint: '/api/execute-luau' });
    bridge.resolveRequest(snapshotPending!.requestId, {
      success: true,
      returnValue: JSON.stringify({ activeDeviceId: 'default', isSimulating: false }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const setPending = bridge.getPendingRequest('place:test', 'edit');
    expect(setPending?.request).toMatchObject({ endpoint: '/api/execute-luau' });
    expect(setPending?.request.data.code).toContain('SetDeviceAsync');
    bridge.resolveRequest(setPending!.requestId, {
      success: true,
      returnValue: JSON.stringify({
        success: true,
        applied: { deviceId: 'iphone_XR' },
        before: { activeDeviceId: 'default', isSimulating: false },
        after: { activeDeviceId: 'iphone_XR', isSimulating: true },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const capturePending = bridge.getPendingRequest('place:test', 'edit');
    expect(capturePending?.request).toMatchObject({ endpoint: '/api/capture-screenshot' });
    bridge.resolveRequest(capturePending!.requestId, {
      width: 1,
      height: 1,
      data: Buffer.from([0, 0, 0, 255]).toString('base64'),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const restorePending = bridge.getPendingRequest('place:test', 'edit');
    expect(restorePending?.request).toMatchObject({ endpoint: '/api/execute-luau' });
    expect(restorePending?.request.data.code).toContain('StopSimulationAsync');
    bridge.resolveRequest(restorePending!.requestId, {
      success: true,
      returnValue: JSON.stringify({
        success: true,
        applied: { stopSimulation: true },
        before: { activeDeviceId: 'iphone_XR', isSimulating: true },
        after: { activeDeviceId: 'default', isSimulating: false },
      }),
    });

    const result = await resultPromise;
    const firstContent = result.content[0];
    if (firstContent.type !== 'text') throw new Error('Expected matrix summary text first');
    const summary = JSON.parse(firstContent.text);
    expect(summary).toMatchObject({
      target: 'edit',
      role: 'edit',
      restoreAfter: true,
      entries: [{ label: 'phone', screenshot: { width: 1, height: 1, format: 'jpeg', quality: 80 } }],
      restore: { applied: { stopSimulation: true } },
    });
    expect(result.content.some((item) => item.type === 'image')).toBe(true);
  });

  test('capture_screenshot reports the coordinate multiplier when Studio downscales the capture', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);

    const resultPromise = tools.captureScreenshot('place:test', 'jpeg', 80);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const capturePending = bridge.getPendingRequest('place:test', 'edit');
    expect(capturePending?.request).toMatchObject({ endpoint: '/api/capture-screenshot' });
    bridge.resolveRequest(capturePending!.requestId, {
      width: 3,
      height: 1,
      nativeWidth: 4,
      nativeHeight: 2,
      data: Buffer.alloc(12, 255).toString('base64'),
    });

    const result = await resultPromise;
    const firstContent = result.content[0];
    if (firstContent.type !== 'text' || firstContent.text === undefined) throw new Error('Expected screenshot metadata text first');
    const meta = JSON.parse(firstContent.text);
    expect(meta).toMatchObject({ width: 3, height: 1, format: 'jpeg' });
    expect(meta.message).toContain('downscaled from the 4x2 viewport');
    expect(meta.message).toContain('multiply x read off this image by 1.3333 and y by 2.0000');
  });

  test('capture_device_matrix keeps the total inline image payload within the aggregate budget', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);

    const noiseSide = 2000;
    const noise = Buffer.alloc(noiseSide * noiseSide * 4);
    let seed = 0x12345678;
    for (let i = 0; i < noise.length; i += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      noise[i] = seed >>> 24;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      noise[i + 1] = seed >>> 24;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      noise[i + 2] = seed >>> 24;
      noise[i + 3] = 255;
    }
    const noiseB64 = noise.toString('base64');

    const resultPromise = tools.captureDeviceMatrix(
      [{ label: 'a', deviceId: 'iphone_XR' }, { label: 'b', deviceId: 'ipad' }],
      'edit',
      'jpeg',
      100,
      0,
      false,
      'place:test',
    );

    const snapshotPending = bridge.getPendingRequest('place:test', 'edit');
    bridge.resolveRequest(snapshotPending!.requestId, {
      success: true,
      returnValue: JSON.stringify({ activeDeviceId: 'default', isSimulating: false }),
    });

    for (const label of ['a', 'b']) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const setPending = bridge.getPendingRequest('place:test', 'edit');
      bridge.resolveRequest(setPending!.requestId, {
        success: true,
        returnValue: JSON.stringify({
          success: true,
          applied: { deviceId: label },
          before: { activeDeviceId: 'default', isSimulating: false },
          after: { activeDeviceId: label, isSimulating: true },
        }),
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      const capturePending = bridge.getPendingRequest('place:test', 'edit');
      expect(capturePending?.request).toMatchObject({ endpoint: '/api/capture-screenshot' });
      bridge.resolveRequest(capturePending!.requestId, {
        width: noiseSide,
        height: noiseSide,
        data: noiseB64,
      });
    }

    const result = await resultPromise;
    const images = result.content.filter(
      (item): item is { type: 'image'; data: string; mimeType: string } => item.type === 'image',
    );
    expect(images).toHaveLength(2);
    const totalBytes = images.reduce((sum, item) => sum + Math.ceil((item.data.length * 3) / 4), 0);
    expect(totalBytes).toBeLessThanOrEqual(8_000_000);
  });
});
