import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BridgeService, RoutingFailure } from '../bridge-service.js';
import { OpenCloudRequestError } from '../opencloud-client.js';
import type {
  MonetizationItem,
  MonetizationItemChanges,
  MonetizationItemPage,
  MonetizationKind,
} from '../opencloud-client.js';
import { RobloxStudioTools } from './test-tools.js';

class MonetizationTestBridge extends BridgeService {
  protected override notifyPeerRegistered(): void {
    // Simulated topology must not mutate the local managed-Studio registry.
  }
}

function item(overrides: Partial<MonetizationItem> = {}): MonetizationItem {
  return {
    kind: 'developer_product',
    id: 101,
    universeId: 42,
    name: '100 Coins',
    description: 'A pile of coins',
    forSale: false,
    price: 25,
    managedPricing: false,
    iconAssetId: null,
    ...overrides,
  };
}

type FakeClient = {
  hasApiKey: jest.Mock<boolean, []>;
  listMonetizationItems: jest.Mock<Promise<MonetizationItemPage>, [MonetizationKind, number, string?]>;
  getMonetizationItem: jest.Mock<Promise<MonetizationItem>, [MonetizationKind, number, number]>;
  createMonetizationItem: jest.Mock<
    Promise<MonetizationItem>,
    [MonetizationKind, number, MonetizationItemChanges & { name: string }]
  >;
  updateMonetizationItem: jest.Mock<Promise<void>, [MonetizationKind, number, number, MonetizationItemChanges]>;
};

function fakeClient(): FakeClient {
  return {
    hasApiKey: jest.fn<boolean, []>(() => true),
    listMonetizationItems: jest.fn<Promise<MonetizationItemPage>, [MonetizationKind, number, string?]>(
      async () => ({ items: [] }),
    ),
    getMonetizationItem: jest.fn<Promise<MonetizationItem>, [MonetizationKind, number, number]>(
      async () => item(),
    ),
    createMonetizationItem: jest.fn<
      Promise<MonetizationItem>,
      [MonetizationKind, number, MonetizationItemChanges & { name: string }]
    >(async () => item()),
    updateMonetizationItem: jest.fn<Promise<void>, [MonetizationKind, number, number, MonetizationItemChanges]>(
      async () => undefined,
    ),
  };
}

function replaceOpenCloudClient(tools: RobloxStudioTools, client: object): void {
  (tools as unknown as { openCloudClient: object }).openCloudClient = client;
}

function body(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const text = result.content[0]?.text;
  if (!text) throw new Error('Expected a text tool result');
  return JSON.parse(text) as Record<string, unknown>;
}

async function claimStudioRequest(bridge: BridgeService, transportPeerId: string) {
  // The tool queues its place-info request after a few promise hops.
  for (let attempt = 0; attempt < 50; attempt++) {
    const queued = bridge.claimNextRequestForTransport(transportPeerId, 'monetization-test');
    if (queued) return queued;
    await Promise.resolve();
  }
  throw new Error('Expected a queued Studio request');
}

// Lets every pending call run until it reaches a gate or finishes.
async function settle(): Promise<void> {
  for (let hop = 0; hop < 50; hop++) await Promise.resolve();
}

// A universe whose list calls wait for `gate`, then report every item created so far.
function gatedUniverse(client: FakeClient, gate: Promise<void>): void {
  const created: MonetizationItem[] = [];
  client.listMonetizationItems.mockImplementation(async () => {
    await gate;
    return { items: [...created] };
  });
  client.createMonetizationItem.mockImplementation(async (kind, universeId, changes) => {
    const made = item({ kind, universeId, id: 500 + created.length, name: changes.name });
    created.push(made);
    return made;
  });
}

describe('manage_monetization', () => {
  let bridge: BridgeService;
  let tools: RobloxStudioTools;
  let client: FakeClient;

  beforeEach(() => {
    bridge = new MonetizationTestBridge();
    tools = new RobloxStudioTools(bridge);
    client = fakeClient();
    replaceOpenCloudClient(tools, client);
  });

  afterEach(() => {
    bridge.clearAllPendingRequests();
  });

  test('lists one page of an explicit universe with snake_case items', async () => {
    client.listMonetizationItems.mockResolvedValue({
      items: [item({ createdAt: '2026-01-01T00:00:00Z', immutable: false })],
      nextPageToken: 'page-2',
    });

    const result = await tools.manageMonetization({
      action: 'list', kind: 'developer_product', universe_id: 42, page_token: 'page-1',
    });

    expect(client.listMonetizationItems).toHaveBeenCalledWith('developer_product', 42, 'page-1');
    expect(body(result)).toEqual({
      kind: 'developer_product',
      universe_id: 42,
      items: [{
        kind: 'developer_product',
        id: 101,
        universe_id: 42,
        name: '100 Coins',
        description: 'A pile of coins',
        for_sale: false,
        price: 25,
        managed_pricing: false,
        icon_asset_id: null,
        created_at: '2026-01-01T00:00:00Z',
        immutable: false,
      }],
      next_page_token: 'page-2',
    });
  });

  test('gets one item by ID', async () => {
    client.getMonetizationItem.mockResolvedValue(item({ kind: 'game_pass', id: 9, name: 'VIP' }));

    const result = await tools.manageMonetization({ action: 'get', kind: 'game_pass', universe_id: 42, id: 9 });

    expect(client.getMonetizationItem).toHaveBeenCalledWith('game_pass', 42, 9);
    expect(body(result)).toMatchObject({ item: { kind: 'game_pass', id: 9, name: 'VIP' } });
  });

  test('defaults to the universe of the connected Studio place', async () => {
    expect(bridge.registerPeer({
      peerId: 'edit', transportPeerId: 'edit', instanceId: 'instance:shop',
      role: 'edit', placeId: 123, placeName: 'Shop',
    }).ok).toBe(true);

    const pending = tools.manageMonetization({ action: 'list', kind: 'game_pass' }, 'instance:shop');
    const request = await claimStudioRequest(bridge, 'edit');
    expect(request.endpoint).toBe('/api/place-info');
    bridge.resolveRequest(request.requestId, { placeId: 123, gameId: 777 });

    expect(body(await pending)).toMatchObject({ kind: 'game_pass', universe_id: 777, items: [] });
    expect(client.listMonetizationItems).toHaveBeenCalledWith('game_pass', 777, undefined);
  });

  test('refuses an unpublished Studio place', async () => {
    expect(bridge.registerPeer({
      peerId: 'edit', transportPeerId: 'edit', instanceId: 'instance:local',
      role: 'edit', placeId: 0, placeName: 'Local',
    }).ok).toBe(true);

    const pending = tools.manageMonetization({ action: 'list', kind: 'developer_product' });
    const request = await claimStudioRequest(bridge, 'edit');
    bridge.resolveRequest(request.requestId, { placeId: 0, gameId: 0 });

    expect(body(await pending)).toMatchObject({ error: 'unpublished_place' });
    expect(client.listMonetizationItems).not.toHaveBeenCalled();
  });

  test('suggests universe_id when no Studio is connected', async () => {
    const failure = await tools.manageMonetization({ action: 'list', kind: 'game_pass' })
      .then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(RoutingFailure);
    expect(failure).toMatchObject({
      routingError: { message: expect.stringContaining('Pass universe_id') },
    });
  });

  test('requires an Open Cloud API key and names the scopes it needs', async () => {
    client.hasApiKey.mockReturnValue(false);

    const result = await tools.manageMonetization({ action: 'list', kind: 'game_pass', universe_id: 42 });

    expect(body(result)).toMatchObject({
      error: 'missing_api_key',
      required_scopes: ['game-pass:read'],
      message: expect.stringContaining('ROBLOX_OPEN_CLOUD_API_KEY'),
    });
    expect(client.listMonetizationItems).not.toHaveBeenCalled();
  });

  test.each([
    [{ action: 'delete', kind: 'game_pass', universe_id: 42 }, 'action'],
    [{ action: 'list', kind: 'badge', universe_id: 42 }, 'kind'],
    [{ action: 'list', kind: 'game_pass', universe_id: 0 }, 'universe_id'],
    [{ action: 'get', kind: 'game_pass', universe_id: 42 }, 'id'],
    [{ action: 'get', kind: 'game_pass', universe_id: 42, id: 1.5 }, 'id'],
    [{ action: 'list', kind: 'game_pass', universe_id: 42, id: 9 }, 'id'],
    [{ action: 'get', kind: 'game_pass', universe_id: 42, id: 9, price: 5 }, 'price'],
    [{ action: 'get', kind: 'game_pass', universe_id: 42, id: 9, page_token: 'x' }, 'page_token'],
    [{ action: 'create', kind: 'game_pass', universe_id: 42 }, 'name'],
    [{ action: 'create', kind: 'game_pass', universe_id: 42, name: '   ' }, 'name'],
    [{ action: 'create', kind: 'game_pass', universe_id: 42, name: 'VIP', id: 3 }, 'id'],
    [{ action: 'create', kind: 'game_pass', universe_id: 42, name: 'VIP', price: 0 }, 'price'],
    [{ action: 'create', kind: 'game_pass', universe_id: 42, name: 'VIP', price: 10.5 }, 'price'],
    [{ action: 'create', kind: 'game_pass', universe_id: 42, name: 'VIP', for_sale: true }, 'price'],
    [{ action: 'create', kind: 'game_pass', universe_id: 42, name: 'VIP', for_sale: 'yes' }, 'for_sale'],
    [{ action: 'update', kind: 'game_pass', universe_id: 42, id: 9 }, 'update needs'],
  ])('rejects invalid arguments before calling Roblox: %j', async (request, field) => {
    const result = body(await tools.manageMonetization(request));

    expect(result).toMatchObject({ error: 'invalid_argument', message: expect.stringContaining(field) });
    expect(client.listMonetizationItems).not.toHaveBeenCalled();
    expect(client.getMonetizationItem).not.toHaveBeenCalled();
    expect(client.createMonetizationItem).not.toHaveBeenCalled();
    expect(client.updateMonetizationItem).not.toHaveBeenCalled();
  });

  describe('create', () => {
    test('creates the item off sale unless for_sale is true', async () => {
      client.createMonetizationItem.mockResolvedValue(item({ kind: 'game_pass', id: 9, name: 'VIP', price: 199 }));

      const result = await tools.manageMonetization({
        action: 'create', kind: 'game_pass', universe_id: 42, name: ' VIP ', description: 'Perks', price: 199,
      });

      expect(client.createMonetizationItem).toHaveBeenCalledWith('game_pass', 42, {
        name: 'VIP', description: 'Perks', price: 199, forSale: false,
      });
      expect(body(result)).toMatchObject({
        created: true,
        item: { kind: 'game_pass', id: 9, name: 'VIP', price: 199 },
      });
    });

    test('passes on-sale and managed pricing choices through', async () => {
      await tools.manageMonetization({
        action: 'create', kind: 'developer_product', universe_id: 42, name: 'Gems',
        price: 50, for_sale: true, managed_pricing: true,
      });

      expect(client.createMonetizationItem).toHaveBeenCalledWith('developer_product', 42, {
        name: 'Gems', price: 50, forSale: true, managedPricing: true,
      });
    });

    test('refuses a name that already exists and returns the existing item', async () => {
      client.listMonetizationItems
        .mockResolvedValueOnce({ items: [item({ id: 1, name: 'Starter Pack' })], nextPageToken: 'next' })
        .mockResolvedValueOnce({ items: [item({ id: 7, name: '100 coins' })] });

      const result = body(await tools.manageMonetization({
        action: 'create', kind: 'developer_product', universe_id: 42, name: '  100 Coins ',
      }));

      expect(client.listMonetizationItems).toHaveBeenNthCalledWith(1, 'developer_product', 42, undefined);
      expect(client.listMonetizationItems).toHaveBeenNthCalledWith(2, 'developer_product', 42, 'next');
      expect(client.createMonetizationItem).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        error: 'duplicate_name',
        existing: { id: 7, name: '100 coins' },
      });
    });

    test.each([
      [400, 'invalid_request'],
      [429, 'rate_limited'],
    ])('does not remember a create that Roblox refused with HTTP %i', async (status, code) => {
      client.createMonetizationItem.mockRejectedValueOnce(
        new OpenCloudRequestError(`Open Cloud API error (${status}): refused`, status),
      );
      const request = { action: 'create', kind: 'game_pass', universe_id: 42, name: 'Refused Pass', price: 5 };

      expect(body(await tools.manageMonetization(request))).toMatchObject({ error: code });
      expect(body(await tools.manageMonetization(request))).toMatchObject({ created: true });
      expect(client.createMonetizationItem).toHaveBeenCalledTimes(2);
    });

    test('treats a gateway error from create as an unknown outcome', async () => {
      client.createMonetizationItem.mockRejectedValueOnce(
        new OpenCloudRequestError('Open Cloud API error (504): upstream timed out', 504),
      );
      const request = { action: 'create', kind: 'game_pass', universe_id: 42, name: 'Gateway Pass' };

      expect(body(await tools.manageMonetization(request))).toMatchObject({
        error: 'create_outcome_unknown',
        message: expect.stringContaining('HTTP 504'),
        hint: expect.stringContaining('run list'),
      });
      expect(body(await tools.manageMonetization(request))).toMatchObject({ error: 'create_outcome_unknown' });
      expect(client.createMonetizationItem).toHaveBeenCalledTimes(1);

      // Listing the item clears the unknown create so later tests can reuse the name.
      client.listMonetizationItems.mockResolvedValueOnce({ items: [item({ kind: 'game_pass', name: 'Gateway Pass' })] });
      await tools.manageMonetization({ action: 'list', kind: 'game_pass', universe_id: 42 });
    });

    describe('when the outcome is unknown', () => {
      const WINDOW_MS = 10 * 60 * 1000;
      const request = { action: 'create', kind: 'developer_product', universe_id: 42, name: 'Timed Out Coins' };

      beforeEach(() => {
        jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
        client.createMonetizationItem.mockRejectedValueOnce(new Error('Request timed out'));
      });

      afterEach(async () => {
        // Listing the item clears any unknown create a test left behind for this name.
        client.listMonetizationItems.mockResolvedValueOnce({ items: [item({ name: 'Timed Out Coins' })] });
        await tools.manageMonetization({ action: 'list', kind: 'developer_product', universe_id: 42 });
        jest.useRealTimers();
      });

      test('refuses to create the same name again until the window passes', async () => {
        expect(body(await tools.manageMonetization(request))).toEqual({
          error: 'create_outcome_unknown',
          message: expect.stringContaining('Request timed out'),
          hint: 'An item may have been created; run list (or get) before retrying create.',
          retry_after: '2026-01-01T00:10:00.000Z',
        });

        jest.advanceTimersByTime(WINDOW_MS - 1);
        const retry = body(await tools.manageMonetization({ ...request, name: ' timed out coins ' }));
        expect(retry).toMatchObject({
          error: 'create_outcome_unknown',
          hint: 'No item with this name is listed yet. If list still shows none, create can be retried after retry_after.',
          retry_after: '2026-01-01T00:10:00.000Z',
        });
        expect(client.createMonetizationItem).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(1);
        expect(body(await tools.manageMonetization(request))).toMatchObject({ created: true });
        expect(client.createMonetizationItem).toHaveBeenCalledTimes(2);
      });

      test('forgets the unknown create once Roblox lists the item', async () => {
        await tools.manageMonetization(request);
        client.listMonetizationItems.mockResolvedValueOnce({ items: [item({ id: 8, name: 'Timed Out Coins' })] });
        await tools.manageMonetization({ action: 'list', kind: 'developer_product', universe_id: 42 });

        // The item has since been renamed, so the name is free again.
        expect(body(await tools.manageMonetization(request))).toMatchObject({ created: true });
        expect(client.createMonetizationItem).toHaveBeenCalledTimes(2);
      });

      test('refuses to rename another item to the pending name', async () => {
        await tools.manageMonetization(request);
        jest.advanceTimersByTime(60_000);

        const renamed = body(await tools.manageMonetization({
          action: 'update', kind: 'developer_product', universe_id: 42, id: 8, name: 'Timed Out Coins',
        }));
        expect(renamed).toMatchObject({
          error: 'create_outcome_unknown',
          message: expect.stringContaining('nothing was renamed'),
          retry_after: '2026-01-01T00:10:00.000Z',
        });
        expect(client.updateMonetizationItem).not.toHaveBeenCalled();
      });

      test('still blocks other names only for their own unknown creates', async () => {
        await tools.manageMonetization(request);

        expect(body(await tools.manageMonetization({ ...request, name: 'Other Coins' }))).toMatchObject({ created: true });
        expect(body(await tools.manageMonetization({ ...request, kind: 'game_pass' }))).toMatchObject({ created: true });
        expect(body(await tools.manageMonetization({ ...request, universe_id: 43 }))).toMatchObject({ created: true });
        expect(body(await tools.manageMonetization(request))).toMatchObject({ error: 'create_outcome_unknown' });
      });
    });

    describe('overlapping calls', () => {
      test('lets only one of two creates of the same name through', async () => {
        const gate = Promise.withResolvers<void>();
        gatedUniverse(client, gate.promise);

        const first = tools.manageMonetization({
          action: 'create', kind: 'developer_product', universe_id: 42, name: 'Coins',
        });
        const second = tools.manageMonetization({
          action: 'create', kind: 'developer_product', universe_id: 42, name: ' coins ',
        });
        await settle();
        // The second check waits for the first create instead of scanning alongside it.
        expect(client.listMonetizationItems).toHaveBeenCalledTimes(1);
        gate.resolve();

        expect(body(await first)).toMatchObject({ created: true, item: { name: 'Coins' } });
        expect(body(await second)).toMatchObject({ error: 'duplicate_name', existing: { name: 'Coins' } });
        expect(client.createMonetizationItem).toHaveBeenCalledTimes(1);
      });

      test('checks different names at the same time', async () => {
        const gate = Promise.withResolvers<void>();
        gatedUniverse(client, gate.promise);

        const gems = tools.manageMonetization({
          action: 'create', kind: 'developer_product', universe_id: 42, name: 'Gems',
        });
        const rubies = tools.manageMonetization({
          action: 'create', kind: 'developer_product', universe_id: 42, name: 'Rubies',
        });
        await settle();
        expect(client.listMonetizationItems).toHaveBeenCalledTimes(2);
        gate.resolve();

        expect(body(await gems)).toMatchObject({ created: true, item: { name: 'Gems' } });
        expect(body(await rubies)).toMatchObject({ created: true, item: { name: 'Rubies' } });
      });

      test('a call that fails does not block the next call for the name', async () => {
        const gate = Promise.withResolvers<void>();
        client.listMonetizationItems
          .mockImplementationOnce(async () => {
            await gate.promise;
            throw new OpenCloudRequestError('Open Cloud API error (500): busy', 500);
          })
          .mockResolvedValueOnce({ items: [] });

        const failing = tools.manageMonetization({
          action: 'create', kind: 'game_pass', universe_id: 42, name: 'Flaky Pass',
        });
        const next = tools.manageMonetization({
          action: 'create', kind: 'game_pass', universe_id: 42, name: 'Flaky Pass',
        });
        await settle();
        expect(client.listMonetizationItems).toHaveBeenCalledTimes(1);
        gate.resolve();

        expect(body(await failing)).toMatchObject({ error: 'open_cloud_error', status: 500 });
        expect(body(await next)).toMatchObject({ created: true });
        expect(client.createMonetizationItem).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('update', () => {
    test('sends only the given fields and returns the re-read item', async () => {
      client.getMonetizationItem.mockResolvedValue(item({ forSale: false, price: 30 }));

      const result = await tools.manageMonetization({
        action: 'update', kind: 'developer_product', universe_id: 42, id: 101, for_sale: false, price: 30,
      });

      expect(client.updateMonetizationItem).toHaveBeenCalledWith('developer_product', 42, 101, {
        price: 30, forSale: false,
      });
      expect(client.getMonetizationItem).toHaveBeenCalledWith('developer_product', 42, 101);
      expect(body(result)).toMatchObject({ updated: true, item: { id: 101, for_sale: false, price: 30 } });
    });

    test('still reports success when the follow-up read fails', async () => {
      client.getMonetizationItem.mockRejectedValue(new OpenCloudRequestError('Rate limit exceeded. Please try again later.', 429));

      const result = body(await tools.manageMonetization({
        action: 'update', kind: 'game_pass', universe_id: 42, id: 9, name: 'VIP+',
      }));

      expect(result).toMatchObject({ updated: true, item: null, warnings: [expect.stringContaining('Rate limit')] });
      expect(result).not.toHaveProperty('error');
    });

    test('refuses to rename an item to the name of another item', async () => {
      client.listMonetizationItems.mockResolvedValue({
        items: [item({ kind: 'game_pass', id: 9, name: 'vip' }), item({ kind: 'game_pass', id: 3, name: 'VIP ' })],
      });

      const result = body(await tools.manageMonetization({
        action: 'update', kind: 'game_pass', universe_id: 42, id: 9, name: 'VIP',
      }));

      expect(result).toMatchObject({ error: 'duplicate_name', existing: { id: 3 } });
      expect(client.updateMonetizationItem).not.toHaveBeenCalled();
    });

    test('allows an item to keep its own name with different casing', async () => {
      client.listMonetizationItems.mockResolvedValue({ items: [item({ kind: 'game_pass', id: 9, name: 'vip' })] });

      await tools.manageMonetization({ action: 'update', kind: 'game_pass', universe_id: 42, id: 9, name: 'VIP' });

      expect(client.updateMonetizationItem).toHaveBeenCalledWith('game_pass', 42, 9, { name: 'VIP' });
    });
  });

  describe('icons', () => {
    const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
    let directory: string;

    beforeEach(() => {
      directory = mkdtempSync(join(tmpdir(), 'monetization-icon-'));
    });

    afterEach(() => {
      rmSync(directory, { recursive: true, force: true });
    });

    test('uploads a local icon with the type found in its bytes', async () => {
      const iconPath = join(directory, 'coins.dat');
      writeFileSync(iconPath, PNG_BYTES);

      await tools.manageMonetization({
        action: 'create', kind: 'developer_product', universe_id: 42, name: 'Gems', image_path: iconPath,
      });

      expect(client.createMonetizationItem).toHaveBeenCalledWith('developer_product', 42, {
        name: 'Gems',
        forSale: false,
        icon: { data: PNG_BYTES, fileName: 'icon.png', mimeType: 'image/png' },
      });
    });

    test('update can change only the icon', async () => {
      const iconPath = join(directory, 'vip.jpg');
      writeFileSync(iconPath, JPEG_BYTES);

      await tools.manageMonetization({ action: 'update', kind: 'game_pass', universe_id: 42, id: 9, image_path: iconPath });

      expect(client.updateMonetizationItem).toHaveBeenCalledWith('game_pass', 42, 9, {
        icon: { data: JPEG_BYTES, fileName: 'icon.jpg', mimeType: 'image/jpeg' },
      });
    });

    test.each([
      ['a file that is not an image', (dir: string) => {
        const target = join(dir, 'notes.png');
        writeFileSync(target, 'plain text');
        return target;
      }, 'PNG, JPEG, or BMP'],
      ['a missing file', (dir: string) => join(dir, 'missing.png'), 'image_path not found'],
      ['a directory', (dir: string) => {
        const target = join(dir, 'folder');
        mkdirSync(target);
        return target;
      }, 'regular file'],
      ['a file over 10 MiB', (dir: string) => {
        const target = join(dir, 'huge.png');
        writeFileSync(target, PNG_BYTES);
        truncateSync(target, 10 * 1024 * 1024 + 1);
        return target;
      }, '10485760'],
    ])('rejects %s before contacting Roblox', async (_label, makePath, message) => {
      const result = body(await tools.manageMonetization({
        action: 'create', kind: 'game_pass', universe_id: 42, name: 'VIP', image_path: makePath(directory),
      }));

      expect(result).toMatchObject({ error: 'invalid_argument', message: expect.stringContaining(message) });
      expect(client.listMonetizationItems).not.toHaveBeenCalled();
      expect(client.createMonetizationItem).not.toHaveBeenCalled();
    });
  });

  test.each([
    [403, 'forbidden', { required_scopes: ['game-pass:read', 'game-pass:write'] }],
    [404, 'not_found', {}],
    [409, 'conflict', {}],
    [429, 'rate_limited', {}],
    [400, 'invalid_request', { field: 'price', hint: 'Use whole Robux.' }],
    [500, 'open_cloud_error', { status: 500 }],
  ])('maps Open Cloud HTTP %i to %s', async (status, code, extra) => {
    client.updateMonetizationItem.mockRejectedValue(new OpenCloudRequestError(
      `Open Cloud API error (${status}): failed`,
      status,
      { field: 'price', hint: 'Use whole Robux.' },
    ));

    const result = body(await tools.manageMonetization({
      action: 'update', kind: 'game_pass', universe_id: 42, id: 9, price: 5,
    }));

    expect(result).toMatchObject({ error: code, message: expect.stringContaining('failed'), ...extra });
  });
});
