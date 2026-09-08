import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { build, type Plugin } from 'esbuild';

type PeerRole = 'edit' | 'server' | 'client';

interface PluginSessionModule {
  peerId: string;
  getInstanceId(): string;
  getRole(): PeerRole;
  getMultiplayerGroupId(): string | undefined;
  getPlaceKey(): string;
  prepareSharedTopology(): string;
  prepareMultiplayerTopology(groupId: string): string;
  clearTopologyMarker(token: string): void;
  createReadyPayload(peerId: string, role: string): Record<string, unknown>;
}

interface StopPlayMonitorModule {
  init(plugin: { GetSetting(key: string): unknown; SetSetting(key: string, value: unknown): void }): void;
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

  constructor(private readonly className: string) {}
  IsA(className: string): boolean { return this.className === className; }
  get Parent(): CoreGuiStorage | undefined { return this.parent; }
  set Parent(parent: CoreGuiStorage | undefined) {
    this.parent?.children.delete(this.Name);
    this.parent = parent;
    parent?.children.set(this.Name, this);
  }
  Destroy(): void { this.Parent = undefined; }
}

interface DataModel {
  replicatedStorage: AttributeStorage;
  serverStorage: AttributeStorage;
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

let source: string;
let nextGuid = 1;

function loadVm(
  role: PeerRole = 'edit',
  model = dataModel(),
  coreGui = new CoreGuiStorage(),
  pluginSettings = new Map<string, unknown>(),
) {
  const clock = { wallClock: 100_000, uptime: 10 };
  const roleState = { current: role };
  const commonJsModule = { exports: {} };
  const context = vm.createContext({
    module: commonJsModule,
    identityRole: roleState,
    identityServices: {
      HttpService: {
        GenerateGUID: () => `${(nextGuid++).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
        JSONEncode: JSON.stringify,
      },
      ReplicatedStorage: model.replicatedStorage,
      ServerStorage: model.serverStorage,
      RunService: { IsRunning: () => roleState.current !== 'edit' },
    },
    game: { PlaceId: 0, Name: 'Same saved place', GetService: (name: string) => name === 'CoreGui' ? coreGui : {} },
    Instance: MockInstance,
    DateTime: { now: () => ({ UnixTimestampMillis: clock.wallClock }) },
    os: { clock: () => clock.uptime },
    tick: () => clock.wallClock / 1000,
    math: Math,
    tonumber: (value: string, radix: number) => Number.parseInt(value, radix),
    tostring: String,
    typeIs: (value: unknown, type: string) => typeof value === type,
    pcall: (callback: () => unknown): [boolean, unknown] => {
      try { return [true, callback()]; }
      catch (error) { return [false, error]; }
    },
  });
  vm.runInContext(`
    String.prototype.sub = function(first, last) { return this.slice(first - 1, last); };
    const nativeStringMatch = String.prototype.match;
    String.prototype.match = function(pattern) {
      return nativeStringMatch.call(this, new RegExp(pattern.replace(/%-/g, '-'))) || [];
    };
  `, context);
  vm.runInContext(source, context);
  // The bundled repository module owns this trusted export shape.
  const { session, stopMonitor } = commonJsModule.exports as SessionModules;
  stopMonitor.init({
    GetSetting: key => pluginSettings.get(key),
    SetSetting: (key, value) => { pluginSettings.set(key, value); },
  });
  return {
    session, stopMonitor, model, coreGui, clock, pluginSettings,
    setRole: (nextRole: PeerRole) => { roleState.current = nextRole; },
    ready: () => session.createReadyPayload(session.peerId, session.getRole()),
  };
}

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
  test('simultaneous edits of the same saved place stay distinct with identical clocks and persisted shared markers', () => {
    const saved = dataModel();
    saved.replicatedStorage.SetAttribute('__MCPTopologyMode', 'shared');
    saved.replicatedStorage.SetAttribute('__MCPTopologyInstanceId', 'instance:sav-000');
    saved.replicatedStorage.SetAttribute('__MCPTopologyToken', 'saved-token');
    saved.serverStorage.SetAttribute('__MCPPlaceId', 'same-anonymous-place');
    const edits = Array.from({ length: 64 }, () => loadVm('edit', cloneDataModel(saved)));
    const ids = edits.map(edit => edit.session.getInstanceId());

    expect(new Set(ids).size).toBe(edits.length);
    expect(ids).not.toContain('instance:sav-000');
    for (const [index, edit] of edits.entries()) {
      expect(ids[index]).toMatch(/^instance:[0-9a-z]{3}-[0-9a-z]{3}$/);
      expect(edit.ready()).toMatchObject({
        instanceId: ids[index], role: 'edit', placeKey: 'anon:same-anonymous-place',
      });
      expect(edit.session.peerId).toMatch(/^peer:[0-9a-z]{3}-[0-9a-z]{3}$/);
    }
  });

  test('a loaded edit retains its own identity across clock jumps and foreign shared markers', () => {
    const edit = loadVm();
    const instanceId = edit.session.getInstanceId();
    edit.clock.wallClock = 9_000_000;
    edit.clock.uptime = 500;
    expect(edit.ready().instanceId).toBe(instanceId);
    edit.clock.wallClock = 1;
    edit.clock.uptime = 600;
    edit.model.replicatedStorage.SetAttribute('__MCPTopologyMode', 'shared');
    edit.model.replicatedStorage.SetAttribute('__MCPTopologyInstanceId', 'instance:old-000');
    expect(edit.session.getInstanceId()).toBe(instanceId);
    expect(edit.ready().instanceId).toBe(instanceId);
  });

  test('a reopened edit replaces persisted multiplayer routing without changing anonymous place identity', () => {
    const original = loadVm();
    const placeKey = original.session.getPlaceKey();
    original.session.prepareMultiplayerTopology('saved-group');
    const reopened = loadVm('edit', cloneDataModel(original.model));

    expect(reopened.session.getInstanceId()).not.toBe(original.session.getInstanceId());
    expect(reopened.session.getMultiplayerGroupId()).toBeUndefined();
    expect(reopened.ready()).toMatchObject({ placeKey, multiplayerGroupId: undefined });
    const runtime = loadVm('server', cloneDataModel(reopened.model));
    expect(runtime.ready().instanceId).toBe(reopened.session.getInstanceId());
    expect(runtime.session.getMultiplayerGroupId()).toBeUndefined();
  });

  test('manual play VMs inherit their matching edit identity without explicit topology preparation', () => {
    const first = loadVm();
    const second = loadVm('edit', cloneDataModel(first.model));
    expect(second.session.getInstanceId()).not.toBe(first.session.getInstanceId());
    for (const edit of [first, second]) {
      for (const role of ['server', 'client'] as const) {
        const runtime = loadVm(role, cloneDataModel(edit.model));
        expect(runtime.session.getInstanceId()).toBe(edit.session.getInstanceId());
        expect(runtime.ready()).toMatchObject({ instanceId: edit.session.getInstanceId(), role });
      }
    }
  });

  test('runtime VMs without shared markers have distinct stable fallback identities', () => {
    const server = loadVm('server');
    const client = loadVm('client');
    const serverId = server.session.getInstanceId();
    const clientId = client.session.getInstanceId();
    expect(serverId).not.toBe(clientId);
    server.clock.wallClock = 1;
    client.clock.uptime = 1_000;
    expect(server.ready().instanceId).toBe(serverId);
    expect(client.ready().instanceId).toBe(clientId);
  });

  test('runtime teardown keeps inherited identity and stop settings scope when role and markers disappear', () => {
    const edit = loadVm();
    const instanceId = edit.session.getInstanceId();
    const runtime = loadVm('server', cloneDataModel(edit.model));
    expect(runtime.session.getInstanceId()).toBe(instanceId);
    expect(runtime.stopMonitor.requestStop().ok).toBe(true);
    const key = `MCP_STOP_PLAY_${instanceId}`;
    expect(runtime.pluginSettings.get(key)).toEqual(expect.any(String));

    runtime.setRole('edit');
    runtime.model.replicatedStorage.SetAttribute('__MCPTopologyMode', undefined);
    runtime.model.replicatedStorage.SetAttribute('__MCPTopologyInstanceId', undefined);
    expect(runtime.session.getInstanceId()).toBe(instanceId);
    expect(runtime.ready()).toMatchObject({ instanceId, role: 'edit' });
    runtime.stopMonitor.clearPending();
    expect(runtime.pluginSettings.get(key)).toBe(false);
    expect(runtime.pluginSettings.size).toBe(1);
  });

  test('edit module reload during shared play preserves the runtime stop channel and active marker token', () => {
    const edit = loadVm();
    const instanceId = edit.session.getInstanceId();
    const token = edit.session.prepareSharedTopology();
    const runtime = loadVm('server', cloneDataModel(edit.model), new CoreGuiStorage(), edit.pluginSettings);
    const reloaded = loadVm('edit', edit.model, edit.coreGui, edit.pluginSettings);
    expect(reloaded.ready().instanceId).toBe(instanceId);
    expect(runtime.ready().instanceId).toBe(instanceId);
    expect(edit.model.replicatedStorage.GetAttribute('__MCPTopologyToken')).toBe(token);

    expect(reloaded.stopMonitor.requestStop().ok).toBe(true);
    runtime.stopMonitor.clearPending();
    expect(edit.pluginSettings.get(`MCP_STOP_PLAY_${instanceId}`)).toBe(false);
    expect(edit.pluginSettings.size).toBe(1);
    edit.session.clearTopologyMarker(token);
    expect(loadVm('server', cloneDataModel(edit.model)).ready().instanceId).toBe(instanceId);
  });

  test('edit module reload preserves an active multiplayer override until its original token clears it', () => {
    const edit = loadVm();
    const instanceId = edit.session.getInstanceId();
    const token = edit.session.prepareMultiplayerTopology('active-group');
    const reloaded = loadVm('edit', edit.model, edit.coreGui);
    expect(reloaded.ready()).toMatchObject({ instanceId, multiplayerGroupId: 'active-group' });
    expect(loadVm('server', cloneDataModel(edit.model)).ready().multiplayerGroupId).toBe('active-group');
    reloaded.session.clearTopologyMarker(token);
    expect(loadVm('server', cloneDataModel(edit.model)).ready()).toMatchObject({
      instanceId, multiplayerGroupId: undefined,
    });
  });

  test('edit module reload restores missing baseline markers without reallocating its identity', () => {
    const edit = loadVm();
    edit.model.replicatedStorage.SetAttribute('__MCPTopologyMode', undefined);
    edit.model.replicatedStorage.SetAttribute('__MCPTopologyInstanceId', undefined);
    const reloaded = loadVm('edit', edit.model, edit.coreGui);
    expect(reloaded.session.getInstanceId()).toBe(edit.session.getInstanceId());
    expect(loadVm('server', cloneDataModel(reloaded.model)).ready().instanceId).toBe(edit.session.getInstanceId());
  });

  test.each([
    { className: 'Folder', value: 'instance:old-000', archivable: false },
    { className: 'StringValue', value: '', archivable: false },
    { className: 'StringValue', value: 'invalid-identity', archivable: false },
    { className: 'StringValue', value: 'instance:old-000', archivable: true },
  ])('rejects invalid CoreGui identity storage: $className / $value / archivable=$archivable', ({ className, value, archivable }) => {
    const coreGui = new CoreGuiStorage();
    const invalid = new MockInstance(className);
    invalid.Name = '__MCPSessionIdentity';
    invalid.Value = value;
    invalid.Archivable = archivable;
    invalid.Parent = coreGui;
    const edit = loadVm('edit', dataModel(), coreGui);
    const instanceId = edit.session.getInstanceId();
    expect(instanceId).not.toBe(value);
    expect(instanceId).toMatch(/^instance:[0-9a-z]{3}-[0-9a-z]{3}$/);
    expect(loadVm('edit', edit.model, coreGui).session.getInstanceId()).toBe(instanceId);
  });

  test('an edit keeps ownership when its reported role changes during play', () => {
    const edit = loadVm();
    const instanceId = edit.session.getInstanceId();
    edit.setRole('server');
    edit.model.replicatedStorage.SetAttribute('__MCPTopologyInstanceId', 'instance:old-000');
    expect(edit.ready()).toMatchObject({ instanceId, role: 'server' });
    const token = edit.session.prepareMultiplayerTopology('active-group');
    edit.session.clearTopologyMarker(token);
    expect(loadVm('server', cloneDataModel(edit.model)).ready()).toMatchObject({
      instanceId, multiplayerGroupId: undefined,
    });
  });

  test('multiplayer override survives stale cleanup and clearing it restores manual-play sharing', () => {
    const edit = loadVm();
    const instanceId = edit.session.getInstanceId();
    const staleToken = edit.session.prepareMultiplayerTopology('older-group');
    const activeToken = edit.session.prepareMultiplayerTopology('active-group');
    edit.session.clearTopologyMarker(staleToken);
    const server = loadVm('server', cloneDataModel(edit.model));
    const client = loadVm('client', cloneDataModel(edit.model));

    expect(edit.ready()).toMatchObject({ instanceId, multiplayerGroupId: 'active-group' });
    expect(server.session.getInstanceId()).not.toBe(instanceId);
    expect(client.session.getInstanceId()).not.toBe(instanceId);
    expect(server.session.getInstanceId()).not.toBe(client.session.getInstanceId());
    expect(server.ready().multiplayerGroupId).toBe('active-group');
    expect(client.ready().multiplayerGroupId).toBe('active-group');

    edit.session.clearTopologyMarker(activeToken);
    expect(edit.ready()).toMatchObject({ instanceId, multiplayerGroupId: undefined });
    const manualPlay = loadVm('server', cloneDataModel(edit.model));
    expect(manualPlay.ready()).toMatchObject({ instanceId, multiplayerGroupId: undefined });
    expect(server.ready().multiplayerGroupId).toBe('active-group');

    const laterToken = edit.session.prepareMultiplayerTopology('later-group');
    edit.session.clearTopologyMarker(activeToken);
    expect(loadVm('server', cloneDataModel(edit.model)).ready().multiplayerGroupId).toBe('later-group');
    edit.session.clearTopologyMarker(laterToken);
    expect(loadVm('server', cloneDataModel(edit.model)).ready().instanceId).toBe(instanceId);
  });

  test('shared play cleanup leaves a baseline for subsequent direct manual play', () => {
    const edit = loadVm();
    const instanceId = edit.session.getInstanceId();
    const token = edit.session.prepareSharedTopology();
    expect(loadVm('server', cloneDataModel(edit.model)).ready().instanceId).toBe(instanceId);
    edit.session.clearTopologyMarker(token);
    expect(loadVm('server', cloneDataModel(edit.model)).ready().instanceId).toBe(instanceId);
  });
});
