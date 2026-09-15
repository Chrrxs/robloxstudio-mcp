// Field report #8: search_tags is a read tool that forwards tag/maxResults to /api/search-tags, and
// get_instance_properties keeps its wire contract so the plugin can add a tags array.
import { getReadOnlyTools, TOOL_DEFINITIONS } from '../tools/definitions.js';
import { TOOL_HANDLERS } from '../http-server.js';
import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';

const CLAIM_OWNER = 'field-08-tags-test';

function connectedTools() {
  const bridge = new BridgeService();
  bridge.registerPeer({
    peerId: 'edit-session',
    transportPeerId: 'edit-session',
    instanceId: 'instance:test',
    role: 'edit',
    placeId: 0,
    placeName: 'TestPlace',
    dataModelName: 'TestPlace',
    isRunning: false,
  });
  return { bridge, tools: new RobloxStudioTools(bridge) };
}

async function nextPendingRequest(bridge: BridgeService) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const queued = bridge.claimNextRequestForTransport('edit-session', CLAIM_OWNER);
    if (queued) {
      return {
        requestId: queued.requestId,
        endpoint: queued.endpoint,
        data: queued.data as Record<string, unknown>,
      };
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('timed out waiting for the plugin request');
}

describe('field #8 search_tags', () => {
  test('is a read-only catalog tool with tag, maxResults, and instance_id', () => {
    const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === 'search_tags');
    expect(tool).toBeDefined();
    expect(tool!.category).toBe('read');
    expect(getReadOnlyTools().some((candidate) => candidate.name === 'search_tags')).toBe(true);
    const properties = (tool!.inputSchema as { properties?: Record<string, unknown>; required?: string[] }).properties ?? {};
    expect(Object.keys(properties).sort()).toEqual(['instance_id', 'maxResults', 'tag']);
    expect((tool!.inputSchema as { required?: string[] }).required).toBeUndefined();
    expect(TOOL_HANDLERS.search_tags).toBeDefined();
  });

  test('forwards tag and maxResults to /api/search-tags and returns the plugin body', async () => {
    const { bridge, tools } = connectedTools();
    const resultPromise = TOOL_HANDLERS.search_tags(tools, { tag: 'Field8', maxResults: 5, instance_id: 'instance:test' });
    resultPromise.catch(() => {});

    const request = await nextPendingRequest(bridge);
    expect(request.endpoint).toBe('/api/search-tags');
    expect(request.data).toEqual({ tag: 'Field8', maxResults: 5 });
    bridge.resolveRequest(request.requestId, {
      tag: 'Field8',
      instances: ['Workspace.Field8.Field8Part'],
      instanceCount: 1,
      truncated: false,
      scripts: [{ instancePath: 'ServerScriptService.Field8Static', className: 'Script', line: 2, text: 'CS:GetTagged("Field8")', api: 'GetTagged' }],
      scriptsSearched: 2,
    });

    const result = await resultPromise;
    const first = result.content[0];
    if (first.type !== 'text') throw new Error('expected a text response');
    expect(JSON.parse(first.text)).toMatchObject({
      tag: 'Field8',
      instances: ['Workspace.Field8.Field8Part'],
      scripts: [{ line: 2, api: 'GetTagged' }],
    });
  });

  test('omits tag from the request when listing every tag', async () => {
    const { bridge, tools } = connectedTools();
    const resultPromise = TOOL_HANDLERS.search_tags(tools, { instance_id: 'instance:test' });
    resultPromise.catch(() => {});
    const request = await nextPendingRequest(bridge);
    expect(request.data).toEqual({});
    bridge.resolveRequest(request.requestId, { tags: [{ tag: 'Field8', count: 1 }], totalTags: 1 });
    const result = await resultPromise;
    const first = result.content[0];
    if (first.type !== 'text') throw new Error('expected a text response');
    expect(JSON.parse(first.text)).toEqual({ tags: [{ tag: 'Field8', count: 1 }], totalTags: 1 });
  });

  test('rejects a non-string tag and an out-of-range maxResults before contacting Studio', async () => {
    const { bridge, tools } = connectedTools();
    await expect(TOOL_HANDLERS.search_tags(tools, { tag: 5, instance_id: 'instance:test' }))
      .rejects.toThrow('search_tags tag must be a non-empty string.');
    await expect(TOOL_HANDLERS.search_tags(tools, { tag: 'x', maxResults: 0, instance_id: 'instance:test' }))
      .rejects.toThrow('search_tags maxResults must be an integer between 1 and 1000.');
    expect(bridge.claimNextRequestForTransport('edit-session', CLAIM_OWNER)).toBeNull();
  });
});
