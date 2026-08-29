import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { build as esbuildBuild, type Plugin } from 'esbuild';
import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';

interface QueryHandlersModule {
  grepScripts(request: Record<string, unknown>): Record<string, unknown>;
}

interface UtilsModule {
  splitLines(source: string): [string[], boolean];
}

interface TestInstance {
  Name: string;
  ClassName: string;
  source?: string;
  IsA(className: string): boolean;
  GetChildren(): TestInstance[];
}

let utilsBundlePromise: Promise<string> | undefined;
let queryHandlersBundlePromise: Promise<string> | undefined;

function repositoryRoot(): string {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, 'studio-plugin')) ? cwd : path.resolve(cwd, '../..');
}

function robloxPcall(callback: (...args: never[]) => unknown): [boolean, unknown] {
  try {
    return [true, callback()];
  } catch (error) {
    return [false, error];
  }
}

function robloxFind(value: string, pattern: string, start = 1): [number | undefined, number | undefined] {
  const index = value.indexOf(pattern, Math.max(0, start - 1));
  return index < 0 ? [undefined, undefined] : [index + 1, index + pattern.length];
}

function installRobloxStringHelpers(context: vm.Context): void {
  vm.runInContext(`
    String.prototype.gsub = function(search, replacement) {
      const parts = String(this).split(search);
      return [parts.join(replacement), parts.length - 1];
    };
    String.prototype.sub = function(start, finish) {
      const from = start > 0 ? start - 1 : this.length + start;
      const to = finish === undefined ? this.length : (finish > 0 ? finish : this.length + finish + 1);
      return String(this).slice(from, to);
    };
    String.prototype.lower = function() { return String(this).toLowerCase(); };
    String.prototype.size = function() { return this.length; };
    String.prototype.find = function(pattern, start) {
      return globalThis.__STRING_FIND__(String(this), pattern, start);
    };
    Array.prototype.size = function() { return this.length; };
  `, context);
}

async function loadUtils(): Promise<UtilsModule> {
  utilsBundlePromise ??= esbuildBuild({
    entryPoints: [path.join(repositoryRoot(), 'studio-plugin/src/modules/Utils.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
  }).then((result) => result.outputFiles[0].text);
  const bundle = await utilsBundlePromise;
  const commonJsModule = { exports: {} as unknown };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    console,
    game: { GetService: () => ({}) },
    __STRING_FIND__: robloxFind,
  });
  installRobloxStringHelpers(context);
  vm.runInContext(bundle, context);
  const loaded = commonJsModule.exports as UtilsModule & { default?: UtilsModule };
  return loaded.default ?? loaded;
}

async function loadQueryHandlers(
  sources: string[],
  options: { throwOnFirstRead?: boolean } = {},
): Promise<{
  handlers: QueryHandlersModule;
  splitCalls: () => number;
  waitCalls: () => number;
  onWait(callback: () => void): void;
  grepInContext(request: Record<string, unknown>): Record<string, unknown>;
}> {
  const scripts: TestInstance[] = sources.map((source, index) => ({
    Name: `Script${index}`,
    ClassName: 'ModuleScript',
    source,
    IsA: (className) => className === 'LuaSourceContainer',
    GetChildren: () => [],
  }));
  const root: TestInstance = {
    Name: 'game',
    ClassName: 'DataModel',
    IsA: () => false,
    GetChildren: () => scripts,
  };

  let splitCallCount = 0;
  let waitCallCount = 0;
  let waitCallback: (() => void) | undefined;
  let clock = 0;
  let shouldThrowOnRead = options.throwOnFirstRead ?? false;
  const utils = {
    getInstancePath: (instance: TestInstance) => `game.${instance.Name}`,
    getInstanceByPath: () => root,
    readScriptSource: (instance: TestInstance) => {
      if (shouldThrowOnRead) {
        shouldThrowOnRead = false;
        throw new Error('source read failed');
      }
      return instance.source ?? '';
    },
    splitLines: (source: string) => {
      splitCallCount++;
      const lines = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n') as string[] & { size(): number };
      lines.size = () => lines.length;
      return [lines, false];
    },
  };
  const dependencies: Plugin = {
    name: 'studio-grep-responsiveness-dependencies',
    setup(build) {
      build.onResolve({ filter: /^\.\.\/Utils$/ }, () => ({
        path: 'Utils',
        namespace: 'studio-grep-responsiveness',
      }));
      build.onLoad({ filter: /.*/, namespace: 'studio-grep-responsiveness' }, () => ({
        contents: 'export default globalThis.__UTILS__;',
        loader: 'js',
      }));
    },
  };
  queryHandlersBundlePromise ??= esbuildBuild({
    entryPoints: [path.join(repositoryRoot(), 'studio-plugin/src/modules/handlers/QueryHandlers.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
    plugins: [dependencies],
  }).then((result) => result.outputFiles[0].text);
  const bundle = await queryHandlersBundlePromise;
  const commonJsModule = { exports: {} as unknown };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    console,
    game: root,
    __UTILS__: utils,
    __STRING_FIND__: robloxFind,
    os: { clock: () => (clock += 0.005) },
    task: {
      wait: () => {
        waitCallCount++;
        waitCallback?.();
      },
    },
    math: { max: Math.max, min: Math.min },
    string: {
      find: robloxFind,
      sub: (value: string, start: number, finish?: number) => {
        const from = start > 0 ? start - 1 : value.length + start;
        const to = finish === undefined ? value.length : (finish > 0 ? finish : value.length + finish + 1);
        return value.slice(from, to);
      },
    },
    pcall: robloxPcall,
    error: (value: unknown) => {
      throw value instanceof Error ? value : new Error(String(value));
    },
  });
  installRobloxStringHelpers(context);
  vm.runInContext(bundle, context);
  const loaded = commonJsModule.exports as QueryHandlersModule & { default?: QueryHandlersModule };
  const handlers = loaded.default ?? loaded;
  (context as Record<string, unknown>).__HANDLERS__ = handlers;

  return {
    handlers,
    splitCalls: () => splitCallCount,
    waitCalls: () => waitCallCount,
    onWait: (callback) => { waitCallback = callback; },
    grepInContext: (request) => {
      (context as Record<string, unknown>).__REQUEST_JSON__ = JSON.stringify(request);
      return vm.runInContext('__HANDLERS__.grepScripts(JSON.parse(__REQUEST_JSON__))', context);
    },
  };
}

describe('Studio grep responsiveness', () => {
  test.each([
    ['', [''], false],
    ['\n', [''], true],
    ['a\n', ['a'], true],
    ['a\n\n', ['a', ''], true],
    ['a\r\nb\r', ['a', 'b'], true],
  ])('keeps splitLines semantics for %j', async (source, expectedLines, expectedTrailingNewline) => {
    const utils = await loadUtils();
    const [lines, trailingNewline] = utils.splitLines(source as string);
    expect([...lines]).toEqual(expectedLines);
    expect(trailingNewline).toBe(expectedTrailingNewline);
  });

  test('yields large scans, prefilters misses, and rejects an overlapping grep', async () => {
    const sources = Array.from({ length: 192 }, (_, index) =>
      index === 191 ? 'local needle = true' : 'local value = true');
    const harness = await loadQueryHandlers(sources);
    let overlappingResult: Record<string, unknown> | undefined;
    harness.onWait(() => {
      overlappingResult ??= harness.handlers.grepScripts({ pattern: 'other' });
    });

    const result = harness.handlers.grepScripts({ pattern: 'needle' });
    const plainResult = JSON.parse(JSON.stringify(result));

    expect(harness.waitCalls()).toBeGreaterThan(0);
    expect(overlappingResult).toMatchObject({ error: 'plugin_busy' });
    expect(harness.splitCalls()).toBe(1);
    expect(plainResult).toMatchObject({
      totalMatches: 1,
      scriptsSearched: 192,
      scriptsMatched: 1,
      truncated: false,
    });
  });

  test('preserves grep result records while scanning cooperatively', async () => {
    const harness = await loadQueryHandlers(['before\nlocal needle = true\nafter']);

    const result = JSON.parse(JSON.stringify(harness.handlers.grepScripts({
      pattern: 'needle',
      caseSensitive: true,
      contextLines: 1,
    })));

    expect(result.results).toEqual([
      {
        instancePath: 'game.Script0',
        name: 'Script0',
        className: 'ModuleScript',
        matches: [
          {
            line: 2,
            column: 7,
            text: 'local needle = true',
            before: ['before'],
            after: ['after'],
          },
        ],
      },
    ]);
  });

  test('clears the single-flight fence after a search error', async () => {
    const harness = await loadQueryHandlers(['local needle = true'], { throwOnFirstRead: true });

    expect(() => harness.handlers.grepScripts({ pattern: 'needle' })).toThrow('source read failed');

    const result = harness.handlers.grepScripts({ pattern: 'needle' });
    expect(harness.splitCalls()).toBe(1);
    expect(JSON.parse(JSON.stringify(result))).toMatchObject({
      totalMatches: 1,
      scriptsMatched: 1,
    });
  });

  test('does not apply the literal prefilter to pattern searches', async () => {
    const harness = await loadQueryHandlers(['local value = true']);

    const result = harness.grepInContext({ pattern: 'needle', usePattern: true });

    expect(harness.splitCalls()).toBe(1);
    expect(JSON.parse(JSON.stringify(result))).toMatchObject({
      totalMatches: 0,
      scriptsSearched: 1,
    });
  });

  test('gives grep requests a 120 second bridge timeout', async () => {
    const bridge = new BridgeService();
    jest.spyOn(bridge, 'resolveTarget').mockReturnValue({
      ok: true,
      mode: 'single',
      targetInstanceId: 'place:test',
      targetRole: 'edit',
    });
    const sendRequest = jest.spyOn(bridge, 'sendRequest').mockResolvedValue({ results: [] });
    const tools = new RobloxStudioTools(bridge);

    await tools.grepScripts('needle', {}, 'place:test');

    expect(sendRequest).toHaveBeenCalledWith(
      '/api/grep-scripts',
      { pattern: 'needle' },
      'place:test',
      'edit',
      120_000,
    );
  });
});
