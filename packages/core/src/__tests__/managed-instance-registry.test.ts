import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as waitForTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { ManagedInstanceRegistry, type ManagedInstanceRegistryRecord } from '../managed-instance-registry.js';

describe('ManagedInstanceRegistry lock lifecycle', () => {
  test('a lock retry does not keep an otherwise idle Node process alive', async () => {
    const registryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'robloxstudio-mcp-lock-test-'));
    const lockDir = path.join(registryDir, '.lock');
    await fs.mkdir(lockDir);
    await fs.writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({
      pid: process.pid,
      token: 'active-parent-test-lock',
      createdAt: Date.now(),
    }));

    const registryModuleUrl = pathToFileURL(path.resolve(process.cwd(), 'src/managed-instance-registry.ts')).href;
    // This subprocess loads the source module at runtime to exercise real process-exit behavior.
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      [
        'const { ManagedInstanceRegistry } = await import(process.env.TEST_REGISTRY_MODULE_URL);',
        'void new ManagedInstanceRegistry(process.env.TEST_REGISTRY_DIR).listOpen({ currentBootId: "child-test" });',
      ].join('\n'),
    ], {
      env: {
        ...process.env,
        TEST_REGISTRY_DIR: registryDir,
        TEST_REGISTRY_MODULE_URL: registryModuleUrl,
      },
      stdio: 'ignore',
    });
    const exited = once(child, 'exit').then(([code, signal]) => ({
      kind: 'exit' as const,
      code,
      signal,
    }));

    try {
      const outcome = await Promise.race([
        exited,
        waitForTimeout(5000, { kind: 'timeout' as const }, { ref: false }),
      ]);
      expect(outcome).toEqual({ kind: 'exit', code: 0, signal: null });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exited;
      }
      await fs.rm(registryDir, { recursive: true, force: true });
    }
  }, 10_000);
});

describe('ManagedInstanceRegistry process observation', () => {
  test('a sweep observation older than the record leaves a live launch open', async () => {
    const registryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'robloxstudio-mcp-sweep-test-'));
    const registry = new ManagedInstanceRegistry(registryDir);
    const launch: ManagedInstanceRegistryRecord = {
      version: 1,
      recordId: 'stale-sweep-launch',
      source: 'local_file',
      nativeProcessId: 7700,
      nativeProcessStartedAt: '133700123457',
      spawnPid: 7700,
      exe: 'C:\\Roblox\\RobloxStudioBeta.exe',
      args: [],
      launchedAt: 2000,
      state: 'launching',
      ownerPid: process.pid,
      bootId: 'boot-1',
      processObservationStatus: 'running',
      processAuthorizationState: 'pending',
      lastProcessObservationAt: 2000,
      lastSuccessfulProcessObservationAt: 2000,
      consecutiveConfirmedMisses: 0,
    };

    try {
      await registry.upsert(launch);
      const open = await registry.listOpen({
        currentBootId: 'boot-1',
        // A snapshot from before the launch saw a previous holder of the PID.
        observeProcess: () => ({ status: 'not_running', observedAt: 1999, reason: 'identity_mismatch' }),
      });
      expect(open).toEqual([launch]);
    } finally {
      await fs.rm(registryDir, { recursive: true, force: true });
    }
  });
});
