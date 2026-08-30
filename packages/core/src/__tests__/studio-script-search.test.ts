import * as path from 'path';
import * as vm from 'vm';
import { build as esbuildBuild } from 'esbuild';

interface TestNode {
  id: string;
}

interface ScriptSnapshot {
  instancePath: string;
  name: string;
  className: string;
  enabled?: boolean;
  source: string;
}

interface ScriptCorpus {
  resolveRoot(path: string): TestNode | undefined;
  getChildren(node: TestNode): TestNode[];
  readScript(node: TestNode, classFilter?: string): ScriptSnapshot | undefined;
}

interface SearchControl {
  checkpoint(): void;
}

interface ScriptSearch {
  search(request: Record<string, unknown>, control: SearchControl): Record<string, unknown>;
}

interface ScriptSearchModule {
  createScriptSearch(corpus: ScriptCorpus): ScriptSearch;
}

function installRobloxCollections(context: vm.Context): void {
  vm.runInContext(`
    String.prototype.lower = function() { return String(this).toLowerCase(); };
    String.prototype.sub = function(start, finish) {
      const from = start > 0 ? start - 1 : this.length + start;
      const to = finish === undefined ? this.length : (finish > 0 ? finish : this.length + finish + 1);
      return String(this).slice(from, to);
    };
    String.prototype.size = function() { return this.length; };
    Array.prototype.size = function() { return this.length; };
  `, context);
}

function robloxFind(
  value: string,
  pattern: string,
  start = 1,
): [number | undefined, number | undefined] {
  let index: number;
  if (pattern === '[\r\n]') {
    const newline = value.indexOf('\n', Math.max(0, start - 1));
    const carriageReturn = value.indexOf('\r', Math.max(0, start - 1));
    if (newline < 0) index = carriageReturn;
    else if (carriageReturn < 0) index = newline;
    else index = Math.min(newline, carriageReturn);
  } else {
    index = value.indexOf(pattern, Math.max(0, start - 1));
  }
  return index < 0 ? [undefined, undefined] : [index + 1, index + 1];
}

async function loadScriptSearch(onFind: (pattern: string) => void = () => undefined): Promise<ScriptSearchModule> {
  const result = await esbuildBuild({
    entryPoints: [path.resolve(process.cwd(), '../../studio-plugin/src/modules/ScriptSearch.ts')],
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
    typeIs: (value: unknown, expected: string) => typeof value === expected,
    math: { floor: Math.floor, max: Math.max, min: Math.min },
    string: {
      find: (value: string, pattern: string, start?: number) => {
        onFind(pattern);
        return robloxFind(value, pattern, start);
      },
      sub: (value: string, start: number, finish?: number) => {
        const from = start > 0 ? start - 1 : value.length + start;
        const to = finish === undefined ? value.length : (finish > 0 ? finish : value.length + finish + 1);
        return value.slice(from, to);
      },
    },
  });
  installRobloxCollections(context);
  vm.runInContext(result.outputFiles[0].text, context);
  const loaded = commonJsModule.exports as ScriptSearchModule & { default?: ScriptSearchModule };
  return loaded.default ?? loaded;
}

describe('Studio script search', () => {
  test('returns a literal match with its requested line context', async () => {
    const root = { id: 'root' };
    const script = { id: 'script' };
    const corpus: ScriptCorpus = {
      resolveRoot: () => root,
      getChildren: (node) => node === root ? [script] : [],
      readScript: (node) => node === script ? {
        instancePath: 'game.ServerScriptService.Worker',
        name: 'Worker',
        className: 'Script',
        enabled: true,
        source: 'before\nlocal Needle = true\nafter',
      } : undefined,
    };
    const module = await loadScriptSearch();
    const search = module.createScriptSearch(corpus);

    const result = search.search({
      pattern: 'Needle',
      caseSensitive: true,
      contextLines: 1,
    }, { checkpoint: () => undefined });

    expect(JSON.parse(JSON.stringify(result))).toEqual({
      results: [{
        instancePath: 'game.ServerScriptService.Worker',
        name: 'Worker',
        className: 'Script',
        enabled: true,
        matches: [{
          line: 2,
          column: 7,
          text: 'local Needle = true',
          before: ['before'],
          after: ['after'],
        }],
      }],
      pattern: 'Needle',
      totalMatches: 1,
      scriptsSearched: 1,
      scriptsMatched: 1,
      truncated: false,
      options: {
        caseSensitive: true,
        contextLines: 1,
        usePattern: false,
        filesOnly: false,
        maxResults: 100,
        maxResultsPerScript: 0,
      },
    });
  });

  test('supports top-level alternation in Lua-pattern mode', async () => {
    const root = { id: 'root' };
    const script = { id: 'script' };
    const corpus: ScriptCorpus = {
      resolveRoot: () => root,
      getChildren: (node) => node === root ? [script] : [],
      readScript: (node) => node === script ? {
        instancePath: 'game.ServerScriptService.Worker',
        name: 'Worker',
        className: 'Script',
        source: 'local alpha = 1\nlocal beta = 2',
      } : undefined,
    };
    const module = await loadScriptSearch();
    const search = module.createScriptSearch(corpus);

    const result = JSON.parse(JSON.stringify(search.search({
      pattern: 'alpha|beta',
      usePattern: true,
    }, { checkpoint: () => undefined })));

    expect(result).toMatchObject({
      totalMatches: 2,
      scriptsMatched: 1,
      options: {
        caseSensitive: true,
        usePattern: true,
      },
    });
    expect(result.results[0].matches).toEqual([
      {
        line: 1,
        column: 7,
        text: 'local alpha = 1',
        before: [],
        after: [],
      },
      {
        line: 2,
        column: 7,
        text: 'local beta = 2',
        before: [],
        after: [],
      },
    ]);
  });

  test('treats CRLF and lone carriage returns as line boundaries', async () => {
    const root = { id: 'root' };
    const script = { id: 'script' };
    const corpus: ScriptCorpus = {
      resolveRoot: () => root,
      getChildren: (node) => node === root ? [script] : [],
      readScript: (node) => node === script ? {
        instancePath: 'game.Workspace.MixedNewlines',
        name: 'MixedNewlines',
        className: 'ModuleScript',
        source: 'first\r\nneedle\rthird',
      } : undefined,
    };
    const module = await loadScriptSearch();
    const search = module.createScriptSearch(corpus);

    const result = JSON.parse(JSON.stringify(search.search({
      pattern: 'needle',
      caseSensitive: true,
      contextLines: 1,
    }, { checkpoint: () => undefined })));

    expect(result.results[0].matches).toEqual([{
      line: 2,
      column: 1,
      text: 'needle',
      before: ['first'],
      after: ['third'],
    }]);
  });

  test('continues into descendants when a parent script is excluded by class', async () => {
    const root = { id: 'root' };
    const localScript = { id: 'local' };
    const moduleScript = { id: 'module' };
    const corpus: ScriptCorpus = {
      resolveRoot: () => root,
      getChildren: (node) => {
        if (node === root) return [localScript];
        if (node === localScript) return [moduleScript];
        return [];
      },
      readScript: (node, classFilter) => {
        if (node === localScript) {
          if (classFilter === 'ModuleScript') return undefined;
          throw new Error('excluded source was read');
        }
        if (node === moduleScript) {
          return {
            instancePath: 'game.Workspace.Parent.Child',
            name: 'Child',
            className: 'ModuleScript',
            source: 'needle',
          };
        }
        return undefined;
      },
    };
    const module = await loadScriptSearch();
    const search = module.createScriptSearch(corpus);

    const result = JSON.parse(JSON.stringify(search.search({
      pattern: 'needle',
      caseSensitive: true,
      classFilter: 'ModuleScript',
    }, { checkpoint: () => undefined })));

    expect(result.scriptsSearched).toBe(1);
    expect(result.results.map((entry: { instancePath: string }) => entry.instancePath)).toEqual([
      'game.Workspace.Parent.Child',
    ]);
  });

  test('rejects a result limit that could produce an unbounded response', async () => {
    const root = { id: 'root' };
    const corpus: ScriptCorpus = {
      resolveRoot: () => root,
      getChildren: () => [],
      readScript: () => undefined,
    };
    const module = await loadScriptSearch();
    const search = module.createScriptSearch(corpus);

    const result = search.search({
      pattern: 'needle',
      maxResults: 1_000_000,
    }, { checkpoint: () => undefined });

    expect(JSON.parse(JSON.stringify(result))).toEqual({
      error: 'invalid_request',
      message: 'maxResults must be an integer between 1 and 10000',
    });
  });

  test('finishes a large literal miss within a small execution budget', async () => {
    const root = { id: 'root' };
    const script = { id: 'script' };
    const corpus: ScriptCorpus = {
      resolveRoot: () => root,
      getChildren: (node) => node === root ? [script] : [],
      readScript: (node) => node === script ? {
        instancePath: 'game.Workspace.LargeMiss',
        name: 'LargeMiss',
        className: 'ModuleScript',
        source: `${'local filler = true\n'.repeat(500)}return false`,
      } : undefined,
    };
    const module = await loadScriptSearch();
    const search = module.createScriptSearch(corpus);
    let checkpoints = 0;

    const result = search.search({
      pattern: 'needle',
      caseSensitive: true,
    }, {
      checkpoint: () => {
        checkpoints += 1;
        if (checkpoints > 20) throw new Error('execution budget exhausted');
      },
    });

    expect(JSON.parse(JSON.stringify(result))).toMatchObject({
      totalMatches: 0,
      scriptsSearched: 1,
      scriptsMatched: 0,
      truncated: false,
    });
  });

  test('uses one bounded line-boundary scan per source line', async () => {
    const root = { id: 'root' };
    const script = { id: 'script' };
    const source = `${'local filler = true\n'.repeat(1000)}local needle = true`;
    const corpus: ScriptCorpus = {
      resolveRoot: () => root,
      getChildren: (node) => node === root ? [script] : [],
      readScript: (node) => node === script ? {
        instancePath: 'game.Workspace.LinearScan',
        name: 'LinearScan',
        className: 'ModuleScript',
        source,
      } : undefined,
    };
    let boundaryScans = 0;
    const module = await loadScriptSearch((pattern) => {
      if (pattern === '\n' || pattern === '\r' || pattern === '[\r\n]') boundaryScans += 1;
    });
    const search = module.createScriptSearch(corpus);

    const result = search.search({
      pattern: 'needle',
      caseSensitive: true,
    }, { checkpoint: () => undefined });

    expect(JSON.parse(JSON.stringify(result))).toMatchObject({ totalMatches: 1 });
    expect(boundaryScans).toBeLessThanOrEqual(1001);
  });

  test('rejects context windows that could make the response unbounded', async () => {
    const root = { id: 'root' };
    const corpus: ScriptCorpus = {
      resolveRoot: () => root,
      getChildren: () => [],
      readScript: () => undefined,
    };
    const module = await loadScriptSearch();
    const search = module.createScriptSearch(corpus);

    const result = search.search({
      pattern: 'needle',
      contextLines: 101,
    }, { checkpoint: () => undefined });

    expect(JSON.parse(JSON.stringify(result))).toEqual({
      error: 'invalid_request',
      message: 'contextLines must be an integer between 0 and 100',
    });
  });

  test('rejects an unbounded per-script match limit', async () => {
    const root = { id: 'root' };
    const corpus: ScriptCorpus = {
      resolveRoot: () => root,
      getChildren: () => [],
      readScript: () => undefined,
    };
    const module = await loadScriptSearch();
    const search = module.createScriptSearch(corpus);

    const result = search.search({
      pattern: 'needle',
      maxResultsPerScript: 10_001,
    }, { checkpoint: () => undefined });

    expect(JSON.parse(JSON.stringify(result))).toEqual({
      error: 'invalid_request',
      message: 'maxResultsPerScript must be an integer between 0 and 10000',
    });
  });

  test('rejects a pattern too large for bounded matching', async () => {
    const root = { id: 'root' };
    const corpus: ScriptCorpus = {
      resolveRoot: () => root,
      getChildren: () => [],
      readScript: () => undefined,
    };
    const module = await loadScriptSearch();
    const search = module.createScriptSearch(corpus);

    const result = search.search({
      pattern: 'x'.repeat(4097),
    }, { checkpoint: () => undefined });

    expect(JSON.parse(JSON.stringify(result))).toEqual({
      error: 'invalid_request',
      message: 'pattern must contain between 1 and 4096 bytes',
    });
  });

  test('stops scanning a script once its per-script result cap is complete', async () => {
    const root = { id: 'root' };
    const script = { id: 'script' };
    const corpus: ScriptCorpus = {
      resolveRoot: () => root,
      getChildren: (node) => node === root ? [script] : [],
      readScript: (node) => node === script ? {
        instancePath: 'game.Workspace.Capped',
        name: 'Capped',
        className: 'ModuleScript',
        source: Array.from({ length: 1_000 }, () => 'needle').join('\n'),
      } : undefined,
    };
    const module = await loadScriptSearch();
    const search = module.createScriptSearch(corpus);
    let checkpoints = 0;

    const result = search.search({
      pattern: 'needle',
      maxResultsPerScript: 1,
    }, { checkpoint: () => { checkpoints += 1; } });

    expect(JSON.parse(JSON.stringify(result))).toMatchObject({
      totalMatches: 1,
      scriptsMatched: 1,
    });
    expect(checkpoints).toBeLessThan(10);
  });

  test('checkpoints while evaluating many Lua-pattern alternatives', async () => {
    const root = { id: 'root' };
    const script = { id: 'script' };
    const corpus: ScriptCorpus = {
      resolveRoot: () => root,
      getChildren: (node) => node === root ? [script] : [],
      readScript: (node) => node === script ? {
        instancePath: 'game.Workspace.Patterns',
        name: 'Patterns',
        className: 'ModuleScript',
        source: 'needle',
      } : undefined,
    };
    const module = await loadScriptSearch();
    const search = module.createScriptSearch(corpus);
    let checkpoints = 0;

    const result = search.search({
      pattern: `${'z|'.repeat(1_000)}needle`,
      usePattern: true,
    }, { checkpoint: () => { checkpoints += 1; } });

    expect(JSON.parse(JSON.stringify(result))).toMatchObject({ totalMatches: 1 });
    expect(checkpoints).toBeGreaterThan(500);
  });

  test('rejects malformed option types on the direct Studio request boundary', async () => {
    const root = { id: 'root' };
    const corpus: ScriptCorpus = {
      resolveRoot: () => root,
      getChildren: () => [],
      readScript: () => undefined,
    };
    const module = await loadScriptSearch();
    const search = module.createScriptSearch(corpus);

    const result = search.search({
      pattern: 'needle',
      usePattern: 'true',
    }, { checkpoint: () => undefined });

    expect(JSON.parse(JSON.stringify(result))).toEqual({
      error: 'invalid_request',
      message: 'usePattern must be a boolean',
    });
  });

});
