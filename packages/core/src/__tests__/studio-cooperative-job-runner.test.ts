import * as path from 'path';
import * as vm from 'vm';
import { build as esbuildBuild } from 'esbuild';

interface JobExecution {
  requestId: string;
  deadlineAt?: number;
  isCancelled?: () => boolean;
}

interface JobControl {
  checkpoint(): void;
}

interface BusyResult {
  error: 'plugin_busy';
  activeRequestId: string;
}

interface DeadlineResult {
  error: 'deadline_exceeded';
  requestId: string;
}

interface CancelledResult {
  error: 'cancelled';
  requestId: string;
}

interface CooperativeJobRunnerModule {
  runExclusive<T>(
    key: string,
    execution: JobExecution,
    work: (control: JobControl) => T,
  ): T | BusyResult | DeadlineResult | CancelledResult;
}

function robloxPcall(callback: (...args: never[]) => unknown): [boolean, unknown] {
  try {
    return [true, callback()];
  } catch (error) {
    return [false, error];
  }
}

async function loadRunner(
  clock: () => number = () => 0,
  onWait: () => void = () => undefined,
): Promise<CooperativeJobRunnerModule> {
  const result = await esbuildBuild({
    entryPoints: [path.resolve(process.cwd(), '../../studio-plugin/src/modules/CooperativeJobRunner.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
  });
  const commonJsModule = { exports: {} as unknown };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    os: { clock },
    task: { wait: onWait },
    pcall: robloxPcall,
    error: (value: unknown) => {
      throw value;
    },
  });
  vm.runInContext(result.outputFiles[0].text, context);
  const loaded = commonJsModule.exports as CooperativeJobRunnerModule & {
    default?: CooperativeJobRunnerModule;
  };
  return loaded.default ?? loaded;
}

describe('Studio cooperative job runner', () => {
  test('rejects competing work for the same resource while a job is active', async () => {
    const runner = await loadRunner();
    let competingResult: string | BusyResult | DeadlineResult | CancelledResult | undefined;

    const result = runner.runExclusive(
      'script-source-scan',
      { requestId: 'primary' },
      () => {
        competingResult = runner.runExclusive(
          'script-source-scan',
          { requestId: 'competing' },
          () => 'must not run',
        );
        return 'complete';
      },
    );

    expect(result).toBe('complete');
    expect(competingResult).toEqual({
      error: 'plugin_busy',
      activeRequestId: 'primary',
    });
  });

  test('stops expired work and releases the resource for the next job', async () => {
    let now = 0;
    const runner = await loadRunner(() => now);

    const expired = runner.runExclusive(
      'script-source-scan',
      { requestId: 'expired', deadlineAt: 1 },
      (control) => {
        now = 2;
        control.checkpoint();
        return 'must not complete';
      },
    );
    const next = runner.runExclusive(
      'script-source-scan',
      { requestId: 'next' },
      () => 'next completed',
    );

    expect(expired).toEqual({
      error: 'deadline_exceeded',
      requestId: 'expired',
    });
    expect(next).toBe('next completed');
  });

  test('stops cancelled work and releases the resource for the next job', async () => {
    let cancelled = false;
    const runner = await loadRunner();

    const stopped = runner.runExclusive(
      'script-source-scan',
      { requestId: 'cancelled', isCancelled: () => cancelled },
      (control) => {
        cancelled = true;
        control.checkpoint();
        return 'must not complete';
      },
    );
    const next = runner.runExclusive(
      'script-source-scan',
      { requestId: 'after-cancel' },
      () => 'after cancel completed',
    );

    expect(stopped).toEqual({
      error: 'cancelled',
      requestId: 'cancelled',
    });
    expect(next).toBe('after cancel completed');
  });

  test('gives scheduled work a turn during a long-running job', async () => {
    let now = 0;
    let clockReads = 0;
    let competingResult: string | BusyResult | DeadlineResult | CancelledResult | undefined;
    const runner = await loadRunner(
      () => {
        clockReads += 1;
        now += 0.005;
        return now;
      },
      () => {
        competingResult = runner.runExclusive(
          'script-source-scan',
          { requestId: 'scheduled' },
          () => 'must not run',
        );
      },
    );

    const result = runner.runExclusive(
      'script-source-scan',
      { requestId: 'long-running' },
      (control) => {
        for (let operation = 0; operation < 128; operation += 1) {
          control.checkpoint();
        }
        return 'complete';
      },
    );

    expect(result).toBe('complete');
    expect(competingResult).toEqual({
      error: 'plugin_busy',
      activeRequestId: 'long-running',
    });
    expect(clockReads).toBeLessThanOrEqual(4);
  });
});
