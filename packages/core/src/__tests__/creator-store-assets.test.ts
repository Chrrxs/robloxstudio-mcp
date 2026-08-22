import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { BridgeService } from '../bridge-service.js';
import { TOOL_GUIDE_MARKDOWN } from '../mcp-compat.js';
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
  test('public Creator Store search omits a configured API key', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      creatorStoreAssets: [],
      totalResults: 0,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const client = new OpenCloudClient({
      apiKey: 'asset-delivery-only-key',
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
    }
  });

  test('downloads bounded asset content through the authenticated Roblox delivery endpoint', async () => {
    const audioBytes = Buffer.concat([
      Buffer.from('OggS'),
      Buffer.alloc(24, 7),
    ]);
    const fetchSpy = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        location: 'https://fts.rbxcdn.com/audio/content',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array(audioBytes), {
        status: 200,
        headers: {
          'Content-Type': 'binary/octet-stream',
          'Content-Length': String(audioBytes.length),
        },
      }));
    const client = new OpenCloudClient({
      apiKey: 'test-key',
      baseUrl: 'https://apis.roblox.test',
    });

    try {
      const downloaded = await client.downloadAudioAssetContent(9125402735, 1024);

      expect(downloaded).toEqual({
        data: audioBytes,
        mimeType: 'audio/ogg',
      });
      expect(fetchSpy.mock.calls[0]?.[0]).toBe(
        'https://apis.roblox.test/asset-delivery-api/v1/assetId/9125402735',
      );
      expect(fetchSpy.mock.calls[0]?.[1]?.headers).toEqual({
        'x-api-key': 'test-key',
      });
      expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(
        'https://fts.rbxcdn.com/audio/content',
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('rejects audio delivery locations outside the Roblox CDN', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        location: 'https://example.test/untrusted-audio.ogg',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    const client = new OpenCloudClient({
      apiKey: 'test-key',
      baseUrl: 'https://apis.roblox.test',
    });

    try {
      await expect(
        client.downloadAudioAssetContent(9125402735, 1024),
      ).rejects.toThrow('untrusted download location');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('accepts Roblox content delivery for owned legacy audio', async () => {
    const audioBytes = Buffer.concat([
      Buffer.from('OggS'),
      Buffer.alloc(24, 5),
    ]);
    const fetchSpy = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        location: 'https://contentdelivery.roblox.com/v1/content?id=legacy-audio',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array(audioBytes), {
        status: 200,
        headers: {
          'Content-Type': 'binary/octet-stream',
          'Content-Length': String(audioBytes.length),
        },
      }));
    const client = new OpenCloudClient({
      apiKey: 'test-key',
      baseUrl: 'https://apis.roblox.test',
    });

    try {
      await expect(
        client.downloadAudioAssetContent(11760866308, 1024),
      ).resolves.toEqual({
        data: audioBytes,
        mimeType: 'audio/ogg',
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('rejects declared audio payloads above the inline preview limit', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        location: 'https://fts.rbxcdn.com/audio/oversized',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array(Buffer.from('OggS')), {
        status: 200,
        headers: {
          'Content-Type': 'binary/octet-stream',
          'Content-Length': '2048',
        },
      }));
    const client = new OpenCloudClient({
      apiKey: 'test-key',
      baseUrl: 'https://apis.roblox.test',
    });

    try {
      await expect(
        client.downloadAudioAssetContent(9125402735, 1024),
      ).rejects.toThrow('exceeds the 1024-byte preview limit');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('Particle search returns compact normalized rows without thumbnail expansion', async () => {
    const tools = new RobloxStudioTools(new BridgeService());
    const searchAssets = jest.fn(async () => ({
      creatorStoreAssets: [{
        asset: {
          id: 101,
          name: 'Smoke Burst',
          description: 'A deliberately\nlong description that belongs in get_asset_details.',
          durationSeconds: 0.3918,
          createTime: '2026-01-01T00:00:00Z',
        },
        creator: { name: 'Example', verified: true, userId: 99 },
        voting: { upVotes: 400, downVotes: 2 },
      }],
      totalResults: 1,
      nextPageToken: 'verbose-token',
    }));
    replaceOpenCloudClient(tools, {
      hasApiKey: () => true,
      searchAssets,
    });

    const result = await tools.searchAssets('Particle', 'smoke', 12, 'Top', true);
    const body = textBody(result);

    expect(searchAssets).toHaveBeenCalledWith({
      searchCategoryType: 'Model',
      query: 'smoke particle effect',
      maxPageSize: 12,
      sortCategory: 'Top',
      userId: 1,
    });
    expect(body).toEqual({
      assetType: 'Particle',
      query: 'smoke particle effect',
      searchedAs: 'Model',
      totalResults: 1,
      results: [{
        assetId: 101,
        name: 'Smoke Burst',
        description: 'A deliberately long description that belongs in get_asset_details.',
        duration: 0.3918,
      }],
    });
    expect(JSON.stringify(body)).not.toContain('creator');
    expect(JSON.stringify(body)).not.toContain('verified');
    expect(JSON.stringify(body)).not.toContain('durationSeconds');
    expect(JSON.stringify(body)).not.toContain('voting');
    expect(JSON.stringify(body).length).toBeLessThan(300);
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
    });

    const result = await tools.searchAssets('Image', 'stone texture');
    const body = textBody(result);

    expect(searchAssets).toHaveBeenCalledWith(expect.objectContaining({
      searchCategoryType: 'Decal',
      query: 'stone texture',
    }));
    expect(searchAssets).toHaveBeenCalledWith(expect.not.objectContaining({
      userId: expect.anything(),
    }));
    expect(body).toMatchObject({
      assetType: 'Image',
      searchedAs: 'Decal',
      query: 'stone texture',
      results: [],
    });
  });

  test('get_asset_details preserves full metadata for shortlisted assets', async () => {
    const tools = new RobloxStudioTools(new BridgeService());
    const details = {
      asset: {
        id: 101,
        name: 'Smoke Burst',
        description: 'Full description',
        assetTypeId: 10,
        createTime: '2026-01-01T00:00:00Z',
      },
      creator: {
        name: 'Example',
        verified: true,
        userId: 99,
      },
      voting: {
        upVotes: 400,
        downVotes: 2,
      },
    };
    const getAssetDetails = jest.fn(async () => details);
    replaceOpenCloudClient(tools, {
      getAssetDetails,
    });

    expect(textBody(await tools.getAssetDetails(101))).toEqual(details);
    expect(getAssetDetails).toHaveBeenCalledWith(101);
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
    });

    await expect(tools.searchAssets('Backdoor')).rejects.toThrow('assetType must be one of');
    await expect(tools.searchAssets('Model', 'tree', 101)).rejects.toThrow('maxResults');
    expect(searchAssets).not.toHaveBeenCalled();
  });

  test('tool schemas encode aliases and defaults while the guide explains safe insertion', () => {
    const search = TOOL_DEFINITIONS.find((tool) => tool.name === 'search_assets');
    const preview = TOOL_DEFINITIONS.find((tool) => tool.name === 'preview_asset');
    const insert = TOOL_DEFINITIONS.find((tool) => tool.name === 'insert_asset');
    const searchProps = (search?.inputSchema as {
      properties?: Record<string, { type?: string; enum?: string[]; default?: unknown; description?: string }>;
    }).properties ?? {};
    const previewProps = (preview?.inputSchema as {
      properties?: Record<string, {
        type?: string;
        default?: unknown;
        minimum?: number;
        maximum?: number;
      }>;
    }).properties ?? {};

    expect(searchProps.assetType.enum).toEqual(expect.arrayContaining([
      'Model',
      'Decal',
      'Image',
      'Particle',
      'VFX',
    ]));
    expect(searchProps.assetType.description).toContain('Image maps to Decal');
    expect(searchProps).toHaveProperty('robloxCreatedOnly');
    expect(searchProps.robloxCreatedOnly).toMatchObject({ type: 'boolean', default: false });
    expect(searchProps).not.toHaveProperty('verifiedCreatorsOnly');
    expect(previewProps.includeAudio).toMatchObject({
      type: 'boolean',
      default: true,
    });
    expect(previewProps.includeProperties).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(previewProps.maxDepth).toMatchObject({
      type: 'number',
      default: 4,
    });
    expect(previewProps.maxAudioPreviews).toMatchObject({
      type: 'number',
      default: 3,
      minimum: 1,
      maximum: 5,
    });
    expect(search?.description).toMatch(/^Use /);
    expect(preview?.description).toMatch(/^Use /);
    expect(insert?.description).toMatch(/^Use /);
    expect(TOOL_GUIDE_MARKDOWN).toContain('scans the complete hierarchy without returning script source');
    expect(TOOL_GUIDE_MARKDOWN).toContain('removes every LuaSourceContainer and PackageLink');
    expect(TOOL_GUIDE_MARKDOWN).toContain('then scans again before insertion');
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

    const previewPromise = tools.previewAsset(101, true, 8, 'place:test', false);
    const previewRequest = bridge.getPendingRequest('place:test', 'edit');
    expect(previewRequest?.request).toEqual({
      endpoint: '/api/preview-asset',
      data: { assetId: 101, includeProperties: true, maxDepth: 8 },
    });
    bridge.resolveRequest(previewRequest!.requestId, {
      success: true,
      summary: { scriptCount: 1, securityScanDepth: 'unlimited', scriptSourceExposed: false },
    });
    expect(textBody(await previewPromise)).toEqual({
      success: true,
      assetId: 101,
      totalInstances: 0,
      security: {
        scanDepth: 'unlimited',
        scripts: 1,
        packageLinks: 0,
      },
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

  test('preview emits deduplicated temporary audio content with contextual metadata', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    const downloadAudioAssetContent = jest.fn(async () => ({
      data: Buffer.concat([Buffer.from('OggS'), Buffer.alloc(12, 3)]),
      mimeType: 'audio/ogg',
    }));
    replaceOpenCloudClient(tools, {
      downloadAudioAssetContent,
    });
    replaceInstanceManager(tools, {
      pendingLaunches: jest.fn(async () => []),
    });
    bridge.registerInstance({
      pluginSessionId: 'creator-store-audio-test',
      instanceId: 'place:audio-test',
      role: 'edit',
      placeId: 0,
      placeName: 'Audio Test',
      dataModelName: 'Audio Test',
      isRunning: false,
    });

    const previewPromise = tools.previewAsset(
      202,
      true,
      8,
      'place:audio-test',
      true,
      2,
    );
    const previewRequest = bridge.getPendingRequest('place:audio-test', 'edit');
    bridge.resolveRequest(previewRequest!.requestId, {
      success: true,
      summary: {
        hasSounds: true,
        soundCount: 2,
      },
      sounds: [
        {
          path: 'Wrapper.Ambience',
          name: 'Ambience',
          className: 'Sound',
          soundId: 'rbxassetid://9125402735',
        },
        {
          path: 'Wrapper.AmbienceCopy',
          name: 'AmbienceCopy',
          className: 'Sound',
          soundId: 'https://www.roblox.com/asset/?id=9125402735',
        },
      ],
    });

    const result = await previewPromise;
    const body = textBody(result);
    const audioContent = result.content[1] as {
      type: string;
      data?: string;
      mimeType?: string;
    };

    expect(downloadAudioAssetContent).toHaveBeenCalledTimes(1);
    expect(downloadAudioAssetContent).toHaveBeenCalledWith(9125402735, 3_000_000);
    expect(body.audio).toMatchObject({
      returned: 1,
      bytes: 16,
    });
    expect((body.audio as { items: unknown[] }).items).toEqual([
      expect.objectContaining({
        assetId: 9125402735,
        status: 'included',
        references: 2,
        mimeType: 'audio/ogg',
        bytes: 16,
      }),
    ]);
    expect(body.sounds).toEqual([
      {
        assetId: 9125402735,
        className: 'Sound',
        name: 'Ambience',
        path: 'Wrapper.Ambience',
      },
      {
        assetId: 9125402735,
        className: 'Sound',
        name: 'AmbienceCopy',
        path: 'Wrapper.AmbienceCopy',
      },
    ]);
    expect(audioContent).toEqual({
      type: 'audio',
      data: Buffer.concat([Buffer.from('OggS'), Buffer.alloc(12, 3)]).toString('base64'),
      mimeType: 'audio/ogg',
    });

    const metadataOnlyPromise = tools.previewAsset(
      203,
      true,
      8,
      'place:audio-test',
      false,
      2,
    );
    const metadataOnlyRequest = bridge.getPendingRequest('place:audio-test', 'edit');
    bridge.resolveRequest(metadataOnlyRequest!.requestId, {
      success: true,
      summary: {
        hasSounds: true,
        soundCount: 1,
      },
      sounds: [{
        path: 'Wrapper.Ambience',
        name: 'Ambience',
        className: 'Sound',
        soundId: 'rbxassetid://9125402735',
      }],
    });
    const metadataOnlyResult = await metadataOnlyPromise;

    expect(metadataOnlyResult.content).toHaveLength(1);
    expect(downloadAudioAssetContent).toHaveBeenCalledTimes(1);
    expect(textBody(metadataOnlyResult)).toMatchObject({
      sounds: [{
        assetId: 9125402735,
      }],
    });
    expect(textBody(metadataOnlyResult)).not.toHaveProperty('audio');
  });

  test('preview caps the display hierarchy without weakening summary counts', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    replaceInstanceManager(tools, {
      pendingLaunches: jest.fn(async () => []),
    });
    bridge.registerInstance({
      pluginSessionId: 'creator-store-hierarchy-cap-test',
      instanceId: 'place:hierarchy-cap-test',
      role: 'edit',
      placeId: 0,
      placeName: 'Hierarchy Cap Test',
      dataModelName: 'Hierarchy Cap Test',
      isRunning: false,
    });

    const previewPromise = tools.previewAsset(
      204,
      false,
      8,
      'place:hierarchy-cap-test',
      false,
    );
    const previewRequest = bridge.getPendingRequest('place:hierarchy-cap-test', 'edit');
    bridge.resolveRequest(previewRequest!.requestId, {
      success: true,
      hierarchy: Array.from({ length: 120 }, (_, index) => ({
        name: `Part${index}`,
        className: 'Part',
      })),
      summary: {
        totalInstances: 121,
        classCounts: {
          Model: 1,
          Part: 120,
        },
        scriptCount: 0,
        packageLinkCount: 0,
      },
      sounds: [],
    });

    const body = textBody(await previewPromise);
    expect(body.totalInstances).toBe(121);
    expect(body.classes).toEqual({ Model: 1, Part: 120 });
    expect(body.hierarchyTruncated).toBe(true);
    expect(body.hierarchy).toHaveLength(100);
  });

  test('preview returns the requested Creator Store audio when Studio loads an empty wrapper', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    const audioBytes = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(12, 4)]);
    const getAssetDetails = jest.fn(async () => ({
      asset: {
        id: 2575934454,
        assetTypeId: 3,
        name: 'Item Pickup',
      },
    }));
    const downloadAudioAssetContent = jest.fn(async () => ({
      data: audioBytes,
      mimeType: 'audio/ogg' as const,
    }));
    replaceOpenCloudClient(tools, {
      getAssetDetails,
      downloadAudioAssetContent,
    });
    replaceInstanceManager(tools, {
      pendingLaunches: jest.fn(async () => []),
    });
    bridge.registerInstance({
      pluginSessionId: 'creator-store-direct-audio-test',
      instanceId: 'place:direct-audio-test',
      role: 'edit',
      placeId: 0,
      placeName: 'Direct Audio Test',
      dataModelName: 'Direct Audio Test',
      isRunning: false,
    });

    const previewPromise = tools.previewAsset(
      2575934454,
      true,
      8,
      'place:direct-audio-test',
      true,
      1,
    );
    const previewRequest = bridge.getPendingRequest('place:direct-audio-test', 'edit');
    bridge.resolveRequest(previewRequest!.requestId, {
      success: true,
      hierarchy: [],
      summary: {
        hasSounds: false,
        soundCount: 0,
      },
      sounds: [],
    });

    const result = await previewPromise;
    const body = textBody(result);

    expect(getAssetDetails).toHaveBeenCalledWith(2575934454);
    expect(downloadAudioAssetContent).toHaveBeenCalledWith(2575934454, 3_000_000);
    expect(body).toMatchObject({
      directAudioAsset: true,
      audio: {
        returned: 1,
      },
    });
    expect(body.audio).toMatchObject({
      returned: 1,
    });
    expect((body.audio as { items: unknown[] }).items).toEqual([
      expect.objectContaining({
        assetId: 2575934454,
        direct: true,
        status: 'included',
      }),
    ]);
    expect(result.content[1]).toEqual({
      type: 'audio',
      data: audioBytes.toString('base64'),
      mimeType: 'audio/ogg',
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
    expect(handlerSource).toContain('sounds: soundReferences');
  });

  test('load failures explain the disabled third-party asset setting', () => {
    const installationSource = readFileSync(
      join(repositoryRoot, 'studio-plugin/INSTALLATION.md'),
      'utf8',
    );
    const creatorStoreSource = readFileSync(
      join(repositoryRoot, 'docs/creator-store-assets.md'),
      'utf8',
    );

    expect(handlerSource).toContain('AllowInsertFreeAssets');
    expect(handlerSource).toContain('Allow Loading Third Party Assets');
    expect(installationSource).toContain('Allow Loading Third Party Assets');
    expect(creatorStoreSource).toContain('Allow Loading Third Party Assets');
  });
});

describe('distribution metadata security contract', () => {
  const cwd = process.cwd();
  const repositoryRoot = existsSync(join(cwd, 'studio-plugin')) ? cwd : resolve(cwd, '../..');
  const rootPackage = JSON.parse(
    readFileSync(join(repositoryRoot, 'package.json'), 'utf8'),
  ) as { scripts?: Record<string, string> };
  const distributionSources = [
    'README.md',
    'studio-plugin/INSTALLATION.md',
    'studio-plugin/src/modules/Communication.ts',
    'packages/robloxstudio-mcp/package.json',
    'packages/robloxstudio-mcp-inspector/package.json',
  ].map((relativePath) => readFileSync(join(repositoryRoot, relativePath), 'utf8'));

  test('installation instructions and package metadata point only to the upstream project', () => {
    const combinedSources = distributionSources.join('\n');

    expect(combinedSources).not.toContain('Akramle');
    expect(combinedSources).not.toContain('github:Akramle');
    expect(combinedSources).toContain('@chrrxs/robloxstudio-mcp@latest');
    expect(combinedSources).toContain('github.com/chrrxs/robloxstudio-mcp');
  });

  test('ordinary package lifecycle hooks cannot install or remove Studio plugins', () => {
    expect(rootPackage.scripts?.prepare).toBeUndefined();
    expect(rootPackage.scripts?.prepack).toBeUndefined();
    expect(rootPackage.scripts?.postinstall).toBeUndefined();
  });
});
