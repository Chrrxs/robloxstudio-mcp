import type { Plugin } from 'esbuild';
import { loadPluginModule, luauArray } from './luau-vm.js';

// find_and_replace_in_scripts in the plugin, driven through the injected
// corpus seam (ScriptReplace) and once through the Studio handler adapter.

interface FakeNode {
  name: string;
  className: string;
  source?: string;
  children: FakeNode[];
  parent?: FakeNode;
}

interface WriteResult {
  success: boolean;
  error?: string;
}

interface ScriptReplaceModule {
  createScriptReplace(corpus: object): { run(request: Record<string, unknown>): Record<string, unknown> };
}

type Change = Record<string, unknown>;

const SCRIPT_CLASSES = new Set(['Script', 'LocalScript', 'ModuleScript']);

function node(name: string, className: string, source?: string, children: FakeNode[] = []): FakeNode {
  const created: FakeNode = { name, className, source, children };
  for (const child of children) child.parent = created;
  return created;
}

function pathOf(target: FakeNode): string {
  return target.parent ? `${pathOf(target.parent)}.${target.name}` : target.name;
}

function revisionOf(source: string): string {
  let hash = 2166136261;
  for (const byte of Buffer.from(source, 'latin1')) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return `${source.length}:${hash}`;
}

function corpusFor(root: FakeNode, options: { ambiguous?: Set<FakeNode>; beforeWrite?: (target: FakeNode) => void } = {}) {
  const writes: string[] = [];
  const corpus = {
    resolvePath(requested: string): FakeNode | undefined {
      if (requested === '') return root;
      const [first, ...rest] = requested.split('.');
      if (first !== root.name) return undefined;
      let current: FakeNode | undefined = root;
      for (const name of rest) current = current?.children.find((child) => child.name === name);
      return current;
    },
    getChildren: (target: FakeNode) => luauArray([...target.children]),
    readScript(target: FakeNode, classFilter?: string) {
      if (!SCRIPT_CLASSES.has(target.className)) return undefined;
      if (classFilter !== undefined && target.className !== classFilter) return undefined;
      return { instancePath: pathOf(target), name: target.name, className: target.className, source: target.source ?? '' };
    },
    createAmbiguityChecker: () => (target: FakeNode) => options.ambiguous?.has(target) ?? false,
    writeScript: jest.fn((target: FakeNode, newSource: string, expectedSource: string): WriteResult => {
      options.beforeWrite?.(target);
      if (target.source !== expectedSource) {
        return { success: false, error: 'Script source changed while the edit was being applied' };
      }
      target.source = newSource;
      writes.push(pathOf(target));
      return { success: true };
    }),
    beginRecording: jest.fn<string, [string]>(() => 'recording'),
    finishRecording: jest.fn(),
  };
  return { corpus, writes };
}

let scriptReplace: ScriptReplaceModule;
beforeAll(async () => {
  scriptReplace = await loadPluginModule<ScriptReplaceModule>('studio-plugin/src/modules/ScriptReplace.ts');
});

function threeClasses() {
  const server = node('Server', 'Script', 'return 1');
  const client = node('Client', 'LocalScript', 'return 1');
  const shared = node('Shared', 'ModuleScript', 'return 1');
  const root = node('game', 'DataModel', undefined, [node('Fixture', 'Folder', undefined, [server, client, shared])]);
  return { root, server, client, shared };
}

function changes(result: Record<string, unknown>): Change[] {
  return result.changes as Change[];
}

describe('classFilter selects one script class exactly', () => {
  test.each([
    ['Script', ['game.Fixture.Server']],
    ['LocalScript', ['game.Fixture.Client']],
    ['ModuleScript', ['game.Fixture.Shared']],
    [undefined, ['game.Fixture.Server', 'game.Fixture.Client', 'game.Fixture.Shared']],
  ])('classFilter %s', (classFilter, expectedPaths) => {
    const { root, server, client, shared } = threeClasses();
    const { corpus, writes } = corpusFor(root);
    const replace = scriptReplace.createScriptReplace(corpus);
    const request = { pattern: '1', replacement: '2', path: 'game.Fixture', classFilter };

    const preview = replace.run({ ...request, dryRun: true });
    expect(preview).toMatchObject({ success: true, scriptsSearched: expectedPaths.length, totalReplacements: expectedPaths.length });
    expect(changes(preview).map((change) => change.instancePath)).toEqual(expectedPaths);

    expect(replace.run(request)).toMatchObject({ success: true, scriptsModified: expectedPaths.length });
    expect(writes).toEqual(expectedPaths);
    const changed = [server, client, shared].filter((script) => script.source === 'return 2').map(pathOf);
    expect(changed).toEqual(expectedPaths);
  });

  test.each(['Folder', 'script', 'Script[', ''])('rejects classFilter %p before reading or writing', (classFilter) => {
    const { root } = threeClasses();
    const { corpus } = corpusFor(root);
    const readScript = jest.spyOn(corpus, 'readScript');

    const result = scriptReplace.createScriptReplace(corpus).run({ pattern: '1', replacement: '2', classFilter });

    expect(result).toEqual({ success: false, error: 'classFilter must be one of Script, LocalScript, ModuleScript' });
    expect(readScript).not.toHaveBeenCalled();
    expect(corpus.writeScript).not.toHaveBeenCalled();
  });
});

describe('the whole plan is checked before the first write', () => {
  function twoScripts(sourceA = 'foo foo', sourceB = 'foo foo') {
    const a = node('A', 'Script', sourceA);
    const b = node('B', 'Script', sourceB);
    const root = node('game', 'DataModel', undefined, [node('Fixture', 'Folder', undefined, [a, b])]);
    return { root, a, b };
  }
  const request = { pattern: 'foo', replacement: 'bar', caseSensitive: true, path: 'game.Fixture' };

  test('an exceeded replacement cap writes nothing, even when an earlier script fits', () => {
    const { root, a, b } = twoScripts();
    const { corpus } = corpusFor(root);
    const replace = scriptReplace.createScriptReplace(corpus);

    for (const dryRun of [true, false]) {
      const result = replace.run({ ...request, maxReplacements: 3, dryRun });
      expect(result).toMatchObject({
        success: false,
        code: 'max_replacements_exceeded',
        totalReplacements: 4,
        maxReplacements: 3,
        scriptsModified: 0,
      });
      expect(String(result.error)).toContain('nothing was written');
    }
    expect([a.source, b.source]).toEqual(['foo foo', 'foo foo']);
    expect(corpus.writeScript).not.toHaveBeenCalled();
    expect(corpus.beginRecording).not.toHaveBeenCalled();
  });

  test('a preview reports each script with its revisions and diff, and the reviewed plan applies', () => {
    const { root, a, b } = twoScripts('local foo = 1\nreturn foo\n', 'print("x")\n');
    b.source = 'print(foo)\n';
    const { corpus } = corpusFor(root);
    const replace = scriptReplace.createScriptReplace(corpus);

    const preview = replace.run({ ...request, dryRun: true });

    expect(preview).toMatchObject({ success: true, dryRun: true, totalReplacements: 3, scriptsMatched: 2 });
    expect(changes(preview)).toEqual([
      {
        instancePath: 'game.Fixture.A', name: 'A', className: 'Script', replacements: 2,
        revision: revisionOf('local foo = 1\nreturn foo\n'),
        resultRevision: revisionOf('local bar = 1\nreturn bar\n'),
        diff: '@@ -1,1 +1,1 @@\n-local foo = 1\n+local bar = 1\n@@ -2,1 +2,1 @@\n-return foo\n+return bar',
      },
      {
        instancePath: 'game.Fixture.B', name: 'B', className: 'Script', replacements: 1,
        revision: revisionOf('print(foo)\n'),
        resultRevision: revisionOf('print(bar)\n'),
        diff: '@@ -1,1 +1,1 @@\n-print(foo)\n+print(bar)',
      },
    ]);
    const revisions = Object.fromEntries(preview.revisions as Map<string, string>);
    expect(revisions).toEqual({
      'game.Fixture.A': revisionOf('local foo = 1\nreturn foo\n'),
      'game.Fixture.B': revisionOf('print(foo)\n'),
    });
    expect(corpus.writeScript).not.toHaveBeenCalled();

    const applied = replace.run({ ...request, expectedRevisions: revisions });

    expect(applied).toMatchObject({ success: true, scriptsModified: 2, totalReplacements: 3 });
    expect(changes(applied).map((change) => change.status)).toEqual(['applied', 'applied']);
    expect([a.source, b.source]).toEqual(['local bar = 1\nreturn bar\n', 'print(bar)\n']);
    expect(corpus.finishRecording).toHaveBeenCalledWith('recording', true);
  });

  test('a script edited after the preview refuses the whole apply', () => {
    const { root, a, b } = twoScripts('foo', 'foo');
    const { corpus } = corpusFor(root);
    const replace = scriptReplace.createScriptReplace(corpus);
    const preview = replace.run({ ...request, dryRun: true });
    const revisions = Object.fromEntries(preview.revisions as Map<string, string>);
    b.source = 'foo foo -- typed after the preview';

    const result = replace.run({ ...request, expectedRevisions: revisions });

    expect(result).toMatchObject({
      success: false,
      code: 'revision_mismatch',
      mismatches: [{
        instancePath: 'game.Fixture.B', reason: 'changed',
        expectedRevision: revisionOf('foo'), revision: revisionOf('foo foo -- typed after the preview'),
      }],
    });
    expect(a.source).toBe('foo');
    expect(corpus.writeScript).not.toHaveBeenCalled();
  });

  test('scripts that were not reviewed, or no longer match, or are gone also refuse the apply', () => {
    const { root, a, b } = twoScripts('foo', 'foo');
    const { corpus } = corpusFor(root);
    const replace = scriptReplace.createScriptReplace(corpus);

    const unreviewed = replace.run({ ...request, expectedRevisions: { 'game.Fixture.A': revisionOf('foo') } });
    expect(unreviewed.mismatches).toEqual([{ instancePath: 'game.Fixture.B', reason: 'not_reviewed', revision: revisionOf('foo') }]);

    a.source = 'bar';
    const fixture = root.children[0];
    fixture.children = fixture.children.filter((child) => child !== b);
    const stale = replace.run({
      ...request,
      expectedRevisions: { 'game.Fixture.A': revisionOf('bar'), 'game.Fixture.B': revisionOf('foo') },
    });
    expect(stale.mismatches).toEqual([
      { instancePath: 'game.Fixture.A', reason: 'no_longer_matches', expectedRevision: revisionOf('bar'), revision: revisionOf('bar') },
      { instancePath: 'game.Fixture.B', reason: 'missing', expectedRevision: revisionOf('foo') },
    ]);
    expect(corpus.writeScript).not.toHaveBeenCalled();
  });

  test('retrying an applied plan is refused instead of replacing again', () => {
    const { root, a } = twoScripts('x', 'y');
    const { corpus } = corpusFor(root);
    const replace = scriptReplace.createScriptReplace(corpus);
    // The replacement contains the pattern, so an unbound retry would apply twice.
    const grow = { pattern: 'x', replacement: 'xx', caseSensitive: true, path: 'game.Fixture' };
    const revisions = Object.fromEntries(replace.run({ ...grow, dryRun: true }).revisions as Map<string, string>);

    expect(replace.run({ ...grow, expectedRevisions: revisions }).success).toBe(true);
    const retry = replace.run({ ...grow, expectedRevisions: revisions });

    expect(retry).toMatchObject({ success: false, code: 'revision_mismatch' });
    expect(a.source).toBe('xx');
  });

  test('a script whose path names several instances cannot be bound to a revision', () => {
    const first = node('Twin', 'Script', 'foo');
    const second = node('Twin', 'Script', 'foo');
    const root = node('game', 'DataModel', undefined, [node('Fixture', 'Folder', undefined, [first, second])]);
    const { corpus } = corpusFor(root);
    const replace = scriptReplace.createScriptReplace(corpus);

    const preview = replace.run({ ...request, dryRun: true });
    expect(changes(preview).map((change) => change.ambiguous)).toEqual([true, true]);
    expect(preview.revisions).toBeUndefined();

    const bound = replace.run({ ...request, expectedRevisions: { 'game.Fixture.Twin': revisionOf('foo') } });
    expect(bound).toMatchObject({ success: false, code: 'revision_mismatch' });
    expect((bound.mismatches as Change[]).map((mismatch) => mismatch.reason)).toEqual(['ambiguous_path', 'ambiguous_path']);
    expect(corpus.writeScript).not.toHaveBeenCalled();

    // Without revisions, each planned instance is still written by reference.
    expect(replace.run(request)).toMatchObject({ success: true, scriptsModified: 2 });
    expect([first.source, second.source]).toEqual(['bar', 'bar']);
  });

  test('a malformed Lua pattern fails before any write', () => {
    const { root } = twoScripts();
    const { corpus } = corpusFor(root);

    const result = scriptReplace.createScriptReplace(corpus).run({ pattern: 'foo(', replacement: 'x', caseSensitive: true, usePattern: true });

    expect(result).toMatchObject({ success: false, totalReplacements: 0 });
    expect(String(result.error)).toMatch(/^Script traversal failed: .*malformed pattern/);
    expect(corpus.writeScript).not.toHaveBeenCalled();
  });

  test('a Lua pattern preview diffs whole sources, including replacements that add lines', () => {
    const a = node('A', 'Script', 'local a = 1\nlocal b = 2\nreturn a + b\n');
    const root = node('game', 'DataModel', undefined, [a]);
    const { corpus } = corpusFor(root);
    const replace = scriptReplace.createScriptReplace(corpus);

    const sameShape = replace.run({ pattern: 'local (%w+) = (%d)', replacement: 'local %1 = %2 + 0', caseSensitive: true, usePattern: true, dryRun: true });
    expect(changes(sameShape)[0].diff).toBe(
      '@@ -1,1 +1,1 @@\n-local a = 1\n+local a = 1 + 0\n@@ -2,1 +2,1 @@\n-local b = 2\n+local b = 2 + 0',
    );

    const added = replace.run({ pattern: 'return', replacement: 'print(a)\nreturn', caseSensitive: true, usePattern: true, dryRun: true });
    expect(changes(added)[0].diff).toBe('@@ -2,0 +3,1 @@\n+print(a)');
    expect(a.source).toBe('local a = 1\nlocal b = 2\nreturn a + b\n');
  });
});

describe('a failed write leaves an honest result', () => {
  function scripts() {
    const a = node('A', 'Script', 'foo');
    const b = node('B', 'Script', 'foo');
    const c = node('C', 'Script', 'foo');
    const root = node('game', 'DataModel', undefined, [a, b, c]);
    return { root, a, b, c };
  }
  const request = { pattern: 'foo', replacement: 'bar', caseSensitive: true };

  test('a draft typed into a later script restores the scripts already written', () => {
    const { root, a, b, c } = scripts();
    const { corpus } = corpusFor(root, {
      beforeWrite: (target) => {
        if (target === b && b.source === 'foo') b.source = 'foo -- draft';
      },
    });

    const result = scriptReplace.createScriptReplace(corpus).run(request);

    expect(result).toMatchObject({
      success: false,
      code: 'apply_failed',
      scriptsModified: 0,
      scriptsRestored: 1,
      scriptsFailed: 1,
      scriptsNotAttempted: 1,
    });
    expect(String(result.error)).toContain('Failed to write game.B');
    expect(changes(result).map((change) => change.status)).toEqual(['restored', 'failed', 'not_attempted']);
    expect([a.source, b.source, c.source]).toEqual(['foo', 'foo -- draft', 'foo']);
    expect(corpus.finishRecording).toHaveBeenCalledWith('recording', false);
  });

  test('a restore never overwrites a newer draft; the original source is returned instead', () => {
    const { root, a, b } = scripts();
    const { corpus } = corpusFor(root, {
      beforeWrite: (target) => {
        // The user edits A after it was written, then B's write is refused.
        if (target === b && b.source === 'foo') {
          a.source = 'bar -- newer draft';
          b.source = 'foo -- draft';
        }
      },
    });

    const result = scriptReplace.createScriptReplace(corpus).run(request);

    expect(result).toMatchObject({ success: false, code: 'apply_failed', scriptsModified: 1, scriptsRestored: 0 });
    expect(changes(result)[0]).toMatchObject({
      status: 'restore_failed',
      originalSource: 'foo',
      revision: revisionOf('foo'),
    });
    expect(a.source).toBe('bar -- newer draft');
    expect(corpus.finishRecording).toHaveBeenCalledWith('recording', true);
  });

  test('a write that throws is reported like a refused one', () => {
    const { root, a, b } = scripts();
    const { corpus } = corpusFor(root);
    const write = corpus.writeScript.getMockImplementation()!;
    corpus.writeScript.mockImplementation((target, newSource, expected) => {
      if (target === b) throw new Error('UpdateSourceAsync exploded');
      return write(target, newSource, expected);
    });

    const result = scriptReplace.createScriptReplace(corpus).run(request);

    expect(changes(result)[1]).toMatchObject({ status: 'failed', error: expect.stringContaining('UpdateSourceAsync exploded') });
    expect([a.source, b.source]).toEqual(['foo', 'foo']);
  });

  test('a write that landed but failed verification is restored with the others', () => {
    const { root, a, b, c } = scripts();
    const { corpus } = corpusFor(root);
    const write = corpus.writeScript.getMockImplementation()!;
    corpus.writeScript.mockImplementation((target, newSource, expected) => {
      if (target === b && newSource === 'bar') {
        b.source = 'bar';
        return { success: false, error: 'UpdateSourceAsync completed without updating the live script source' };
      }
      return write(target, newSource, expected);
    });

    const result = scriptReplace.createScriptReplace(corpus).run(request);

    expect(result).toMatchObject({ code: 'apply_failed', scriptsModified: 0, scriptsRestored: 2, scriptsFailed: 1 });
    expect(changes(result).map((change) => change.status)).toEqual(['restored', 'restored', 'not_attempted']);
    expect([a.source, b.source, c.source]).toEqual(['foo', 'foo', 'foo']);
  });

  test('a restore that landed but failed verification counts as restored', () => {
    const { root, a, b } = scripts();
    const { corpus } = corpusFor(root);
    const write = corpus.writeScript.getMockImplementation()!;
    corpus.writeScript.mockImplementation((target, newSource, expected) => {
      if (target === b) return { success: false, error: 'Script source changed while the edit was being applied' };
      if (target === a && newSource === 'foo') {
        a.source = 'foo';
        return { success: false, error: 'UpdateSourceAsync completed without updating the live script source' };
      }
      return write(target, newSource, expected);
    });

    const result = scriptReplace.createScriptReplace(corpus).run(request);

    expect(result).toMatchObject({ scriptsModified: 0, scriptsRestored: 1 });
    expect(changes(result)[0]).toMatchObject({ status: 'restored' });
    expect(changes(result)[0]).not.toHaveProperty('originalSource');
  });
});

describe('the Studio handler adapter', () => {
  const stubPlugin: Plugin = {
    name: 'script-find-replace-stubs',
    setup(build) {
      build.onResolve({ filter: /^\.\.\/(Utils|Recording)$/ }, (args) => ({ path: args.path.slice(3), namespace: 'stub' }));
      build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
        contents: `export default globalThis.__STUB_${args.path.toUpperCase()}__;`,
        loader: 'js',
      }));
    },
  };

  test('classFilter "Script" leaves LocalScripts and ModuleScripts unread and unchanged', async () => {
    const { root, server, client, shared } = threeClasses();
    const instance = (target: FakeNode): object => ({
      Name: target.name,
      ClassName: target.className,
      IsA: (name: string) => name === 'LuaSourceContainer' ? SCRIPT_CLASSES.has(target.className) : name === target.className,
      GetChildren: () => luauArray(target.children.map(instance)),
      target,
    });
    const targetOf = (value: unknown): FakeNode => (value as { target: FakeNode }).target;
    const readScriptSource = jest.fn((value: unknown) => targetOf(value).source);
    const handlers = await loadPluginModule<{ findAndReplaceInScripts(request: Record<string, unknown>): Record<string, unknown> }>(
      'studio-plugin/src/modules/handlers/ScriptHandlers.ts',
      {
        game: instance(root),
        __STUB_UTILS__: {
          getInstancePath: (value: unknown) => pathOf(targetOf(value)),
          getInstanceByPath: (requested: string) => requested === 'game.Fixture' ? instance(root.children[0]) : undefined,
          createPathAmbiguityChecker: () => () => false,
          readScriptSource,
          applyScriptSource: (value: unknown, newSource: string, expected: string) => {
            const target = targetOf(value);
            if (target.source !== expected) return { success: false, method: 'direct', error: 'changed' };
            target.source = newSource;
            return { success: true, method: 'UpdateSourceAsync' };
          },
        },
        __STUB_RECORDING__: { beginRecording: () => 'recording', finishRecording: () => undefined },
      },
      [stubPlugin],
    );

    const result = handlers.findAndReplaceInScripts({ pattern: '1', replacement: '2', path: 'game.Fixture', classFilter: 'Script' });

    expect(result).toMatchObject({ success: true, scriptsSearched: 1, scriptsModified: 1 });
    expect([server.source, client.source, shared.source]).toEqual(['return 2', 'return 1', 'return 1']);
    expect(readScriptSource).toHaveBeenCalledTimes(1);
  });
});
