import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { build as esbuildBuild, type Plugin } from 'esbuild';

function repositoryRoot(): string {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, 'studio-plugin')) ? cwd : path.resolve(cwd, '../..');
}

function robloxPcall(callback: (...args: unknown[]) => unknown, ...args: unknown[]): [boolean, unknown] {
  try {
    return [true, callback(...args)];
  } catch (error) {
    return [false, error];
  }
}

async function loadPluginModule<T>(
  relativePath: string,
  globals: Record<string, unknown>,
  plugins: Plugin[] = [],
): Promise<T> {
  const buildResult = await esbuildBuild({
    entryPoints: [path.join(repositoryRoot(), relativePath)],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
    plugins,
  });
  const commonJsModule = { exports: {} as unknown };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    console,
    ...globals,
  });

  vm.runInContext(`
    String.prototype.gsub = function(search, replacement) {
      const parts = String(this).split(search);
      return [parts.join(replacement), parts.length - 1];
    };
    String.prototype.size = function() {
      return String(this).length;
    };
  `, context);
  vm.runInContext(buildResult.outputFiles[0].text, context);
  return commonJsModule.exports as T;
}

describe('script source update safety', () => {
  test('applyScriptSource leaves the original instance intact when both in-place writes fail', async () => {
    const parent = { name: 'parent' };
    const destroy = jest.fn();
    const source = 'old source';
    const instance = { Parent: parent, Destroy: destroy };
    Object.defineProperty(instance, 'Source', {
      get: () => source,
      set: () => {
        throw new Error('direct assignment blocked');
      },
    });
    const updateSourceAsync = jest.fn(() => {
      throw new Error('editor update blocked');
    });

    const utils = await loadPluginModule<{
      applyScriptSource: (
        target: object,
        newSource: string,
      ) => { success: boolean; error?: string };
    }>('studio-plugin/src/modules/Utils.ts', {
      game: {
        GetService: () => ({
          FindScriptDocument: () => undefined,
          UpdateSourceAsync: updateSourceAsync,
        }),
      },
      pcall: robloxPcall,
      error: (message: unknown) => {
        throw new Error(String(message));
      },
      warn: jest.fn(),
    });

    const result = utils.applyScriptSource(instance, 'new source');

    expect(result.success).toBe(false);
    expect(result.error).toContain('editor update blocked');
    expect(result.error).toContain('direct assignment blocked');
    expect(source).toBe('old source');
    expect(instance.Parent).toBe(parent);
    expect(destroy).not.toHaveBeenCalled();
  });

  test('setScriptSource returns the in-place failure without constructing a replacement', async () => {
    const parent = { name: 'parent' };
    const destroy = jest.fn();
    const original = {
      Name: 'Main',
      ClassName: 'ModuleScript',
      Parent: parent,
      attributes: { preserved: true },
      Destroy: destroy,
      IsA: (className: string) => className === 'LuaSourceContainer',
    };
    const replacement = {
      Name: '',
      ClassName: 'ModuleScript',
      Parent: undefined as object | undefined,
      Source: '',
      IsA: () => false,
    };
    const instanceConstructor = jest.fn(function MockInstance() {
      return replacement;
    });
    const applyScriptSource = jest.fn(() => ({
      success: false,
      method: 'direct',
      error: 'UpdateSourceAsync failed: editor blocked. Direct assignment failed: source locked.',
    }));
    const finishRecording = jest.fn();

    const dependencyPlugin: Plugin = {
      name: 'script-source-test-dependencies',
      setup(build) {
        build.onResolve({ filter: /^\.\.\/Utils$/ }, () => ({
          path: 'Utils',
          namespace: 'script-source-test',
        }));
        build.onResolve({ filter: /^\.\.\/Recording$/ }, () => ({
          path: 'Recording',
          namespace: 'script-source-test',
        }));
        build.onLoad({ filter: /.*/, namespace: 'script-source-test' }, (args) => ({
          contents: args.path === 'Utils'
            ? 'export default globalThis.__SCRIPT_SOURCE_TEST_UTILS__;'
            : 'export default globalThis.__SCRIPT_SOURCE_TEST_RECORDING__;',
          loader: 'js',
        }));
      },
    };
    const loaded = await loadPluginModule<{
      default?: { setScriptSource: (request: Record<string, unknown>) => Record<string, unknown> };
      setScriptSource?: (request: Record<string, unknown>) => Record<string, unknown>;
    }>('studio-plugin/src/modules/handlers/ScriptHandlers.ts', {
      __SCRIPT_SOURCE_TEST_UTILS__: {
        getInstancePath: () => 'game.ServerScriptService.Main',
        getInstanceByPath: () => original,
        readScriptSource: (target: unknown) => target === original ? 'old source' : replacement.Source,
        applyScriptSource,
        splitLines: jest.fn(),
        joinLines: jest.fn(),
      },
      __SCRIPT_SOURCE_TEST_RECORDING__: {
        beginRecording: () => 'recording-id',
        finishRecording,
      },
      typeIs: (value: unknown, expectedType: string) => typeof value === expectedType,
      pcall: robloxPcall,
      error: (message: unknown) => {
        throw new Error(String(message));
      },
      Instance: instanceConstructor,
    }, [dependencyPlugin]);
    const handlers = loaded.default ?? loaded;

    const result = handlers.setScriptSource!({
      instancePath: 'game.ServerScriptService.Main',
      source: 'new source',
    });

    expect(result.error).toContain('UpdateSourceAsync failed: editor blocked');
    expect(result.success).not.toBe(true);
    expect(applyScriptSource).toHaveBeenCalledWith(original, 'new source');
    expect(instanceConstructor).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(original.Parent).toBe(parent);
    expect(original.attributes).toEqual({ preserved: true });
    expect(finishRecording).toHaveBeenCalledWith('recording-id', false);
  });
});
