import request from 'supertest';
import { BridgeService } from '../bridge-service.js';
import { createHttpServer } from '../http-server.js';
import { publicToolErrorBody } from '../mcp-runtime.js';
import { ProxyBridgeService } from '../proxy-bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';
import { getReadOnlyTools } from '../tools/definitions.js';

class SimulationTestBridge extends BridgeService {
  protected override notifyPeerRegistered(): void {
    // Simulated topology must not mutate the local managed-Studio registry.
  }
}

const INSTANCE_ID = 'instance:sim';
const NETWORK_STATE = {
  InboundNetworkMinDelayMs: 150,
  OutboundNetworkMinDelayMs: 150,
  InboundNetworkJitterMs: 100,
  OutboundNetworkJitterMs: 100,
  InboundNetworkLossPercent: 0.5,
  OutboundNetworkLossPercent: 0.5,
};
const DEVICES = [{ DeviceId: 'iphone_XR', IsCustom: false }, { DeviceId: 'ipad', IsCustom: false }];
const DEVICE_STATE = {
  activeDeviceId: 'iphone_XR',
  isSimulating: true,
  resolution: { x: 828, y: 1792, width: 828, height: 1792 },
  pixelDensity: 2,
  orientation: 'Portrait',
  scalingMode: 'ActualSize',
};

type StudioAnswer = (endpoint: string, data: Record<string, unknown>) => unknown;

// Answers like a Studio plugin of this version: native reads for the narrow
// endpoints, and the same values through generated Luau.
const studio: StudioAnswer = (endpoint, data) => {
  const deviceState = (options: Record<string, unknown>) => ({
    ...DEVICE_STATE,
    ...(options.includeDeviceList !== false ? { devices: DEVICES } : {}),
    ...(typeof options.deviceId === 'string' ? { deviceInfo: { DeviceId: options.deviceId } } : {}),
  });
  if (endpoint === '/api/get-network-simulation-state') return { success: true, state: NETWORK_STATE };
  if (endpoint === '/api/get-device-simulator-state') return deviceState(data);
  if (endpoint === '/api/execute-luau') {
    const code = String(data.code);
    if (code.includes('NetworkSettings')) {
      return { success: true, returnValue: JSON.stringify({ success: true, state: NETWORK_STATE }) };
    }
    const options = JSON.parse(JSON.parse(code.match(/JSONDecode\(("(?:[^"\\]|\\.)*")\)/)![1]));
    return { success: true, returnValue: JSON.stringify(deviceState(options)) };
  }
  return { error: `Unknown endpoint: ${endpoint}` };
};

function registerEdit(bridge: BridgeService): void {
  expect(bridge.registerPeer({
    peerId: 'edit', transportPeerId: 'edit', instanceId: INSTANCE_ID, role: 'edit', placeId: 0, placeName: 'Sim',
  }).ok).toBe(true);
}

// Settles each request the primary admits, as Studio would, and records it.
function answerAdmittedRequests(primary: BridgeService, endpoints: string[], answer: StudioAnswer = studio): void {
  const send = primary.sendRequest.bind(primary);
  jest.spyOn(primary, 'sendRequest').mockImplementation((...args) => {
    const response = send(...args);
    const claimed = primary.claimNextRequestForTransport('edit', 'socket');
    if (claimed) {
      endpoints.push(claimed.endpoint);
      primary.settleTransportResponse('edit', claimed.requestId, answer(claimed.endpoint, claimed.data as Record<string, unknown>));
    }
    return response;
  });
}

function parse(result: { content: Array<{ text?: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text ?? '');
}

async function withProxy(
  options: { inspector: boolean; olderPrimary?: boolean; answer?: StudioAnswer },
  run: (context: { primaryTools: RobloxStudioTools; proxyTools: RobloxStudioTools; endpoints: string[]; proxyEndpoints: string[] }) => Promise<void>,
): Promise<void> {
  const primary = new SimulationTestBridge();
  registerEdit(primary);
  const endpoints: string[] = [];
  answerAdmittedRequests(primary, endpoints, options.answer);
  const primaryTools = new RobloxStudioTools(primary);
  const allowed = options.inspector ? new Set(getReadOnlyTools().map((tool) => tool.name)) : undefined;
  const app = createHttpServer(primaryTools, primary, allowed);
  const proxyEndpoints: string[] = [];
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const path = `${url.pathname}${url.search}`;
    if (init?.method === 'POST' && url.pathname === '/proxy') proxyEndpoints.push(JSON.parse(String(init.body)).endpoint);
    const response = init?.method === 'POST'
      ? await request(app).post(path).set('Content-Type', 'application/json').send(String(init.body))
      : await request(app).get(path);
    let text = response.text;
    if (options.olderPrimary && url.pathname === '/topology') {
      const topology = JSON.parse(text);
      topology.proxyFeatures = topology.proxyFeatures.filter((feature: string) => feature !== 'simulation_reads');
      text = JSON.stringify(topology);
    }
    return new Response(text, { status: response.status, headers: { 'Content-Type': 'application/json' } });
  });
  const proxy = new ProxyBridgeService('http://primary');
  try {
    await proxy.waitForInitialRefresh();
    await run({ primaryTools, proxyTools: new RobloxStudioTools(proxy), endpoints, proxyEndpoints });
  } finally {
    proxy.stop();
    fetchMock.mockRestore();
    primary.clearAllPendingRequests();
    await app.cleanup();
  }
}

describe('simulation reads through a secondary server', () => {
  test('an Inspector primary serves get_simulation_state through narrow read endpoints', async () => {
    await withProxy({ inspector: true }, async ({ primaryTools, proxyTools, endpoints, proxyEndpoints }) => {
      const viaProxy = parse(await proxyTools.getSimulationState('both', 'edit', INSTANCE_ID));
      expect(viaProxy.roles).toEqual({
        edit: {
          network: { success: true, state: NETWORK_STATE },
          deviceSimulator: DEVICE_STATE,
        },
      });
      expect(proxyEndpoints.sort()).toEqual(['/api/get-device-simulator-state', '/api/get-network-simulation-state']);
      expect(endpoints).not.toContain('/api/execute-luau');

      const onPrimary = parse(await primaryTools.getSimulationState('both', 'edit', INSTANCE_ID));
      expect(viaProxy).toEqual(onPrimary);
    });
  });

  test('an Inspector primary serves get_device_simulator_state through a narrow read endpoint', async () => {
    await withProxy({ inspector: true }, async ({ primaryTools, proxyTools, endpoints }) => {
      const viaProxy = parse(await proxyTools.getDeviceSimulatorState('edit', 'ipad', true, INSTANCE_ID));
      expect(viaProxy).toEqual({
        target: 'edit', role: 'edit', ...DEVICE_STATE, devices: DEVICES, deviceInfo: { DeviceId: 'ipad' },
      });
      expect(endpoints).toEqual(['/api/get-device-simulator-state']);

      const onPrimary = parse(await primaryTools.getDeviceSimulatorState('edit', 'ipad', true, INSTANCE_ID));
      expect(viaProxy).toEqual(onPrimary);
    });
  });

  test('an older primary without simulation_reads is read through execute-luau', async () => {
    await withProxy({ inspector: false, olderPrimary: true }, async ({ proxyTools, proxyEndpoints }) => {
      const state = parse(await proxyTools.getSimulationState('both', 'edit', INSTANCE_ID));
      expect(state.roles).toEqual({
        edit: { network: { success: true, state: NETWORK_STATE }, deviceSimulator: DEVICE_STATE },
      });
      const device = parse(await proxyTools.getDeviceSimulatorState('edit', undefined, false, INSTANCE_ID));
      expect(device).toEqual({ target: 'edit', role: 'edit', ...DEVICE_STATE });
      expect(proxyEndpoints).toEqual(['/api/execute-luau', '/api/execute-luau', '/api/execute-luau']);
    });
  });

  test('an older Inspector primary reports forbidden_endpoint, distinct from Studio failures', async () => {
    await withProxy({ inspector: true, olderPrimary: true }, async ({ proxyTools, endpoints }) => {
      const state = parse(await proxyTools.getSimulationState('network', 'edit', INSTANCE_ID));
      expect(state.roles).toEqual({
        edit: {
          errors: {
            network: {
              code: 'forbidden_endpoint',
              message: expect.stringContaining('/api/execute-luau'),
            },
          },
        },
      });
      expect(endpoints).toEqual([]);

      const error = await proxyTools.getDeviceSimulatorState('edit', undefined, false, INSTANCE_ID).catch((caught: unknown) => caught);
      expect(publicToolErrorBody('get_device_simulator_state', error)).toMatchObject({
        error: 'forbidden_endpoint', stage: 'queued', outcome: 'not_executed', executionOutcome: 'not_executed',
      });
    });
  });

  test('an unavailable Studio service is reported with its own code', async () => {
    const unavailable: StudioAnswer = (endpoint, data) => endpoint === '/api/get-device-simulator-state'
      ? { success: false, error: 'service_unavailable', service: 'StudioDeviceSimulatorService', message: 'StudioDeviceSimulatorService is unavailable in this DataModel' }
      : studio(endpoint, data);
    await withProxy({ inspector: true, answer: unavailable }, async ({ proxyTools }) => {
      const state = parse(await proxyTools.getSimulationState('both', 'edit', INSTANCE_ID));
      expect(state.roles).toEqual({
        edit: {
          network: { success: true, state: NETWORK_STATE },
          errors: {
            deviceSimulator: {
              code: 'service_unavailable',
              message: 'StudioDeviceSimulatorService is unavailable in this DataModel',
            },
          },
        },
      });

      const error = await proxyTools.getDeviceSimulatorState('edit', undefined, false, INSTANCE_ID).catch((caught: unknown) => caught);
      expect(publicToolErrorBody('get_device_simulator_state', error)).toEqual({
        error: 'service_unavailable',
        message: 'StudioDeviceSimulatorService is unavailable in this DataModel',
        service: 'StudioDeviceSimulatorService',
      });
    });
  });
});
