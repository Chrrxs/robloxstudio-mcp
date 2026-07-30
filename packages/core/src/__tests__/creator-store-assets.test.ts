import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { BridgeService } from '../bridge-service.js';
import { OpenCloudClient } from '../opencloud-client.js';
import { RobloxStudioTools } from '../tools/index.js';
import { TOOL_DEFINITIONS } from '../tools/definitions.js';

function textBody(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const text = result.content[0]?.text;
  if (!text) throw new Error('Expected a text tool result');
  return JSON.parse(text) as Record<string, unknown>;
}

function replaceOpenCloudClient(tools: RobloxStudioTools, client: object): void {
  (tools as unknown as { openCloudClient: object }).openCloudClient = client;
}

function replaceInstanceManager(tools: RobloxStudioTools, manager: object): void {
  (tools as unknown as { instanceManager: object }).instanceManager = manager;
}

describe('Creator Store asset search', () => {
  test('public Creator Store search sends no API key when none is configured', async () => {
    const previousApiKey = process.env.ROBLOX_OPEN_CLOUD_API_KEY;
    delete process.env.ROBLOX_OPEN_CLOUD_API_KEY;
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      creatorStoreAssets: [],
      totalResults: 0,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const client = new OpenCloudClient({
      apiKey: '',
      baseUrl: 'https://creator-store.test',
    });

    try {
      await client.searchAssets({
        searchCategoryType: 'Model',
        query: 'smoke',
        maxPageSize: 1,
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const requestOptions = fetchSpy.mock.calls[0]?.[1];
      expect(requestOptions?.headers).toEqual({
        'Content-Type': 'application/json',
      });
    } finally {
      fetchSpy.mockRestore();
      if (previousApiKey === undefined) {
        delete process.env.ROBLOX_OPEN_CLOUD_API_KEY;
      } else {
        process.env.ROBLOX_OPEN_CLOUD_API_KEY = previousApiKey;
      }
    }
  });

  test('Particle search uses Creator Store models, effect terms, and thumbnail URLs', async () => {
    const tools = new RobloxStudioTools(new BridgeService());
    const searchAssets = jest.fn(async () => ({
      creatorStoreAssets: [{
        asset: { id: 101, name: 'Smoke Burst' },
        creator: { name: 'Example' },
      }],
      totalResults: 1,
    }));
    const getAssetThumbnails = jest.fn(async () => new Map([
      [101, 'https://example.test/101.png'],
    ]));
    replaceOpenCloudClient(tools, {
      hasApiKey: () => true,
      searchAssets,
      getAssetThumbnails,
    });

    const result = await tools.searchAssets('Particle', 'smoke', 12, 'Top', true);
    const body = textBody(result);

    expect(searchAssets).toHaveBeenCalledWith({
      searchCategoryType: 'Model',
      query: 'smoke particle effect',
      maxPageSize: 12,
      sortCategory: 'Top',
      includeOnlyVerifiedCreators: true,
    });
    expect(getAssetThumbnails).toHaveBeenCalledWith([101]);
    expect(body.search).toMatchObject({
      requestedAssetType: 'Particle',
      searchCategoryType: 'Model',
      effectiveQuery: 'smoke particle effect',
    });
    expect(body.creatorStoreAssets).toEqual([
      expect.objectContaining({ thumbnailUrl: 'https://example.test/101.png' }),
    ]);
    expect(body.insertionSecurity).toMatchObject({
      verifiedCreatorsOnlyIsNotASecurityBoundary: true,
      previewBeforeInsertRecommended: true,
    });
  });

  test('Image searches use the Creator Store Decal category', async () => {
    const tools = new RobloxStudioTools(new BridgeService());
    const searchAssets = jest.fn(async () => ({
      creatorStoreAssets: [],
      totalResults: 0,
    }));
    replaceOpenCloudClient(tools, {
      hasApiKey: () => true,
      searchAssets,
      getAssetThumbnails: jest.fn(async () => new Map()),
    });

    const result = await tools.searchAssets('Image', 'stone texture');
    const body = textBody(result);

    expect(searchAssets).toHaveBeenCalledWith(expect.objectContaining({
      searchCategoryType: 'Decal',
      query: 'stone texture',
    }));
    expect(body.search).toMatchObject({
      requestedAssetType: 'Image',
      searchCategoryType: 'Decal',
      effectiveQuery: 'stone texture',
    });
  });

  test('VFX searches default to models and a VFX query', async () => {
    const tools = new RobloxStudioTools(new BridgeService());
    const searchAssets = jest.fn(async () => ({
      creatorStoreAssets: [],
      totalResults: 0,
    }));
    replaceOpenCloudClient(tools, {
      hasApiKey: () => true,
      searchAssets,
      getAssetThumbnails: jest.fn(async () => new Map()),
    });

    await tools.searchAssets('VFX');

    expect(searchAssets).toHaveBeenCalledWith(expect.objectContaining({
      searchCategoryType: 'Model',
      query: 'VFX',
    }));
  });

  test('rejects unknown asset types and invalid result limits before searching', async () => {
    const tools = new RobloxStudioTools(new BridgeService());
    const searchAssets = jest.fn();
    replaceOpenCloudClient(tools, {
      hasApiKey: () => true,
      searchAssets,
      getAssetThumbnails: jest.fn(),
    });

    await expect(tools.searchAssets('Backdoor')).rejects.toThrow('assetType must be one of');
    await expect(tools.searchAssets('Model', 'tree', 101)).rejects.toThrow('maxResults');
    expect(searchAssets).not.toHaveBeenCalled();
  });

  test('tool schemas describe aliases, unlimited scans, and fail-closed insertion', () => {
    const search = TOOL_DEFINITIONS.find((tool) => tool.name === 'search_assets');
    const preview = TOOL_DEFINITIONS.find((tool) => tool.name === 'preview_asset');
    const insert = TOOL_DEFINITIONS.find((tool) => tool.name === 'insert_asset');
    const searchProps = (search?.inputSchema as {
      properties?: Record<string, { enum?: string[] }>;
    }).properties ?? {};

    expect(searchProps.assetType.enum).toEqual(expect.arrayContaining([
      'Model',
      'Decal',
      'Image',
      'Particle',
      'VFX',
    ]));
    expect(search?.description).toContain('Creator verification');
    expect(search?.description).toContain('without requiring Roblox credentials');
    expect(preview?.description).toContain('unlimited-depth');
    expect(preview?.description).toContain('script source is never read or returned');
    expect(insert?.description).toContain('Every LuaSourceContainer');
    expect(insert?.description).toContain('every PackageLink');
    expect(insert?.description).toContain('second unlimited-depth scan');
  });

  test('preview and secure insertion use the existing Studio bridge endpoints', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    replaceInstanceManager(tools, {
      pendingLaunches: jest.fn(async () => []),
    });
    bridge.registerInstance({
      pluginSessionId: 'creator-store-test',
      instanceId: 'place:test',
      role: 'edit',
      placeId: 0,
      placeName: 'Test',
      dataModelName: 'Test',
      isRunning: false,
    });

    const previewPromise = tools.previewAsset(101, true, 8, 'place:test');
    const previewRequest = bridge.getPendingRequest('place:test', 'edit');
    expect(previewRequest?.request).toEqual({
      endpoint: '/api/preview-asset',
      data: { assetId: 101, includeProperties: true, maxDepth: 8 },
    });
    bridge.resolveRequest(previewRequest!.requestId, {
      success: true,
      summary: { scriptCount: 1, securityScanDepth: 'unlimited', scriptSourceExposed: false },
    });
    expect(textBody(await previewPromise)).toMatchObject({
      success: true,
      summary: { scriptCount: 1, securityScanDepth: 'unlimited', scriptSourceExposed: false },
    });

    const insertPromise = tools.insertAsset(
      101,
      'game.Workspace.Effects',
      { x: 1, y: 2, z: 3 },
      'place:test',
    );
    const insertRequest = bridge.getPendingRequest('place:test', 'edit');
    expect(insertRequest?.request).toEqual({
      endpoint: '/api/insert-asset',
      data: {
        assetId: 101,
        parentPath: 'game.Workspace.Effects',
        position: { x: 1, y: 2, z: 3 },
      },
    });
    bridge.resolveRequest(insertRequest!.requestId, {
      success: true,
      insertedCount: 1,
      sanitization: {
        removedScriptCount: 1,
        removedPackageLinkCount: 1,
        verifiedClean: true,
      },
    });
    expect(textBody(await insertPromise)).toMatchObject({
      success: true,
      sanitization: {
        removedScriptCount: 1,
        removedPackageLinkCount: 1,
        verifiedClean: true,
      },
    });
  });
});

describe('Creator Store insertion security contract', () => {
  const cwd = process.cwd();
  const repositoryRoot = existsSync(join(cwd, 'studio-plugin')) ? cwd : resolve(cwd, '../..');
  const assetHandlersPath = join(repositoryRoot, 'studio-plugin/src/modules/handlers/AssetHandlers.ts');
  const sanitizationPolicyPath = join(
    repositoryRoot,
    'studio-plugin/src/modules/AssetSanitizationPolicy.ts',
  );
  const handlerSource = readFileSync(assetHandlersPath, 'utf8');
  const policySource = readFileSync(sanitizationPolicyPath, 'utf8');

  test('forbidden scan is name-independent and traverses all descendants', () => {
    const scanStart = policySource.indexOf('function scanForbiddenImportedInstances');
    const scanEnd = policySource.indexOf('export function sanitizeLoadedAsset', scanStart);
    const scanBody = policySource.slice(scanStart, scanEnd);

    expect(scanBody).toContain('instance.IsA("LuaSourceContainer")');
    expect(scanBody).toContain('instance.IsA("PackageLink")');
    expect(scanBody).toContain('root.GetDescendants()');
    expect(scanBody).not.toContain('maxDepth');
    expect(scanBody).not.toContain('.Name');
  });

  test('sanitizer keeps the root unparented, strips, and scans a second time', () => {
    const sanitizerStart = policySource.indexOf('function sanitizeLoadedAsset');
    const sanitizerBody = policySource.slice(sanitizerStart);
    const scanCalls = sanitizerBody.match(/scanForbiddenImportedInstances\(root\)/g) ?? [];

    expect(handlerSource).toContain('instance.Parent = undefined');
    expect(scanCalls).toHaveLength(2);
    expect(sanitizerBody).toContain('operations.destroy(scriptInstance)');
    expect(sanitizerBody).toContain('operations.destroy(packageLink)');
    expect(sanitizerBody).toContain('remainingScriptCount > 0');
    expect(sanitizerBody).toContain('remainingPackageLinkCount > 0');
    expect(sanitizerBody).toContain('operations.destroy(root)');
  });

  test('parenting happens only after sanitization and failures roll back', () => {
    const insertStart = handlerSource.indexOf('function insertAsset');
    const insertEnd = handlerSource.indexOf('function previewAsset', insertStart);
    const insertBody = handlerSource.slice(insertStart, insertEnd);
    const sanitizeAt = insertBody.indexOf('sanitizeLoadedAsset(loadedWrapper, sanitizationOperations)');
    const parentAt = insertBody.indexOf('child.Parent = parentInstance');

    expect(sanitizeAt).toBeGreaterThanOrEqual(0);
    expect(parentAt).toBeGreaterThan(sanitizeAt);
    expect(insertBody).toContain('if (!insertSuccess)');
    expect(insertBody).toContain('inserted.Destroy()');
  });

  test('preview never reads or returns imported script source', () => {
    expect(handlerSource).not.toContain('sourcePreview');
    expect(handlerSource).not.toMatch(/LuaSourceContainer[\s\S]{0,300}\.Source\b/);
    expect(handlerSource).toContain('scriptSourceExposed: false');
  });
});
