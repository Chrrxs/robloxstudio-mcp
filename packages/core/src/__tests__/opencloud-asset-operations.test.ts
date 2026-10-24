import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { BridgeService } from '../bridge-service.js';
import { TOOL_HANDLERS } from '../http-server.js';
import { createToolServer, publicToolErrorBody, type ProtocolEra } from '../mcp-runtime.js';
import { OpenCloudClient, OpenCloudOperationError, type AssetUploadRequest } from '../opencloud-client.js';
import { TOOL_DEFINITIONS } from '../tools/definitions.js';
import { RobloxStudioTools } from '../tools/index.js';

const PROVIDER_ERROR = { code: 3, message: 'synthetic invalid upload' };
const SUCCESS_RESPONSE = { '@type': 't', assetId: '987', displayName: 'x', assetType: 'Model' };
const UPLOAD: AssetUploadRequest = {
  assetType: 'Model',
  displayName: 'test',
  description: '',
  creationContext: { creator: { userId: '1' } },
};

/** Serves the given operation bodies in order and records each request. */
function mockOpenCloud(bodies: unknown[]): string[] {
  const requests: string[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const body = bodies[Math.min(requests.length, bodies.length - 1)];
    requests.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return requests;
}

function createAsset(): Promise<unknown> {
  return new OpenCloudClient({ apiKey: 'test-key' }).createAsset(UPLOAD, Buffer.from('rbxm'), 'model.rbxm');
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('OpenCloudClient.createAsset operation results', () => {
  test('rejects an immediate done operation that carries an error', async () => {
    const requests = mockOpenCloud([{ path: 'operations/op-1', done: true, error: PROVIDER_ERROR }]);
    const failure = createAsset();
    await expect(failure).rejects.toBeInstanceOf(OpenCloudOperationError);
    await expect(failure).rejects.toMatchObject({
      providerCode: 3,
      providerMessage: 'synthetic invalid upload',
      operationPath: 'operations/op-1',
    });
    expect(requests).toEqual(['POST /assets/v1/assets']);
  });

  test('rejects a polled operation that finishes with an error', async () => {
    jest.useFakeTimers();
    const requests = mockOpenCloud([
      { path: 'operations/op-2', done: false },
      { path: 'operations/op-2', done: false },
      { path: 'operations/op-2', done: true, error: PROVIDER_ERROR },
    ]);
    const failure = createAsset();
    const assertion = expect(failure).rejects.toMatchObject({
      name: 'OpenCloudOperationError',
      providerCode: 3,
      providerMessage: 'synthetic invalid upload',
      operationPath: 'operations/op-2',
    });
    await jest.advanceTimersByTimeAsync(2_000);
    await assertion;
    expect(requests).toEqual([
      'POST /assets/v1/assets',
      'GET /assets/v1/operations/op-2',
      'GET /assets/v1/operations/op-2',
    ]);
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each([
    ['immediately', [{ path: 'operations/op-3', done: true }]],
    ['after polling', [{ path: 'operations/op-3', done: false }, { path: 'operations/op-3', done: true, response: {} }]],
  ])('rejects a done operation without an asset ID %s', async (_label, bodies) => {
    jest.useFakeTimers();
    const requests = mockOpenCloud(bodies);
    const failure = createAsset();
    const assertion = expect(failure).rejects.toMatchObject({
      name: 'OpenCloudOperationError',
      providerCode: undefined,
      operationPath: 'operations/op-3',
      message: expect.stringContaining('without an asset ID'),
    });
    await jest.advanceTimersByTimeAsync(2_000);
    await assertion;
    expect(requests.filter((request) => request.startsWith('POST'))).toHaveLength(1);
  });

  test('resolves a polled success with its asset ID and posts once', async () => {
    jest.useFakeTimers();
    const requests = mockOpenCloud([
      { path: 'operations/op-4', done: false },
      { path: 'operations/op-4', done: true, response: SUCCESS_RESPONSE },
    ]);
    const success = createAsset();
    await jest.advanceTimersByTimeAsync(2_000);
    await expect(success).resolves.toMatchObject({ done: true, response: { assetId: '987' } });
    expect(requests).toEqual(['POST /assets/v1/assets', 'GET /assets/v1/operations/op-4']);
  });

  test('resolves an immediate success with its asset ID', async () => {
    const requests = mockOpenCloud([{ path: 'operations/op-5', done: true, response: SUCCESS_RESPONSE }]);
    await expect(createAsset()).resolves.toMatchObject({ response: { assetId: '987' } });
    expect(requests).toEqual(['POST /assets/v1/assets']);
  });
});

test('publicToolErrorBody exposes the provider failure explicitly', () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  expect(publicToolErrorBody('upload_asset', new OpenCloudOperationError('bad file', 'operations/op-6', 3)))
    .toEqual({
      error: 'asset_upload_failed',
      message: 'bad file',
      provider_code: 3,
      operation_path: 'operations/op-6',
    });
});

describe('upload tools surface Open Cloud operation failures', () => {
  const savedEnv = { ...process.env };
  let directory: string;
  let tools: RobloxStudioTools;

  beforeEach(async () => {
    process.env.ROBLOX_OPEN_CLOUD_API_KEY = 'test-key';
    process.env.ROBLOX_CREATOR_USER_ID = '123';
    delete process.env.ROBLOSECURITY;
    directory = await mkdtemp(join(tmpdir(), 'mcp-upload-'));
    tools = new RobloxStudioTools(new BridgeService());
  });

  afterEach(async () => {
    await tools.dispose();
    await rm(directory, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  async function callUploadAsset(era: ProtocolEra, filePath: string, assetType = 'Model') {
    const definition = TOOL_DEFINITIONS.find((tool) => tool.name === 'upload_asset')!;
    const server = createToolServer({
      config: { name: 'test-server', version: '3.0.0', tools: [definition] },
      getTools: () => tools,
      era,
      invoke: (target, name, args, context) => TOOL_HANDLERS[name](target, args, context),
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      return await client.callTool({
        name: 'upload_asset',
        arguments: { filePath, assetType, displayName: 'x' },
      });
    } finally {
      await client.close();
      await server.close();
    }
  }

  describe.each(['modern', 'legacy'] as const)('%s protocol era', (era) => {
    test.each(['Model', 'Decal'])('a failed %s upload is an error result', async (assetType) => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const file = join(directory, assetType === 'Decal' ? 'image.png' : 'model.rbxm');
      await writeFile(file, 'bytes');
      const requests = mockOpenCloud([{ path: 'operations/op-7', done: true, error: PROVIDER_ERROR }]);
      const result = await callUploadAsset(era, file, assetType);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: 'asset_upload_failed',
        message: 'synthetic invalid upload',
        provider_code: 3,
        operation_path: 'operations/op-7',
      });
      expect(requests).toEqual(['POST /assets/v1/assets']);
    });

    test('a successful upload still returns its asset ID', async () => {
      const file = join(directory, 'model.rbxm');
      await writeFile(file, 'bytes');
      mockOpenCloud([{ path: 'operations/op-8', done: true, response: SUCCESS_RESPONSE }]);
      const result = await callUploadAsset(era, file);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ response: { assetId: '987' } });
    });
  });

  test('generate_model reference image uploads report the provider message', async () => {
    mockOpenCloud([{ path: 'operations/op-9', done: true, error: PROVIDER_ERROR }]);
    const upload = Reflect.get(tools, 'uploadGenerateModelReferenceImage');
    if (typeof upload !== 'function') throw new Error('uploadGenerateModelReferenceImage is missing');
    await expect(upload.call(tools, Buffer.from('png'))).rejects.toThrow('synthetic invalid upload');
  });
});
