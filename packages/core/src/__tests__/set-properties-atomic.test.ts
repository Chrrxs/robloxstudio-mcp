import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { BridgeService } from '../bridge-service.js';
import { TOOL_HANDLERS } from '../http-server.js';
import { RobloxStudioTools } from '../tools/index.js';

// Runs the real PropertyHandlers (with the real convertPropertyValue) against
// mock instances whose property reads and writes behave like the engine's:
// unknown members throw, and individual setters can be made to fail.

const instances = new WeakSet<object>();

function loadPluginModule(file: string, globals: Record<string, unknown>): Record<string, unknown> {
  const source = readFileSync(resolve(__dirname, '../../../../studio-plugin/src/modules', file), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} as Record<string, unknown> };
  const context = createContext({
    module, exports: module.exports,
    game: { GetService: () => ({}) },
    pairs: Object.entries, tostring: String,
    typeOf: (value: unknown) => (typeof value === 'object' && value !== null && instances.has(value) ? 'Instance' : typeof value),
    typeIs: (value: unknown, kind: string) => kind === 'table' ? typeof value === 'object' : typeof value === kind,
    error: (message: string) => { throw new Error(message); },
    pcall: (callback: () => unknown) => {
      try { return [true, callback()]; } catch (error) { return [false, String(error)]; }
    },
    ...globals,
  });
  // roblox-ts exposes Luau's length operator as size().
  runInContext('Array.prototype.size = function () { return this.length; }; String.prototype.size = function () { return this.length; };', context);
  runInContext(compiled.outputText, context);
  return module.exports;
}

const utils = loadPluginModule('Utils.ts', {
  require: (name: string) => {
    if (name === './PathAmbiguity') return { default: loadPluginModule('PathAmbiguity.ts', {}) };
    throw new Error(`Unexpected import ${name}`);
  },
});

type Setter = (value: unknown, state: Record<string, unknown>) => void;

function mockInstance(name: string, className: string, initial: Record<string, unknown>, options: {
  classes?: string[]; setters?: Record<string, Setter>; writes?: Array<[string, string, unknown]>;
} = {}) {
  const state: Record<string, unknown> = { Name: name, Parent: undefined, ...initial };
  const members: Record<string, unknown> = {
    ClassName: className,
    IsA: (kind: string) => kind === className || (options.classes ?? []).includes(kind),
    IsDescendantOf: () => false,
  };
  const proxy = new Proxy(state, {
    get(target, key) {
      if (typeof key !== 'string') return undefined;
      if (key in members) return members[key];
      if (key in target) return target[key];
      throw new Error(`${key} is not a valid member of ${className}`);
    },
    set(target, key, value) {
      if (typeof key !== 'string' || !(key in target)) throw new Error(`${String(key)} is not a valid member of ${className}`);
      options.writes?.push([name, key, value]);
      const setter = options.setters?.[key];
      if (setter) setter(value, target);
      else target[key] = value;
      return true;
    },
  });
  instances.add(proxy);
  return { state, proxy };
}

function fixture(options: { setters?: Record<string, Setter>; classes?: string[]; initial?: Record<string, unknown> } = {}) {
  const writes: Array<[string, string, unknown]> = [];
  const folder = mockInstance('Folder', 'Folder', {}, { writes });
  const base = mockInstance('Base', 'Part', {}, { classes: ['BasePart'], writes });
  const target = mockInstance('Target', 'Part', {
    Anchored: false, Health: 100, Transparency: 0, Source: 'old', ...options.initial,
  }, { classes: options.classes, setters: options.setters, writes });
  const paths = new Map<unknown, string>([
    [folder.proxy, 'game.Workspace.Folder'], [base.proxy, 'game.Workspace.Base'], [target.proxy, 'game.Workspace.Target'],
  ]);
  const beginRecording = jest.fn(() => 'recording');
  const finishRecording = jest.fn();
  const applyScriptSource = jest.fn(() => ({ success: true }));
  const handler = loadPluginModule('handlers/PropertyHandlers.ts', {
    require: (name: string) => {
      if (name === '../Utils') return { default: {
        ...utils, applyScriptSource,
        getInstanceByPath: (path: string) => [...paths].find(([, candidate]) => candidate === path)?.[0],
        getInstancePath: (instance: unknown) => paths.get(instance) ?? '<unknown>',
      } };
      if (name === '../Recording') return { default: { beginRecording, finishRecording } };
      throw new Error(`Unexpected import ${name}`);
    },
  });
  const setProperties = handler.setProperties;
  if (typeof setProperties !== 'function') throw new Error('Property handler did not export setProperties');
  return {
    state: target.state, folder, base, writes, beginRecording, finishRecording, applyScriptSource,
    set: (properties: Record<string, unknown>, extra: Record<string, unknown> = { atomic: true }): Record<string, unknown> =>
      setProperties({ instancePath: 'game.Workspace.Target', properties, ...extra }),
  };
}

const failingSetter: Setter = () => { throw new Error('engine rejected Transparency'); };

describe('atomic set_properties', () => {
  test('an invalid property fails validation and nothing is written', () => {
    const f = fixture();
    const result = f.set({ Name: 'Renamed', Health: 'lots', Bogus: 1, Parent: 'game.Workspace.Missing' });
    expect(result).toMatchObject({
      success: false, atomic: true, phase: 'validation', rolledBack: false, changed: [], restored: [], restoreFailures: [],
      summary: { total: 4, invalid: 3, changed: 0 },
      results: [
        { property: 'Bogus', status: 'invalid', code: 'property_unreadable' },
        { property: 'Health', status: 'invalid', code: 'type_mismatch' },
        { property: 'Name', status: 'valid', previous: 'Target', value: 'Renamed' },
        { property: 'Parent', status: 'invalid', code: 'reference_not_found' },
      ],
    });
    expect(String(result.error)).toContain('nothing was written');
    expect(f.writes).toEqual([]);
    expect(f.beginRecording).not.toHaveBeenCalled();
  });

  test('a valid request applies in name order with one committed recording', () => {
    const f = fixture();
    const result = f.set({ Transparency: 0.5, Parent: 'game.Workspace.Folder', Anchored: 'true', Name: 'Renamed' });
    expect(result).toMatchObject({
      success: true, phase: 'apply', rolledBack: false, restored: [], restoreFailures: [],
      changed: [
        { property: 'Anchored', previous: false, value: true },
        { property: 'Name', previous: 'Target', value: 'Renamed' },
        { property: 'Parent', value: 'game.Workspace.Folder' },
        { property: 'Transparency', previous: 0, value: 0.5 },
      ],
    });
    expect(f.writes.map(([, property]) => property)).toEqual(['Anchored', 'Name', 'Parent', 'Transparency']);
    expect(f.state).toMatchObject({ Anchored: true, Name: 'Renamed', Transparency: 0.5 });
    expect(f.state.Parent).toBe(f.folder.proxy);
    expect(f.finishRecording).toHaveBeenCalledWith('recording', true);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test('a mid-apply engine failure restores earlier writes in reverse order', () => {
    const f = fixture({ setters: { Transparency: failingSetter } });
    const result = f.set({ Anchored: true, Name: 'Renamed', Transparency: 0.5 });
    expect(result).toMatchObject({
      success: false, phase: 'apply', failedProperty: 'Transparency', rolledBack: true,
      changed: [{ property: 'Anchored', value: true }, { property: 'Name', value: 'Renamed' }],
      restored: ['Name', 'Anchored'], restoreFailures: [],
      results: [
        { property: 'Anchored', status: 'applied', restoreStatus: 'restored' },
        { property: 'Name', status: 'applied', restoreStatus: 'restored' },
        { property: 'Transparency', status: 'failed', code: 'write_failed' },
      ],
    });
    expect(String(result.error)).toContain('every applied change was restored');
    expect(f.state).toMatchObject({ Anchored: false, Name: 'Target', Transparency: 0 });
    expect(f.writes.map(([, property, value]) => [property, value])).toEqual([
      ['Anchored', true], ['Name', 'Renamed'], ['Transparency', 0.5], ['Name', 'Target'], ['Anchored', false],
    ]);
    // Commit, never Cancel: Cancel can also undo earlier unrecorded edits.
    expect(f.finishRecording).toHaveBeenCalledWith('recording', true);
  });

  test('later properties are reported as not attempted', () => {
    const f = fixture({ setters: { Anchored: () => { throw new Error('locked'); } } });
    const result = f.set({ Anchored: true, Name: 'Renamed' });
    expect(result).toMatchObject({
      success: false, rolledBack: true, changed: [], restored: [],
      results: [{ property: 'Anchored', status: 'failed' }, { property: 'Name', status: 'not_attempted' }],
    });
    expect(f.state.Name).toBe('Target');
  });

  test('a change made after our write is a restore conflict and is not overwritten', () => {
    // Writing Name fires a listener-style change to Health, which was applied first.
    const f = fixture({
      setters: {
        Name: (value, state) => { state.Name = value; state.Health = 75; },
        Transparency: failingSetter,
      },
    });
    const result = f.set({ Health: 50, Name: 'Renamed', Transparency: 0.5 });
    expect(result).toMatchObject({
      success: false, phase: 'apply', rolledBack: false,
      restored: ['Name'],
      restoreFailures: [{ property: 'Health', code: 'restore_conflict', written: 50, current: 75, previous: 100 }],
    });
    expect(String(result.error)).toContain('1 applied change(s) could not be restored');
    expect(f.state).toMatchObject({ Health: 75, Name: 'Target' });
  });

  test('a restore that the engine rejects is reported and is not called a rollback', () => {
    const f = fixture({
      setters: {
        Health: (value, state) => { if (value === 100) throw new Error('cannot restore'); state.Health = value; },
        Transparency: failingSetter,
      },
    });
    const result = f.set({ Health: 50, Transparency: 0.5 });
    expect(result).toMatchObject({
      success: false, rolledBack: false, restored: [],
      restoreFailures: [{ property: 'Health', code: 'restore_write_failed', previous: 100 }],
    });
    expect(f.state.Health).toBe(50);
  });

  test('a setter that changes the value before throwing is restored too', () => {
    const f = fixture({ setters: {
      Transparency: (value, state) => { state.Transparency = value; if (value !== 0) throw new Error('late failure'); },
    } });
    const result = f.set({ Transparency: 0.5 });
    expect(result).toMatchObject({
      success: false, rolledBack: true, restored: ['Transparency'],
      changed: [{ property: 'Transparency', value: 0.5, partial: true }],
    });
    expect(f.state.Transparency).toBe(0);
  });

  test('script Source is rejected before any write', () => {
    const f = fixture({ classes: ['LuaSourceContainer'] });
    const result = f.set({ Source: 'print(1)', Name: 'Renamed' });
    expect(result).toMatchObject({
      success: false, phase: 'validation',
      results: [{ property: 'Name', status: 'valid' }, { property: 'Source', status: 'invalid', code: 'source_unsupported' }],
    });
    expect(f.applyScriptSource).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });

  test.each([
    [{ Parent: 'game.Workspace.Target' }, 'invalid_value'],
    [{ Parent: 42 }, 'invalid_value'],
    [{ Name: { nested: true } }, 'invalid_value'],
  ])('rejects invalid references and names %j', (properties, code) => {
    const f = fixture();
    expect(f.set(properties)).toMatchObject({ success: false, phase: 'validation', results: [{ status: 'invalid', code }] });
    expect(f.writes).toEqual([]);
  });

  test('PrimaryPart must reference a BasePart and can be cleared', () => {
    const f = fixture({ initial: { PrimaryPart: undefined } });
    expect(f.set({ PrimaryPart: 'game.Workspace.Folder' })).toMatchObject({ success: false, results: [{ code: 'invalid_value' }] });
    expect(f.set({ PrimaryPart: 'game.Workspace.Base' })).toMatchObject({ success: true });
    expect(f.state.PrimaryPart).toBe(f.base.proxy);
    expect(f.set({ PrimaryPart: '' })).toMatchObject({ success: true, changed: [{ property: 'PrimaryPart', previous: 'game.Workspace.Base' }] });
    expect(f.state.PrimaryPart).toBeUndefined();
  });

  test('dryRun previews the same conversions and writes nothing', () => {
    const f = fixture();
    const preview = f.set({ Anchored: 'true', Parent: 'game.Workspace.Folder', Name: 7 }, { atomic: true, dryRun: true });
    expect(preview).toMatchObject({
      success: true, atomic: true, dryRun: true, phase: 'validation', changed: [], rolledBack: false,
      results: [
        { property: 'Anchored', status: 'valid', previous: false, value: true },
        { property: 'Name', status: 'valid', previous: 'Target', value: '7' },
        { property: 'Parent', status: 'valid', value: 'game.Workspace.Folder' },
      ],
    });
    expect(f.writes).toEqual([]);
    expect(f.beginRecording).not.toHaveBeenCalled();

    const invalid = f.set({ Health: 'lots' }, { atomic: true, dryRun: true });
    expect(invalid).toMatchObject({ success: false, phase: 'validation', results: [{ code: 'type_mismatch' }] });
    expect(f.writes).toEqual([]);
  });

  test('dryRun without atomic is refused instead of writing', () => {
    const f = fixture();
    expect(f.set({ Name: 'Renamed' }, { dryRun: true })).toEqual({ error: 'dryRun requires atomic: true' });
    expect(f.writes).toEqual([]);
  });

  test('without atomic, writes stay independent and the result shape is unchanged', () => {
    const f = fixture({ setters: { Transparency: failingSetter } });
    const result = f.set({ Health: 50, Transparency: 0.5 }, {});
    expect(result).toEqual({
      success: false,
      instancePath: 'game.Workspace.Target',
      summary: { total: 2, succeeded: 1, failed: 1 },
      results: [
        { property: 'Health', success: true },
        { property: 'Transparency', success: false, error: expect.stringContaining('engine rejected Transparency') },
      ],
    });
    expect(f.state.Health).toBe(50);
  });
});

class OptionsTestBridge extends BridgeService {
  protected override notifyPeerRegistered(): void {
    // Synthetic peers must not mutate the local managed-Studio registry.
  }
}

describe('set_properties atomic options on the server', () => {
  let bridge: BridgeService;
  let sendRequest: jest.SpyInstance;
  let tools: RobloxStudioTools;
  beforeEach(() => {
    bridge = new OptionsTestBridge();
    bridge.registerPeer({ peerId: 'edit', transportPeerId: 'edit', instanceId: 'instance:options', role: 'edit' });
    sendRequest = jest.spyOn(bridge, 'sendRequest').mockResolvedValue({ success: true });
    tools = new RobloxStudioTools(bridge);
  });
  afterEach(() => sendRequest.mockRestore());

  const properties = { Name: 'Renamed' };

  test.each([
    [{}, { instancePath: 'game.Workspace.Part', properties }],
    [{ atomic: true }, { instancePath: 'game.Workspace.Part', properties, atomic: true }],
    [{ atomic: false }, { instancePath: 'game.Workspace.Part', properties, atomic: false }],
    [{ atomic: true, dryRun: true }, { instancePath: 'game.Workspace.Part', properties, atomic: true, dryRun: true }],
  ])('forwards %j to Studio only when provided', async (options, payload) => {
    await TOOL_HANDLERS.set_properties(tools, { instancePath: 'game.Workspace.Part', properties, ...options });
    expect(sendRequest).toHaveBeenCalledTimes(1);
    // Exact equality: omitted options keep the original payload and operation fingerprint.
    expect(sendRequest.mock.calls[0][1]).toStrictEqual(payload);
  });

  test.each([
    [{ atomic: 'true' }, 'atomic must be a boolean'],
    [{ atomic: true, dryRun: 1 }, 'dryRun must be a boolean'],
    [{ dryRun: true }, 'dryRun requires atomic: true'],
    [{ atomic: false, dryRun: true }, 'dryRun requires atomic: true'],
  ])('rejects %j before dispatch', async (options, message) => {
    await expect(TOOL_HANDLERS.set_properties(tools, { instancePath: 'game.Workspace.Part', properties, ...options }))
      .rejects.toThrow(message);
    expect(sendRequest).not.toHaveBeenCalled();
  });
});
