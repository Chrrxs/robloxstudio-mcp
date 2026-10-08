import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { build, type Plugin } from 'esbuild';

type PeerRole = 'edit' | 'server' | 'client';

interface SettingsStore {
  GetSetting(key: string): unknown;
  SetSetting(key: string, value: unknown): void;
}

interface PreparedSoloTest {
  token: string;
  testArgs: unknown;
}

interface PluginSessionModule {
  peerId: string;
  init(store: SettingsStore, options: { getServerUrl: () => string | undefined }): void;
  resolveRuntimeTopology(): void;
  getInstanceId(): string;
  getRole(): PeerRole;
  getMultiplayerGroupId(): string | undefined;
  getPlaceKey(): string;
  getLegacyPlaceKey(): string | undefined;
  getInheritedServerUrl(): string | undefined;
  prepareSoloTest(): PreparedSoloTest;
  prepareMultiplayerTest(groupId: string): string;
  finishTest(token: string): void;
  createReadyPayload(peerId: string, role: string): Record<string, unknown>;
}

interface StopPlayMonitorModule {
  init(plugin: SettingsStore): void;
  requestStop(): { ok: boolean; requestId?: string };
  clearPending(requestId?: string): void;
}

interface SessionModules {
  session: PluginSessionModule;
  stopMonitor: StopPlayMonitorModule;
}

class AttributeStorage {
  constructor(private readonly attributes = new Map<string, unknown>()) {}

  GetAttribute(name: string): unknown { return this.attributes.get(name); }
  SetAttribute(name: string, value: unknown): void {
    if (value === undefined) this.attributes.delete(name);
    else this.attributes.set(name, value);
  }
  names(): string[] { return [...this.attributes.keys()]; }
  clone(): AttributeStorage { return new AttributeStorage(new Map(this.attributes)); }
}

class CoreGuiStorage {
  readonly children = new Map<string, MockInstance>();
  FindFirstChild(name: string): MockInstance | undefined { return this.children.get(name); }
}

class MockInstance {
  Name = '';
  Value = '';
  Archivable = true;
  private parent?: CoreGuiStorage;
  private readonly attributes = new Map<string, unknown>();

  constructor(private readonly className: string) {}
  IsA(className: string): boolean { return this.className === className; }
  GetAttribute(name: string): unknown { return this.attributes.get(name); }
  SetAttribute(name: string, value: unknown): void {
    if (value === undefined) this.attributes.delete(name);
    else this.attributes.set(name, value);
  }
  get Parent(): CoreGuiStorage | undefined { return this.parent; }
  set Parent(parent: CoreGuiStorage | undefined) {
    this.parent?.children.delete(this.Name);
    this.parent = parent;
    parent?.children.set(this.Name, this);
  }
  Destroy(): void { this.Parent = undefined; }
}

class Signal {
  private readonly listeners = new Set<() => void>();

  Connect(listener: () => void): { Disconnect(): void } {
    this.listeners.add(listener);
    return { Disconnect: () => { this.listeners.delete(listener); } };
  }
  fire(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** Fake time shared by every Studio VM on one machine; drives task.wait and task.delay. */
class Scheduler {
  seconds = 0;
  private sequence = 0;
  private timers: Array<{ at: number; sequence: number; callback: () => void }> = [];

  delay(seconds: number, callback: () => void): void {
    this.timers.push({ at: this.seconds + seconds, sequence: this.sequence++, callback });
  }

  advance(seconds: number): void {
    const target = this.seconds + seconds;
    for (;;) {
      this.timers.sort((left, right) => left.at - right.at || left.sequence - right.sequence);
      const next = this.timers[0];
      if (next === undefined || next.at > target) break;
      this.timers.shift();
      this.seconds = next.at;
      next.callback();
    }
    this.seconds = target;
  }
}

/** Plugin settings are one JSON store shared by every Studio window of the same plugin. */
class PluginSettings implements SettingsStore {
  private readonly values = new Map<string, string>();

  GetSetting(key: string): unknown {
    const value = this.values.get(key);
    return value === undefined ? undefined : JSON.parse(value);
  }
  SetSetting(key: string, value: unknown): void {
    if (value === undefined || value === null) this.values.delete(key);
    else this.values.set(key, JSON.stringify(value));
  }
  snapshot(): Record<string, string> { return Object.fromEntries(this.values); }
}

interface DataModel {
  replicatedStorage: AttributeStorage;
  serverStorage: AttributeStorage;
}

interface Place {
  placeId: number;
  name: string;
}

function dataModel(): DataModel {
  return { replicatedStorage: new AttributeStorage(), serverStorage: new AttributeStorage() };
}

function cloneDataModel(model: DataModel): DataModel {
  return {
    replicatedStorage: model.replicatedStorage.clone(),
    serverStorage: model.serverStorage.clone(),
  };
}

function mcpAttributes(model: DataModel): string[] {
  return [...model.replicatedStorage.names(), ...model.serverStorage.names()]
    .filter((name) => name.startsWith('__MCP'));
}

/** One DataModel in one Studio window: survives plugin reloads, and its CoreGui is never saved or copied. */
class StudioDataModel {
  readonly coreGui = new CoreGuiStorage();
  readonly editModeChanged = new Signal();
  editModeActive: boolean;

  constructor(
    readonly role: PeerRole,
    readonly place: Place,
    readonly model: DataModel,
    readonly testArgs?: unknown,
  ) {
    this.editModeActive = role === 'edit';
  }

  setEditModeActive(active: boolean): void {
    if (this.editModeActive === active) return;
    this.editModeActive = active;
    this.editModeChanged.fire();
  }
}

const DEFAULT_PLACE: Place = { placeId: 0, name: 'Same saved place' };
const EDIT_SERVER_URL = 'http://127.0.0.1:58741';

const dependencies: Plugin = {
  name: 'studio-session-identity-dependencies',
  setup(builder) {
    builder.onResolve({ filter: /^@rbxts\/services$/ }, () => ({ path: 'services', namespace: 'identity' }));
    builder.onResolve({ filter: /^\.\/(State|PeerRole)$/ }, (args) => ({ path: args.path, namespace: 'identity' }));
    builder.onLoad({ filter: /.*/, namespace: 'identity' }, (args) => {
      if (args.path === 'services') return { contents: 'module.exports = globalThis.identityServices;', loader: 'js' };
      if (args.path === './PeerRole') {
        return { contents: 'export default { detect: () => globalThis.identityRole.current };', loader: 'js' };
      }
      return { contents: 'export default { CURRENT_VERSION: "test", PLUGIN_VARIANT: "test" };', loader: 'js' };
    });
  },
};

const LUAU_STRING_SHIMS = `
  String.prototype.sub = function(first, last) { return this.slice(first - 1, last); };
  const nativeStringMatch = String.prototype.match;
  String.prototype.match = function(pattern) {
    return nativeStringMatch.call(this, new RegExp(pattern.replace(/%-/g, '-'))) || [];
  };
`;

function luauTypeIs(value: unknown, type: string): boolean {
  if (type === 'table') return typeof value === 'object' && value !== null;
  if (type === 'nil') return value === undefined || value === null;
  return typeof value === type;
}

function robloxPcall(callback: (...args: unknown[]) => unknown, ...args: unknown[]): [boolean, unknown] {
  try { return [true, callback(...args)]; }
  catch (error) { return [false, error]; }
}

let source: string;
let nextGuid = 1;

/** One machine: Studio windows share plugin settings and wall time. */
class Studio {
  readonly scheduler = new Scheduler();
  readonly settings = new PluginSettings();
  private readonly wallBaseMs = 1_800_000_000_000;

  openPlace(place: Place = DEFAULT_PLACE, saved: DataModel = dataModel()): StudioVm {
    return this.load(new StudioDataModel('edit', place, saved));
  }

  /** Studio copies the edit place into a new runtime DataModel; only saveable state crosses. */
  loadRuntime(
    edit: StudioVm,
    options: { role?: 'server' | 'client'; testArgs?: unknown; resolve?: boolean } = {},
  ): StudioVm {
    const runtime = new StudioDataModel(
      options.role ?? 'server',
      edit.dataModel.place,
      cloneDataModel(edit.dataModel.model),
      options.testArgs,
    );
    return this.load(runtime, { resolve: options.resolve });
  }

  after(seconds: number, action: () => void): void {
    this.scheduler.delay(seconds, action);
  }

  load(dataModel: StudioDataModel, options: { resolve?: boolean } = {}) {
    const roleState = { current: dataModel.role };
    const clock = { wallOffsetMs: 0 };
    let alive = true;
    const scheduler = this.scheduler;
    const wallMs = () => this.wallBaseMs + Math.round(scheduler.seconds * 1000) + clock.wallOffsetMs;
    const studioTestService = {
      get EditModeActive() { return dataModel.editModeActive; },
      GetPropertyChangedSignal: (property: string) => {
        if (property !== 'EditModeActive') throw new Error(`Unexpected property signal ${property}`);
        return {
          Connect: (listener: () => void) => dataModel.editModeChanged.Connect(() => { if (alive) listener(); }),
        };
      },
      GetTestArgs: () => dataModel.testArgs,
    };
    const commonJsModule = { exports: {} };
    const context = vm.createContext({
      module: commonJsModule,
      identityRole: roleState,
      identityServices: {
        HttpService: {
          GenerateGUID: () => `${(nextGuid++).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
          JSONEncode: JSON.stringify,
          JSONDecode: JSON.parse,
        },
        ReplicatedStorage: dataModel.model.replicatedStorage,
        ServerStorage: dataModel.model.serverStorage,
        RunService: {
          IsRunning: () => roleState.current !== 'edit',
          IsServer: () => roleState.current === 'server',
        },
      },
      game: {
        PlaceId: dataModel.place.placeId,
        Name: dataModel.place.name,
        GetService: (name: string) => {
          if (name === 'CoreGui') return dataModel.coreGui;
          if (name === 'StudioTestService') return studioTestService;
          return {};
        },
      },
      Instance: MockInstance,
      DateTime: { now: () => ({ UnixTimestampMillis: wallMs() }) },
      os: { clock: () => scheduler.seconds },
      tick: () => wallMs() / 1000,
      task: {
        wait: (seconds = 1 / 60) => { scheduler.advance(seconds); return seconds; },
        delay: (seconds: number, callback: (...args: unknown[]) => void, ...args: unknown[]) => {
          scheduler.delay(seconds, () => { if (alive) callback(...args); });
        },
        spawn: (callback: (...args: unknown[]) => void, ...args: unknown[]) => { callback(...args); },
      },
      math: Math,
      tonumber: (value: string, radix: number) => Number.parseInt(value, radix),
      tostring: String,
      typeIs: luauTypeIs,
      pcall: robloxPcall,
      warn: () => undefined,
    });
    vm.runInContext(LUAU_STRING_SHIMS, context);
    vm.runInContext(source, context);
    // The bundled repository module owns this trusted export shape.
    const { session, stopMonitor } = commonJsModule.exports as SessionModules;
    session.init(this.settings, { getServerUrl: () => EDIT_SERVER_URL });
    stopMonitor.init(this.settings);
    if (options.resolve ?? dataModel.role === 'server') session.resolveRuntimeTopology();
    return {
      session, stopMonitor, dataModel, clock,
      model: dataModel.model,
      setRole: (nextRole: PeerRole) => { roleState.current = nextRole; },
      ready: () => session.createReadyPayload(session.peerId, session.getRole()),
      beginPlay: () => dataModel.setEditModeActive(false),
      endPlay: () => dataModel.setEditModeActive(true),
      unload: () => { alive = false; },
    };
  }
}

type StudioVm = ReturnType<Studio['load']>;

beforeAll(async () => {
  const root = fs.existsSync(path.join(process.cwd(), 'studio-plugin')) ? process.cwd() : path.resolve(process.cwd(), '../..');
  const result = await build({
    stdin: {
      contents: 'import PluginSession from "./PluginSession"; import StopPlayMonitor from "./StopPlayMonitor"; export = { session: PluginSession, stopMonitor: StopPlayMonitor };',
      resolveDir: path.join(root, 'studio-plugin/src/modules'), loader: 'ts',
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', plugins: [dependencies],
  });
  source = result.outputFiles[0].text;
});

describe('Studio edit-session identity', () => {
  test('an edit removes saved MCP attributes without touching user attributes or adopting saved identity', () => {
    const studio = new Studio();
    const saved = dataModel();
    saved.replicatedStorage.SetAttribute('__MCPTopologyMode', 'shared');
    saved.replicatedStorage.SetAttribute('__MCPTopologyInstanceId', 'instance:sav-000');
    saved.replicatedStorage.SetAttribute('__MCPTopologyGroupId', 'saved-group');
    saved.replicatedStorage.SetAttribute('__MCPTopologyToken', 'saved-token');
    saved.replicatedStorage.SetAttribute('GameVersion', 7);
    saved.serverStorage.SetAttribute('__MCPPlaceId', 'legacy-place');

    const edit = studio.openPlace(DEFAULT_PLACE, saved);

    expect(mcpAttributes(edit.model)).toEqual([]);
    expect(edit.model.replicatedStorage.GetAttribute('GameVersion')).toBe(7);
    expect(edit.session.getInstanceId()).not.toBe('instance:sav-000');
    expect(edit.ready()).toMatchObject({ multiplayerGroupId: undefined });
    expect(edit.session.getLegacyPlaceKey()).toBe('anon:legacy-place');
  });

  test('simultaneous edits of the same saved place stay distinct with identical clocks', () => {
    const studio = new Studio();
    const edits = Array.from({ length: 64 }, () => studio.openPlace());
    const ids = edits.map((edit) => edit.session.getInstanceId());

    expect(new Set(ids).size).toBe(edits.length);
    for (const [index, edit] of edits.entries()) {
      expect(ids[index]).toMatch(/^instance:[0-9a-z]{3}-[0-9a-z]{3}$/);
      expect(edit.ready()).toMatchObject({ instanceId: ids[index], role: 'edit' });
      expect(edit.session.peerId).toMatch(/^peer:[0-9a-z]{3}-[0-9a-z]{3}$/);
    }
  });

  test('a loaded edit retains its own identity across clock jumps', () => {
    const edit = new Studio().openPlace();
    const instanceId = edit.session.getInstanceId();
    edit.clock.wallOffsetMs = 9_000_000;
    expect(edit.ready().instanceId).toBe(instanceId);
    edit.clock.wallOffsetMs = -9_000_000;
    expect(edit.ready().instanceId).toBe(instanceId);
  });

  test.each([
    { className: 'Folder', value: 'instance:old-000', archivable: false },
    { className: 'StringValue', value: '', archivable: false },
    { className: 'StringValue', value: 'invalid-identity', archivable: false },
    { className: 'StringValue', value: 'instance:old-000', archivable: true },
  ])('rejects invalid CoreGui identity storage: $className / $value / archivable=$archivable', ({ className, value, archivable }) => {
    const studio = new Studio();
    const window = new StudioDataModel('edit', DEFAULT_PLACE, dataModel());
    const invalid = new MockInstance(className);
    invalid.Name = '__MCPSessionIdentity';
    invalid.Value = value;
    invalid.Archivable = archivable;
    invalid.Parent = window.coreGui;
    const edit = studio.load(window);
    const instanceId = edit.session.getInstanceId();
    expect(instanceId).not.toBe(value);
    expect(instanceId).toMatch(/^instance:[0-9a-z]{3}-[0-9a-z]{3}$/);
    edit.unload();
    expect(studio.load(window).session.getInstanceId()).toBe(instanceId);
  });
});

describe('Playtest topology handoff without DataModel state', () => {
  test('a Play-button server inherits its edit instance, place key and server URL', () => {
    const studio = new Studio();
    const edit = studio.openPlace();

    edit.beginPlay();
    const server = studio.loadRuntime(edit);

    expect(server.ready()).toMatchObject({
      instanceId: edit.session.getInstanceId(),
      role: 'server',
      placeKey: edit.session.getPlaceKey(),
      multiplayerGroupId: undefined,
    });
    expect(server.session.getInheritedServerUrl()).toBe(EDIT_SERVER_URL);
    expect(mcpAttributes(edit.model)).toEqual([]);
    expect(mcpAttributes(server.model)).toEqual([]);
  });

  test('a server that loads before its edit observes Play still inherits the edit instance', () => {
    const studio = new Studio();
    const edit = studio.openPlace();
    studio.after(2, () => edit.beginPlay());

    const server = studio.loadRuntime(edit);

    expect(server.ready().instanceId).toBe(edit.session.getInstanceId());
  });

  test('a Play-button server shares the edit stop channel, even after its role changes during teardown', () => {
    const studio = new Studio();
    const edit = studio.openPlace();
    const instanceId = edit.session.getInstanceId();
    edit.beginPlay();
    const server = studio.loadRuntime(edit);

    expect(edit.stopMonitor.requestStop().ok).toBe(true);
    const key = `MCP_STOP_PLAY_${instanceId}`;
    expect(studio.settings.GetSetting(key)).toEqual(expect.any(String));

    server.setRole('edit');
    expect(server.session.getInstanceId()).toBe(instanceId);
    server.stopMonitor.clearPending();
    expect(studio.settings.GetSetting(key)).toBe(false);
  });

  test('a finished Play leaves plugin settings as it found them', () => {
    const studio = new Studio();
    const edit = studio.openPlace();
    const before = studio.settings.snapshot();

    edit.beginPlay();
    studio.loadRuntime(edit);
    studio.scheduler.advance(3);
    edit.endPlay();

    expect(studio.settings.snapshot()).toEqual(before);
  });

  test('an MCP-started solo playtest hands over its topology through test args without posting a ticket', () => {
    const studio = new Studio();
    const edit = studio.openPlace();
    const instanceId = edit.session.getInstanceId();
    const before = studio.settings.snapshot();

    const prepared = edit.session.prepareSoloTest();
    edit.beginPlay();
    expect(studio.settings.snapshot()).toEqual(before);

    const loadStartedAt = studio.scheduler.seconds;
    const server = studio.loadRuntime(edit, { testArgs: prepared.testArgs });
    expect(studio.scheduler.seconds).toBe(loadStartedAt);
    expect(server.ready()).toMatchObject({ instanceId, placeKey: edit.session.getPlaceKey() });
    expect(server.session.getInheritedServerUrl()).toBe(EDIT_SERVER_URL);

    edit.endPlay();
    edit.session.finishTest(prepared.token);
    edit.beginPlay();
    expect(studio.loadRuntime(edit).ready().instanceId).toBe(instanceId);
    expect(mcpAttributes(edit.model)).toEqual([]);
  });

  test('two windows of the same place starting Play together leave both servers on their own identities', () => {
    const studio = new Studio();
    const first = studio.openPlace();
    const second = studio.openPlace();
    const editIds = [first.session.getInstanceId(), second.session.getInstanceId()];

    first.beginPlay();
    second.beginPlay();
    const servers = [studio.loadRuntime(first), studio.loadRuntime(second)];

    for (const server of servers) expect(editIds).not.toContain(server.session.getInstanceId());
    expect(servers[0].session.getInstanceId()).not.toBe(servers[1].session.getInstanceId());
  });

  test('a claimed ticket does not block a later Play in another window of the same place', () => {
    const studio = new Studio();
    const first = studio.openPlace();
    const second = studio.openPlace();

    first.beginPlay();
    const firstServer = studio.loadRuntime(first);
    second.beginPlay();
    const secondServer = studio.loadRuntime(second);

    expect(firstServer.session.getInstanceId()).toBe(first.session.getInstanceId());
    expect(secondServer.session.getInstanceId()).toBe(second.session.getInstanceId());
  });

  test('different places playing at the same time each inherit their own edit', () => {
    const studio = new Studio();
    const edits = [
      studio.openPlace({ placeId: 0, name: 'Alpha.rbxl' }),
      studio.openPlace({ placeId: 0, name: 'Beta.rbxl' }),
      studio.openPlace({ placeId: 42, name: 'Gamma' }),
    ];

    for (const edit of edits) edit.beginPlay();
    const servers = edits.map((edit) => studio.loadRuntime(edit));

    for (const [index, server] of servers.entries()) {
      expect(server.ready()).toMatchObject({
        instanceId: edits[index].session.getInstanceId(),
        placeKey: edits[index].session.getPlaceKey(),
      });
    }
    expect(servers.map((server) => server.ready().placeKey)).toEqual(['name:Alpha.rbxl', 'name:Beta.rbxl', 'place:42']);
  });

  test('playtest clients never claim the ticket meant for their server', () => {
    const studio = new Studio();
    const edit = studio.openPlace();
    edit.beginPlay();

    const client = studio.loadRuntime(edit, { role: 'client', resolve: true });
    const server = studio.loadRuntime(edit);

    expect(server.session.getInstanceId()).toBe(edit.session.getInstanceId());
    expect(client.session.getInstanceId()).not.toBe(edit.session.getInstanceId());
  });

  test('servers without an edit ticket keep distinct, stable identities of their own', () => {
    const studio = new Studio();
    const edit = studio.openPlace();

    const servers = [studio.loadRuntime(edit), studio.loadRuntime(edit)];
    const ids = servers.map((server) => server.session.getInstanceId());

    expect(new Set([edit.session.getInstanceId(), ...ids]).size).toBe(3);
    servers[0].clock.wallOffsetMs = 9_000_000;
    expect(servers.map((server) => server.ready().instanceId)).toEqual(ids);
  });

  test('an MCP playtest that never started does not stop a later Play-button run from posting its ticket', () => {
    const studio = new Studio();
    const edit = studio.openPlace();

    edit.session.prepareSoloTest();
    studio.scheduler.advance(60);
    edit.beginPlay();

    expect(studio.loadRuntime(edit).session.getInstanceId()).toBe(edit.session.getInstanceId());
  });

  test('an MCP multiplayer test gives its server the group through a ticket and the edit reports it until finished', () => {
    const studio = new Studio();
    const edit = studio.openPlace();
    const instanceId = edit.session.getInstanceId();

    const token = edit.session.prepareMultiplayerTest('active-group');
    expect(edit.ready()).toMatchObject({ instanceId, multiplayerGroupId: 'active-group' });
    edit.beginPlay();
    const server = studio.loadRuntime(edit, { testArgs: { lobby: 'user-owned test args' } });

    expect(server.ready().multiplayerGroupId).toBe('active-group');
    expect(server.session.getInstanceId()).not.toBe(instanceId);
    expect(mcpAttributes(edit.model)).toEqual([]);

    edit.endPlay();
    edit.session.finishTest(token);
    expect(edit.ready()).toMatchObject({ instanceId, multiplayerGroupId: undefined });
    edit.beginPlay();
    expect(studio.loadRuntime(edit).ready()).toMatchObject({ instanceId, multiplayerGroupId: undefined });
  });

  test('a stale multiplayer token cannot finish a newer test', () => {
    const studio = new Studio();
    const edit = studio.openPlace();

    const staleToken = edit.session.prepareMultiplayerTest('older-group');
    edit.session.prepareMultiplayerTest('active-group');
    edit.session.finishTest(staleToken);
    edit.beginPlay();

    expect(edit.ready().multiplayerGroupId).toBe('active-group');
    expect(studio.loadRuntime(edit).ready().multiplayerGroupId).toBe('active-group');
  });
});

describe('Plugin reloads during a playtest', () => {
  test('a reloaded edit plugin keeps posting its ticket, shares its stop channel and cleans up when Play ends', () => {
    const studio = new Studio();
    const edit = studio.openPlace();
    const instanceId = edit.session.getInstanceId();
    const before = studio.settings.snapshot();

    edit.beginPlay();
    edit.unload();
    const reloaded = studio.load(edit.dataModel);
    studio.scheduler.advance(10);
    const server = studio.loadRuntime(reloaded);

    expect(reloaded.session.getInstanceId()).toBe(instanceId);
    expect(server.session.getInstanceId()).toBe(instanceId);
    expect(reloaded.stopMonitor.requestStop().ok).toBe(true);
    server.stopMonitor.clearPending();
    expect(studio.settings.GetSetting(`MCP_STOP_PLAY_${instanceId}`)).toBe(false);
    studio.settings.SetSetting(`MCP_STOP_PLAY_${instanceId}`, undefined);

    reloaded.endPlay();
    expect(studio.settings.snapshot()).toEqual(before);
  });

  test('a reloaded edit plugin keeps an active multiplayer group until its original token finishes it', () => {
    const studio = new Studio();
    const edit = studio.openPlace();
    const instanceId = edit.session.getInstanceId();

    const token = edit.session.prepareMultiplayerTest('active-group');
    edit.unload();
    const reloaded = studio.load(edit.dataModel);
    expect(reloaded.ready()).toMatchObject({ instanceId, multiplayerGroupId: 'active-group' });

    reloaded.beginPlay();
    studio.scheduler.advance(10);
    expect(studio.loadRuntime(reloaded).ready().multiplayerGroupId).toBe('active-group');

    reloaded.endPlay();
    reloaded.session.finishTest(token);
    expect(reloaded.ready()).toMatchObject({ instanceId, multiplayerGroupId: undefined });
  });

  test('a Play that ends while the edit plugin is reloading is cleaned up when it loads', () => {
    const studio = new Studio();
    const edit = studio.openPlace();
    const before = studio.settings.snapshot();

    edit.beginPlay();
    studio.loadRuntime(edit);
    edit.unload();
    edit.dataModel.setEditModeActive(true);
    studio.load(edit.dataModel);

    expect(studio.settings.snapshot()).toEqual(before);
  });

  test('a reloaded server plugin keeps its inherited identity without waiting for a ticket', () => {
    const studio = new Studio();
    const edit = studio.openPlace();
    edit.beginPlay();
    const server = studio.loadRuntime(edit);

    server.unload();
    const reloadStartedAt = studio.scheduler.seconds;
    const reloaded = studio.load(server.dataModel);

    expect(studio.scheduler.seconds).toBe(reloadStartedAt);
    expect(reloaded.ready()).toMatchObject({
      instanceId: edit.session.getInstanceId(),
      placeKey: edit.session.getPlaceKey(),
    });
  });
});
