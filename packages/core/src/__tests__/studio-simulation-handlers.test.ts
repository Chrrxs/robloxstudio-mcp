import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const PLUGIN_SRC = resolve(__dirname, '../../../../studio-plugin/src');

const vector2 = (x: number, y: number) => ({ __type: 'Vector2' as const, X: x, Y: y });
const enumItem = (name: string) => ({ __type: 'EnumItem' as const, Name: name });

function robloxType(value: unknown): unknown {
  return value !== null && typeof value === 'object' && '__type' in value ? value.__type : undefined;
}

interface SimulationHandlers {
  getNetworkSimulationState(): unknown;
  getDeviceSimulatorState(data: Record<string, unknown>): unknown;
}

// Runs the actual handler with only Roblox services/globals replaced.
function loadHandlers(services: { networkSettings?: () => unknown; simulator?: () => unknown }): SimulationHandlers {
  const source = readFileSync(resolve(PLUGIN_SRC, 'modules/handlers/SimulationHandlers.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module: { exports: unknown } = { exports: {} };
  const fail = (name: string) => () => { throw new Error(`${name} is not a valid Service name`); };
  runInNewContext(compiled.outputText, {
    module,
    exports: module.exports,
    pairs: Object.entries,
    typeIs: (value: unknown, kind: string) => {
      if (kind === 'Vector2' || kind === 'EnumItem') return robloxType(value) === kind;
      if (kind === 'table') return typeof value === 'object' && value !== null && robloxType(value) === undefined;
      return typeof value === kind;
    },
    tostring: (value: unknown) => value === undefined ? 'nil' : String(value),
    pcall: (callback: () => unknown) => {
      try { return [true, callback()]; } catch (error) { return [false, error instanceof Error ? error.message : String(error)]; }
    },
    settings: () => ({
      GetService: (name: string) => name === 'NetworkSettings' ? (services.networkSettings ?? fail(name))() : fail(name)(),
    }),
    game: {
      GetService: (name: string) => name === 'StudioDeviceSimulatorService' ? (services.simulator ?? fail(name))() : fail(name)(),
    },
  });
  return module.exports as SimulationHandlers;
}

const NETWORK_STATE = {
  InboundNetworkMinDelayMs: 50,
  OutboundNetworkMinDelayMs: 50,
  InboundNetworkJitterMs: 10,
  OutboundNetworkJitterMs: 10,
  InboundNetworkLossPercent: 0,
  OutboundNetworkLossPercent: 0,
};

const DEVICE_INFO: Record<string, Record<string, unknown>> = {
  iphone_XR: { DeviceId: 'iphone_XR', Name: 'iPhone XR', Resolution: vector2(828, 1792) },
  ipad: { Name: 'iPad' },
  custom_phone: { DeviceId: 'custom_phone', IsCustom: true },
};

function simulator(overrides: Record<string, () => unknown> = {}, activeDevice = 'iphone_XR') {
  return {
    GetDeviceAsync: () => activeDevice,
    GetDeviceListAsync: () => [{ DeviceId: 'iphone_XR' }, 'ipad', { DeviceId: 'custom_phone' }],
    GetDeviceInfoAsync: (deviceId: string) => {
      if (!DEVICE_INFO[deviceId]) throw new Error(`Unknown device ${deviceId}`);
      return DEVICE_INFO[deviceId];
    },
    GetResolutionAsync: () => vector2(828, 1792),
    GetPixelDensityAsync: () => 2,
    GetOrientationAsync: () => enumItem('Portrait'),
    GetScalingModeAsync: () => enumItem('ActualSize'),
    ...overrides,
  };
}

describe('Studio simulation read handlers', () => {
  test('reads every network simulation setting', () => {
    const handlers = loadHandlers({ networkSettings: () => ({ ...NETWORK_STATE, Unrelated: 1 }) });
    expect(handlers.getNetworkSimulationState()).toEqual({ success: true, state: NETWORK_STATE });
  });

  test.each([
    ['the service is missing', { networkSettings: undefined }],
    ['a setting is missing', {
      networkSettings: () => ({
        ...NETWORK_STATE,
        get InboundNetworkLossPercent(): number { throw new Error('InboundNetworkLossPercent is not a valid member'); },
      }),
    }],
  ])('reports service_unavailable when %s', (_label, services) => {
    expect(loadHandlers(services).getNetworkSimulationState()).toEqual({
      success: false,
      error: 'service_unavailable',
      service: 'NetworkSettings',
      message: expect.stringContaining('NetworkSettings is unavailable in this DataModel'),
    });
  });

  test('reads the device simulator state with built-in devices only', () => {
    const handlers = loadHandlers({ simulator: () => simulator() });
    expect(handlers.getDeviceSimulatorState({ deviceId: 'ipad' })).toEqual({
      activeDeviceId: 'iphone_XR',
      isSimulating: true,
      devices: [
        { DeviceId: 'iphone_XR', Name: 'iPhone XR', Resolution: { x: 828, y: 1792, width: 828, height: 1792 } },
        { DeviceId: 'ipad', Name: 'iPad' },
      ],
      deviceInfo: { Name: 'iPad' },
      resolution: { x: 828, y: 1792, width: 828, height: 1792 },
      pixelDensity: 2,
      orientation: 'Portrait',
      scalingMode: 'ActualSize',
    });
  });

  test('omits the device list on request and reports unavailable active getters', () => {
    const handlers = loadHandlers({
      simulator: () => simulator({ GetScalingModeAsync: () => { throw new Error('scaling unavailable'); } }),
    });
    expect(handlers.getDeviceSimulatorState({ includeDeviceList: false })).toEqual({
      activeDeviceId: 'iphone_XR',
      isSimulating: true,
      resolution: { x: 828, y: 1792, width: 828, height: 1792 },
      pixelDensity: 2,
      orientation: 'Portrait',
      unavailable: { scalingMode: 'scaling unavailable' },
    });
  });

  test('a default device reads no active settings', () => {
    const handlers = loadHandlers({ simulator: () => simulator({}, 'default') });
    expect(handlers.getDeviceSimulatorState({ includeDeviceList: false })).toEqual({
      activeDeviceId: 'default',
      isSimulating: false,
    });
  });

  test.each(['custom_phone', 'nope'])('rejects %s as an invalid device id', (deviceId) => {
    const handlers = loadHandlers({ simulator: () => simulator() });
    expect(handlers.getDeviceSimulatorState({ deviceId, includeDeviceList: false })).toEqual({
      success: false,
      error: 'invalid_device_id',
      deviceId,
      available: ['ipad', 'iphone_XR'],
      message: `deviceId "${deviceId}" is not an available built-in device. Use get_device_simulator_state to list supported device IDs. Available: ipad, iphone_XR`,
    });
  });

  test.each([
    [{ deviceId: '' }, 'deviceId'],
    [{ deviceId: 7 }, 'deviceId'],
    [{ includeDeviceList: 'yes' }, 'includeDeviceList'],
  ])('rejects invalid arguments %j', (data, field) => {
    const handlers = loadHandlers({ simulator: () => simulator() });
    expect(handlers.getDeviceSimulatorState(data)).toEqual({
      success: false, error: 'invalid_argument', message: expect.stringContaining(field),
    });
  });

  test.each([
    ['the service is missing', undefined],
    ['the service does not answer in this DataModel', () => simulator({ GetDeviceAsync: () => { throw new Error('not supported here'); } })],
  ])('reports service_unavailable when %s', (_label, service) => {
    const handlers = loadHandlers({ simulator: service });
    expect(handlers.getDeviceSimulatorState({})).toEqual({
      success: false,
      error: 'service_unavailable',
      service: 'StudioDeviceSimulatorService',
      message: expect.stringContaining('StudioDeviceSimulatorService is unavailable in this DataModel'),
    });
  });

  test('reports a failed device list as read_failed', () => {
    const handlers = loadHandlers({
      simulator: () => simulator({ GetDeviceListAsync: () => { throw new Error('list failed'); } }),
    });
    expect(handlers.getDeviceSimulatorState({})).toEqual({
      success: false,
      error: 'read_failed',
      service: 'StudioDeviceSimulatorService',
      message: 'Could not list simulator devices: list failed',
    });
  });

  test('both reads are routed locally and forwarded to client peers', () => {
    const communication = readFileSync(resolve(PLUGIN_SRC, 'modules/Communication.ts'), 'utf8');
    const broker = readFileSync(resolve(PLUGIN_SRC, 'modules/ClientBroker.ts'), 'utf8');
    const allowed = broker.match(/const CLIENT_BROKER_ALLOWED_ENDPOINTS = new Set<string>\(\[([\s\S]*?)\]\);/)?.[1] ?? '';
    for (const [endpoint, handler] of [
      ['/api/get-network-simulation-state', 'getNetworkSimulationState'],
      ['/api/get-device-simulator-state', 'getDeviceSimulatorState'],
    ]) {
      expect(communication).toContain(`"${endpoint}": SimulationHandlers.${handler},`);
      expect(allowed).toContain(`"${endpoint}"`);
      expect(broker).toMatch(new RegExp(`payload\\.endpoint === "${endpoint}"\\) \\{\\s*return SimulationHandlers\\.${handler}\\(`));
    }
  });
});
