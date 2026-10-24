import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { build as esbuildBuild, type Plugin } from 'esbuild';
import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';

function repositoryRoot(): string {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, 'studio-plugin')) ? cwd : path.resolve(cwd, '../..');
}

// Lua string semantics for the subset the plugin uses; tests stay ASCII so
// UTF-16 code units equal bytes.
function luaRange(length: number, index: number): number {
  return index < 0 ? length + index + 1 : index;
}

const luaString = {
  sub(text: string, i: number, j = -1): string {
    const start = Math.max(1, luaRange(text.length, i));
    const finish = Math.min(text.length, luaRange(text.length, j));
    return start > finish ? '' : text.slice(start - 1, finish);
  },
  find(text: string, pattern: string, init = 1, plain?: boolean): [number?, number?] {
    if (plain !== true) throw new Error('test shim only supports plain find');
    const start = Math.max(1, luaRange(text.length, init));
    if (start > text.length + 1) return [undefined];
    const found = text.indexOf(pattern, start - 1);
    return found < 0 ? [undefined] : [found + 1, found + pattern.length];
  },
  byte(text: string, i = 1, j = i): number[] {
    const bytes: number[] = [];
    for (let index = i; index <= j && index <= text.length; index++) bytes.push(text.charCodeAt(index - 1));
    return bytes;
  },
};

function robloxPcall(callback: (...args: unknown[]) => unknown, ...args: unknown[]): [boolean, unknown] {
  try {
    return [true, callback(...args)];
  } catch (error) {
    return [false, error instanceof Error ? error.message : error];
  }
}

const luauGlobals = {
  string: luaString,
  math: Math,
  bit32: {
    bxor: (a: number, b: number) => (a ^ b) >>> 0,
    lshift: (value: number, bits: number) => (value << bits) >>> 0,
  },
  typeIs: (value: unknown, expected: string) => expected === 'table'
    ? value !== null && typeof value === 'object'
    : typeof value === expected,
  pcall: robloxPcall,
  error: (message: unknown) => {
    throw new Error(String(message));
  },
};

async function loadPluginModule<T>(relativePath: string, globals: Record<string, unknown>, plugins: Plugin[] = []): Promise<T> {
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
  const context = vm.createContext({ module: commonJsModule, exports: commonJsModule.exports, console, ...luauGlobals, ...globals });
  vm.runInContext(`
    String.prototype.size = function() { return String(this).length; };
    Array.prototype.size = function() { return this.length; };
  `, context);
  vm.runInContext(buildResult.outputFiles[0].text, context);
  const loaded = commonJsModule.exports as { default?: T } & T;
  return loaded.default ?? loaded;
}

type ScriptEditPlan =
  | { ok: true; newSource: string; diff: string; diffTruncated: boolean }
  | { ok: false; error: string };

type ScriptEditsModule = {
  sourceRevision(source: string): string;
  planScriptEdits(
    source: string,
    edits: { oldString: string; newString: string; startLine?: number }[],
    includeDiff: boolean,
  ): ScriptEditPlan;
};

// Luau strings are byte arrays. Mapping each UTF-8 byte to one Latin-1 code
// unit lets the shim index exactly as the plugin does for non-ASCII text.
const utf8Bytes = (text: string): string => Buffer.from(text, 'utf8').toString('latin1');
const fromUtf8Bytes = (bytes: string): string => Buffer.from(bytes, 'latin1').toString('utf8');

type Handler = (request: Record<string, unknown>) => Record<string, unknown>;
type ScriptHandlersModule = {
  editScriptLines: Handler;
  getScriptSource: Handler;
  setScriptSource: Handler;
  insertScriptLines: Handler;
  deleteScriptLines: Handler;
};

function fnv1a32(text: string): number {
  let hash = 2166136261;
  for (const byte of Buffer.from(text, 'utf8')) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return hash;
}

const stubPlugin: Plugin = {
  name: 'script-multi-edit-stubs',
  setup(build) {
    build.onResolve({ filter: /^\.\.\/(Utils|Recording)$/ }, (args) => ({
      path: args.path.slice(3),
      namespace: 'script-multi-edit-stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'script-multi-edit-stub' }, (args) => ({
      contents: `export default globalThis.__STUB_${args.path.toUpperCase()}__;`,
      loader: 'js',
    }));
  },
};

// A script whose editor text lives in `state.source`. applyScriptSource behaves
// like the real compare-and-set: it refuses when the text moved since the read.
async function loadHandlers(initialSource: string) {
  const state = { source: initialSource };
  const applyScriptSource = jest.fn((_target: unknown, newSource: string, expectedSource?: string) => {
    if (expectedSource !== undefined && expectedSource !== state.source) {
      return { success: false, method: 'direct', error: 'Script source changed while the edit was being applied' };
    }
    state.source = newSource;
    return { success: true, method: 'UpdateSourceAsync' };
  });
  const beginRecording = jest.fn(() => 'recording-id');
  const finishRecording = jest.fn();
  const script = { Name: 'Main', ClassName: 'Script', Enabled: true, IsA: (name: string) => name === 'LuaSourceContainer' };
  const handlers = await loadPluginModule<ScriptHandlersModule>('studio-plugin/src/modules/handlers/ScriptHandlers.ts', {
    __STUB_UTILS__: {
      getInstancePath: () => 'game.ServerScriptService.Main',
      getInstanceByPath: (instancePath: string) => instancePath === 'game.ServerScriptService.Main' ? script : undefined,
      readScriptSource: () => state.source,
      applyScriptSource,
      splitLines: (source: string) => {
        // Created outside the VM, so it lacks the in-VM Array#size shim.
        const lines = Object.defineProperty(source.split('\n'), 'size', { value() { return this.length; } });
        const trailing = source.endsWith('\n');
        if (trailing) lines.pop();
        return [lines, trailing];
      },
      joinLines: (lines: string[], trailing: boolean) => lines.join('\n') + (trailing ? '\n' : ''),
    },
    __STUB_RECORDING__: { beginRecording, finishRecording },
  }, [stubPlugin]);
  const edit = (request: Record<string, unknown>) => handlers.editScriptLines({
    instancePath: 'game.ServerScriptService.Main',
    ...request,
  });
  return { state, handlers, edit, applyScriptSource, beginRecording, finishRecording };
}

const SOURCE = [
  'local Players = game:GetService("Players")',
  'local function greet(player)',
  '\tprint("hi", player.Name)',
  'end',
  'Players.PlayerAdded:Connect(greet)',
  '',
].join('\n');

describe('script revisions', () => {
  let edits: ScriptEditsModule;
  beforeAll(async () => {
    edits = await loadPluginModule<ScriptEditsModule>('studio-plugin/src/modules/ScriptEdits.ts', {});
  });

  test('revision is the byte length plus FNV-1a 32 of the exact text', () => {
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(edits.sourceRevision('')).toBe('0:2166136261');
    expect(edits.sourceRevision('a')).toBe(`1:${0xe40c292c}`);
    // Longer than one byte chunk, so chunk boundaries are covered.
    const long = 'x = 1\n'.repeat(2000);
    expect(edits.sourceRevision(long)).toBe(`${long.length}:${fnv1a32(long)}`);
  });

  test('any change to the text changes the revision', () => {
    expect(edits.sourceRevision(SOURCE)).not.toBe(edits.sourceRevision(`${SOURCE} `));
    expect(edits.sourceRevision(SOURCE)).not.toBe(edits.sourceRevision(SOURCE.replace('hi', 'ho')));
    expect(edits.sourceRevision('local a\r\n')).not.toBe(edits.sourceRevision('local a\n'));
  });
});

describe('edit_script_lines batched edits in the plugin', () => {
  test('get_script_source reports the revision of the full editor text, even for partial reads', async () => {
    const { handlers } = await loadHandlers(SOURCE);
    const scriptEdits = await loadPluginModule<ScriptEditsModule>('studio-plugin/src/modules/ScriptEdits.ts', {});
    const partial = handlers.getScriptSource({ instancePath: 'game.ServerScriptService.Main', startLine: 2, endLine: 3 });
    expect(partial.revision).toBe(scriptEdits.sourceRevision(SOURCE));
    expect(partial.source).toBe('local function greet(player)\n\tprint("hi", player.Name)');
  });

  test('applies several replacements in one write and one recording', async () => {
    const { state, edit, applyScriptSource, beginRecording, finishRecording } = await loadHandlers(SOURCE);
    const scriptEdits = await loadPluginModule<ScriptEditsModule>('studio-plugin/src/modules/ScriptEdits.ts', {});

    const result = edit({
      edits: [
        { old_string: 'Players.PlayerAdded:Connect(greet)', new_string: 'Players.PlayerAdded:Connect(welcome)' },
        { old_string: 'local function greet(player)', new_string: 'local function welcome(player)' },
        { old_string: '"hi"', new_string: '"welcome"' },
      ],
      expectedRevision: scriptEdits.sourceRevision(SOURCE),
    });

    const expected = SOURCE
      .replace('Connect(greet)', 'Connect(welcome)')
      .replace('function greet', 'function welcome')
      .replace('"hi"', '"welcome"');
    expect(result).toMatchObject({ success: true, editCount: 3, revision: scriptEdits.sourceRevision(expected) });
    expect(state.source).toBe(expected);
    expect(applyScriptSource).toHaveBeenCalledTimes(1);
    expect(applyScriptSource.mock.calls[0][2]).toBe(SOURCE);
    expect(beginRecording).toHaveBeenCalledTimes(1);
    expect(beginRecording).toHaveBeenCalledWith('Edit script (3 edits): Main');
    expect(finishRecording).toHaveBeenCalledWith('recording-id', true);
  });

  test('a failing second replacement changes nothing', async () => {
    const { state, edit, applyScriptSource, beginRecording } = await loadHandlers(SOURCE);

    const result = edit({
      edits: [
        { old_string: 'greet(player)', new_string: 'welcome(player)' },
        { old_string: 'does not exist', new_string: 'x' },
      ],
    });

    expect(result.error).toMatch(/^Failed to edit script: edits\[1\]: old_string not found/);
    expect(result.error).toContain('pass line_range');
    expect(state.source).toBe(SOURCE);
    expect(applyScriptSource).not.toHaveBeenCalled();
    expect(beginRecording).not.toHaveBeenCalled();
  });

  test('ambiguous and overlapping edits are rejected with their indices', async () => {
    const { state, edit, applyScriptSource } = await loadHandlers('a = 1\nb = 1\nc = 2\n');

    expect(edit({ edits: [{ old_string: 'c', new_string: 'C' }, { old_string: '= 1', new_string: '= 3' }] }).error)
      .toContain('edits[1]: old_string matches multiple locations (lines 1 and 2)');
    expect(edit({ edits: [{ old_string: 'b = 1', new_string: 'x' }, { old_string: '1\nc', new_string: 'y' }] }).error)
      .toContain('edits[0] and edits[1] overlap at line 2');
    expect(edit({
      edits: [
        { old_string: '', new_string: '-- one\n', startLine: 2 },
        { old_string: '', new_string: '-- two\n', startLine: 2 },
      ],
    }).error).toContain('edits[0] and edits[1] overlap at line 2');
    expect(state.source).toBe('a = 1\nb = 1\nc = 2\n');
    expect(applyScriptSource).not.toHaveBeenCalled();
  });

  test.each([
    ['a repeated run', 'aaa', 'aa'],
    ['an alternating run', 'ababa', 'aba'],
    ['nested block ends', 'if a then\n\tif b then\n\tend\nend\nend\n', 'end\nend'],
  ])('an old_string whose matches overlap (%s) is ambiguous and changes nothing', async (_name, source, oldString) => {
    const { state, edit, applyScriptSource, beginRecording } = await loadHandlers(source);

    expect(edit({ old_string: oldString, new_string: 'X' }).error).toContain('old_string matches multiple locations');
    expect(edit({ edits: [{ old_string: oldString, new_string: 'X' }], dryRun: true }).error)
      .toContain('old_string matches multiple locations');
    expect(state.source).toBe(source);
    expect(applyScriptSource).not.toHaveBeenCalled();
    expect(beginRecording).not.toHaveBeenCalled();
  });

  test('overlapping matches on one line ask for more surrounding context', async () => {
    const { edit } = await loadHandlers('local s = "aaa"\n');

    const error = String(edit({ old_string: 'aa', new_string: 'X' }).error);

    expect(error).toContain('old_string matches multiple locations on line 1');
    expect(error).toContain('more surrounding context');
  });

  test('a line anchor still selects one of several overlapping matches', async () => {
    const { state, edit } = await loadHandlers('aaa\nb\n');

    expect(edit({ old_string: 'aa', new_string: 'X', startLine: 1 }).success).toBe(true);
    expect(state.source).toBe('Xa\nb\n');
  });

  test('uniqueness is checked on UTF-8 bytes, including overlaps inside multibyte text', async () => {
    const scriptEdits = await loadPluginModule<ScriptEditsModule>('studio-plugin/src/modules/ScriptEdits.ts', {});
    const source = utf8Bytes('-- café\nlocal ééé = "ü"\n');
    // Arrays built outside the VM lack its Array#size shim.
    const plan = (oldString: string) => scriptEdits.planScriptEdits(source, Object.defineProperty(
      [{ oldString: utf8Bytes(oldString), newString: utf8Bytes('ø') }],
      'size', { value() { return this.length; } },
    ), false);

    const overlapping = plan('éé');
    expect(overlapping.ok).toBe(false);
    expect(overlapping.ok ? '' : overlapping.error).toContain('matches multiple locations on line 2');
    const unique = plan('"ü"');
    expect(unique.ok && fromUtf8Bytes(unique.newSource)).toBe('-- café\nlocal ééé = ø\n');
    const separate = plan('é');
    expect(separate.ok ? '' : separate.error).toContain('matches multiple locations (lines 1 and 2)');
  });

  test('line anchors refer to the source as read, not as shifted by earlier edits', async () => {
    const { state, edit } = await loadHandlers('x = 1\nend\nend\n');

    const result = edit({
      edits: [
        { old_string: 'x = 1', new_string: 'x = 1\ny = 2\nz = 3' },
        { old_string: 'end', new_string: 'end -- second', startLine: 3 },
      ],
    });

    expect(result.success).toBe(true);
    expect(state.source).toBe('x = 1\ny = 2\nz = 3\nend\nend -- second\n');
  });

  test('a stale expected_revision is rejected without writing', async () => {
    const { state, edit, applyScriptSource } = await loadHandlers(SOURCE);
    const scriptEdits = await loadPluginModule<ScriptEditsModule>('studio-plugin/src/modules/ScriptEdits.ts', {});
    const readRevision = scriptEdits.sourceRevision(SOURCE);
    // The user keeps typing in the open editor after the agent read the script.
    state.source = SOURCE.replace('"hi"', '"hello"');

    const result = edit({
      edits: [{ old_string: 'greet(player)', new_string: 'welcome(player)' }],
      expectedRevision: readRevision,
    });

    expect(result).toMatchObject({
      code: 'revision_mismatch',
      expectedRevision: readRevision,
      revision: scriptEdits.sourceRevision(state.source),
    });
    expect(result.error).toContain('get_script_source');
    expect(state.source).toBe(SOURCE.replace('"hi"', '"hello"'));
    expect(applyScriptSource).not.toHaveBeenCalled();
  });

  test('edits apply on top of the open editor draft and keep it', async () => {
    const draft = SOURCE.replace('"hi"', '"draft"');
    const { state, edit, applyScriptSource } = await loadHandlers(draft);

    expect(edit({ edits: [{ old_string: 'Connect(greet)', new_string: 'Connect(greet) -- wired' }] }).success).toBe(true);

    expect(applyScriptSource.mock.calls[0][2]).toBe(draft);
    expect(state.source).toContain('"draft"');
    expect(state.source).toContain('Connect(greet) -- wired');
  });

  test('retrying an applied edit with its revision does not apply it twice', async () => {
    const { state, edit, applyScriptSource } = await loadHandlers(SOURCE);
    const scriptEdits = await loadPluginModule<ScriptEditsModule>('studio-plugin/src/modules/ScriptEdits.ts', {});
    // new_string contains old_string, so without a revision a retry would match again.
    const request = {
      edits: [{ old_string: 'end\n', new_string: 'end\nprint("loaded")\n' }],
      expectedRevision: scriptEdits.sourceRevision(SOURCE),
    };

    expect(edit(request).success).toBe(true);
    const applied = state.source;
    expect(edit(request).code).toBe('revision_mismatch');

    expect(state.source).toBe(applied);
    expect(applied.match(/print\("loaded"\)/g)).toHaveLength(1);
    expect(applyScriptSource).toHaveBeenCalledTimes(1);
  });

  test('dry_run returns a diff and the resulting revision without writing', async () => {
    const { state, edit, applyScriptSource, beginRecording } = await loadHandlers(SOURCE);
    const scriptEdits = await loadPluginModule<ScriptEditsModule>('studio-plugin/src/modules/ScriptEdits.ts', {});
    const request = {
      edits: [
        { old_string: '\tprint("hi", player.Name)\n', new_string: '' },
        { old_string: 'local Players', new_string: 'local PlayerService' },
        { old_string: 'Players.PlayerAdded', new_string: 'PlayerService.PlayerAdded' },
      ],
    };

    const preview = edit({ ...request, dryRun: true });

    expect(preview).toMatchObject({
      success: true,
      dryRun: true,
      editCount: 3,
      revision: scriptEdits.sourceRevision(SOURCE),
    });
    expect(preview.diff).toBe([
      '@@ -1,1 +1,1 @@',
      '-local Players = game:GetService("Players")',
      '+local PlayerService = game:GetService("Players")',
      '@@ -3,1 +2,0 @@',
      '-\tprint("hi", player.Name)',
      '@@ -5,1 +4,1 @@',
      '-Players.PlayerAdded:Connect(greet)',
      '+PlayerService.PlayerAdded:Connect(greet)',
    ].join('\n'));
    expect(preview).not.toHaveProperty('diffTruncated');
    expect(state.source).toBe(SOURCE);
    expect(applyScriptSource).not.toHaveBeenCalled();
    expect(beginRecording).not.toHaveBeenCalled();

    const applied = edit({ ...request, expectedRevision: preview.revision });
    expect(applied.success).toBe(true);
    expect(applied.revision).toBe(preview.resultRevision);
  });

  test('a preview of edits on one line merges them into one hunk', async () => {
    const { edit } = await loadHandlers('local a, b = 1, 2\nreturn a\n');

    const preview = edit({
      edits: [{ old_string: 'a, b', new_string: 'x, y' }, { old_string: '1, 2', new_string: '3, 4' }],
      dryRun: true,
    });

    expect(preview.diff).toBe('@@ -1,1 +1,1 @@\n-local a, b = 1, 2\n+local x, y = 3, 4');
  });

  test.each([
    ['removing the final newline', 'a\nb\n', 'b\n', 'b', '@@ -2,1 +2,1 @@\n-b\n+b\n\\ No newline at end of file'],
    ['adding a final newline', 'a\nb', 'b', 'b\n', '@@ -2,1 +2,1 @@\n-b\n\\ No newline at end of file\n+b'],
    ['extending a file that lacks a final newline', 'a\nb', 'b', 'b\nc', '@@ -2,1 +2,2 @@\n-b\n\\ No newline at end of file\n+b\n+c\n\\ No newline at end of file'],
  ])('a preview shows %s', async (_name, source, oldString, newString, diff) => {
    const { edit } = await loadHandlers(source);

    const preview = edit({ edits: [{ old_string: oldString, new_string: newString }], dryRun: true });

    expect(preview.revision).not.toBe(preview.resultRevision);
    expect(preview.diff).toBe(diff);
  });

  test('a preview of an unchanged final line without a newline stays out of the hunk', async () => {
    const { edit } = await loadHandlers('a\nb');

    const preview = edit({ edits: [{ old_string: 'a', new_string: 'x' }], dryRun: true });

    expect(preview.diff).toBe('@@ -1,1 +1,1 @@\n-a\n+x');
  });

  test('the legacy single-edit request keeps working', async () => {
    const { state, edit, beginRecording } = await loadHandlers('if a then\nend\nif b then\nend\n');

    expect(edit({ old_string: 'end', new_string: 'end' }).error).toContain('old_string matches multiple locations');
    const result = edit({ old_string: 'end', new_string: 'end -- b', startLine: 4 });

    expect(result).toMatchObject({ success: true, editCount: 1, message: 'Script edited successfully' });
    expect(state.source).toBe('if a then\nend\nif b then\nend -- b\n');
    expect(beginRecording).toHaveBeenLastCalledWith('Edit script: Main');
    expect(edit({ old_string: 'end' }).error).toBe('Instance path, old_string, and new_string are required');
    expect(edit({ old_string: 'end', new_string: 'x', startLine: 2.5 }).error).toContain('line must be a positive whole number');
    expect(edit({ old_string: 'end', new_string: 'x', startLine: 99 }).error).toContain('line 99 is past the end of the script');
  });
});

describe('revision-checked line edits and whole-source replacement in the plugin', () => {
  const MAIN = 'game.ServerScriptService.Main';
  const LINES = 'a\nb\nc\nd\n';

  test('a retried delete with its revision cannot remove lines it never saw', async () => {
    const { state, handlers, applyScriptSource } = await loadHandlers(LINES);
    const scriptEdits = await loadPluginModule<ScriptEditsModule>('studio-plugin/src/modules/ScriptEdits.ts', {});
    const request = { instancePath: MAIN, startLine: 2, endLine: 2, expectedRevision: scriptEdits.sourceRevision(LINES) };

    const deleted = handlers.deleteScriptLines(request);
    expect(deleted).toMatchObject({ success: true, revision: scriptEdits.sourceRevision('a\nc\nd\n') });
    const retried = handlers.deleteScriptLines(request);

    expect(retried).toMatchObject({
      code: 'revision_mismatch',
      expectedRevision: scriptEdits.sourceRevision(LINES),
      revision: scriptEdits.sourceRevision('a\nc\nd\n'),
    });
    expect(state.source).toBe('a\nc\nd\n');
    expect(applyScriptSource).toHaveBeenCalledTimes(1);
  });

  test('a retried insert with its revision is not inserted twice', async () => {
    const { state, handlers } = await loadHandlers(LINES);
    const scriptEdits = await loadPluginModule<ScriptEditsModule>('studio-plugin/src/modules/ScriptEdits.ts', {});
    const request = { instancePath: MAIN, afterLine: 1, newContent: 'print(1)', expectedRevision: scriptEdits.sourceRevision(LINES) };

    expect(handlers.insertScriptLines(request)).toMatchObject({ success: true, revision: scriptEdits.sourceRevision('a\nprint(1)\nb\nc\nd\n') });
    expect(handlers.insertScriptLines(request)).toMatchObject({ code: 'revision_mismatch' });
    expect(state.source).toBe('a\nprint(1)\nb\nc\nd\n');
  });

  test('set_script_source with a revision refuses a stale read and writes by compare-and-set otherwise', async () => {
    const { state, handlers, applyScriptSource, beginRecording } = await loadHandlers(LINES);
    const scriptEdits = await loadPluginModule<ScriptEditsModule>('studio-plugin/src/modules/ScriptEdits.ts', {});

    const stale = handlers.setScriptSource({ instancePath: MAIN, source: 'x\n', expectedRevision: scriptEdits.sourceRevision('old') });
    expect(stale).toMatchObject({ code: 'revision_mismatch', revision: scriptEdits.sourceRevision(LINES) });
    expect(state.source).toBe(LINES);
    expect(beginRecording).not.toHaveBeenCalled();

    const checked = handlers.setScriptSource({ instancePath: MAIN, source: 'x\n', expectedRevision: scriptEdits.sourceRevision(LINES) });
    expect(checked).toMatchObject({ success: true, revision: scriptEdits.sourceRevision('x\n'), oldSourceLength: LINES.length });
    expect(applyScriptSource).toHaveBeenLastCalledWith(expect.anything(), 'x\n', LINES);

    // Without a revision the write stays an unconditional replacement.
    expect(handlers.setScriptSource({ instancePath: MAIN, source: 'y\n' }).success).toBe(true);
    expect(applyScriptSource).toHaveBeenLastCalledWith(expect.anything(), 'y\n');
    expect(state.source).toBe('y\n');
  });

  test.each(['setScriptSource', 'insertScriptLines', 'deleteScriptLines'] as const)('%s rejects a malformed expectedRevision', async (handler) => {
    const { handlers, applyScriptSource } = await loadHandlers(LINES);
    const result = handlers[handler]({
      instancePath: MAIN, source: 'x', newContent: 'x', startLine: 1, endLine: 1, expectedRevision: 7,
    });
    expect(result.error).toBe('expectedRevision must be a nonempty string');
    expect(applyScriptSource).not.toHaveBeenCalled();
  });
});

class SimulatedTopologyBridge extends BridgeService {
  protected override notifyPeerRegistered(): void {
    // Simulated topology must not mutate the local managed-Studio registry.
  }
}

describe('edit_script_lines request shape', () => {
  let bridge: BridgeService;
  let tools: RobloxStudioTools;
  beforeEach(() => {
    bridge = new SimulatedTopologyBridge();
    tools = new RobloxStudioTools(bridge);
    bridge.registerPeer({
      peerId: 'edit', transportPeerId: 'edit', instanceId: 'instance:edits',
      role: 'edit', placeId: 0, placeName: 'Edits',
    });
  });
  afterEach(() => bridge.clearAllPendingRequests());

  async function dispatched(invoke: () => Promise<unknown>) {
    const pending = invoke();
    let delivery = bridge.claimNextRequestForTransport('edit', 'socket');
    for (let attempt = 0; !delivery && attempt < 10; attempt++) {
      await Promise.resolve();
      delivery = bridge.claimNextRequestForTransport('edit', 'socket');
    }
    expect(delivery).toBeTruthy();
    bridge.settleTransportResponse('edit', delivery!.requestId, { success: true });
    await pending;
    return delivery!.data;
  }

  test('a plain single edit keeps the legacy payload', async () => {
    const data = await dispatched(() => tools.editScriptLines('game.ServerScriptService.Main', [
      { oldString: 'a', newString: 'b', startLine: 3 },
    ], {}, 'instance:edits'));
    expect(data).toEqual({ instancePath: 'game.ServerScriptService.Main', old_string: 'a', new_string: 'b', startLine: 3 });
  });

  test('batches, revisions, and previews only use edits so older plugins refuse them', async () => {
    const batch = await dispatched(() => tools.editScriptLines('game.ServerScriptService.Main', [
      { oldString: 'a', newString: 'b' },
      { oldString: 'c', newString: 'd', startLine: 4 },
    ], { expectedRevision: '7:99', dryRun: true }, 'instance:edits'));
    expect(batch).toEqual({
      instancePath: 'game.ServerScriptService.Main',
      edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd', startLine: 4 }],
      expectedRevision: '7:99',
      dryRun: true,
    });

    const guarded = await dispatched(() => tools.editScriptLines('game.ServerScriptService.Main', [
      { oldString: 'a', newString: 'b' },
    ], { expectedRevision: '7:99' }, 'instance:edits'));
    expect(guarded).not.toHaveProperty('old_string');
    expect(guarded).toMatchObject({ edits: [{ old_string: 'a', new_string: 'b' }], expectedRevision: '7:99' });
  });
});
