import { OpenCloudClient, OpenCloudRequestError } from '../opencloud-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function testClient(): OpenCloudClient {
  return new OpenCloudClient({ apiKey: 'test-key', baseUrl: 'https://apis.roblox.test' });
}

type FetchSpy = jest.SpyInstance<Promise<Response>, [input: string | URL | Request, init?: RequestInit]>;

function requestAt(fetchSpy: FetchSpy, index: number): { url: string; init: RequestInit } {
  const call = fetchSpy.mock.calls[index];
  if (!call) throw new Error(`Expected fetch call ${index}`);
  const [url, init] = call;
  return { url: String(url), init: init ?? {} };
}

function formBody(init: RequestInit): FormData {
  const body = init.body;
  if (!(body instanceof FormData)) throw new Error('Expected a multipart FormData body');
  return body;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Open Cloud monetization client', () => {
  test('lists developer products for a universe as normalized items', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      developerProducts: [{
        productId: 101,
        name: '100 Coins',
        description: 'A pile of coins',
        iconImageAssetId: 555,
        universeId: 42,
        isForSale: true,
        storePageEnabled: false,
        priceInformation: { defaultPriceInRobux: 25, enabledFeatures: ['RegionalPricing'] },
        isImmutable: false,
        createdTimestamp: '2026-01-01T00:00:00Z',
        updatedTimestamp: '2026-01-02T00:00:00Z',
        isManagedPricingEnabled: false,
      }],
      nextPageToken: 'page-2',
    }));

    const page = await testClient().listMonetizationItems('developer_product', 42, 'page-1');

    const { url, init } = requestAt(fetchSpy, 0);
    expect(url).toBe(
      'https://apis.roblox.test/developer-products/v2/universes/42/developer-products/creator?pageToken=page-1',
    );
    expect(init).toMatchObject({ method: 'GET', headers: { 'x-api-key': 'test-key' } });
    expect(page).toEqual({
      items: [{
        kind: 'developer_product',
        id: 101,
        universeId: 42,
        name: '100 Coins',
        description: 'A pile of coins',
        forSale: true,
        price: 25,
        managedPricing: false,
        iconAssetId: 555,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        immutable: false,
      }],
      nextPageToken: 'page-2',
    });
  });

  test('lists game passes and treats an empty page token as the last page', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      gamePasses: [{
        gamePassId: 9,
        name: 'VIP',
        description: 'Perks',
        isForSale: false,
        iconAssetId: 0,
        createdTimestamp: '2026-01-01T00:00:00Z',
        updatedTimestamp: '2026-01-01T00:00:00Z',
        priceInformation: null,
        isManagedPricingEnabled: true,
      }],
      nextPageToken: '',
    }));

    const page = await testClient().listMonetizationItems('game_pass', 42);

    expect(requestAt(fetchSpy, 0).url).toBe(
      'https://apis.roblox.test/game-passes/v1/universes/42/game-passes/creator',
    );
    expect(page).toEqual({
      items: [{
        kind: 'game_pass',
        id: 9,
        universeId: 42,
        name: 'VIP',
        description: 'Perks',
        forSale: false,
        price: null,
        managedPricing: true,
        iconAssetId: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }],
    });
  });

  test('gets one game pass by ID', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      gamePassId: 9,
      name: 'VIP',
      description: '',
      isForSale: true,
      iconAssetId: 777,
      priceInformation: { defaultPriceInRobux: 199, enabledFeatures: [] },
      isManagedPricingEnabled: false,
    }));

    const item = await testClient().getMonetizationItem('game_pass', 42, 9);

    expect(requestAt(fetchSpy, 0).url).toBe(
      'https://apis.roblox.test/game-passes/v1/universes/42/game-passes/9/creator',
    );
    expect(item).toEqual({
      kind: 'game_pass',
      id: 9,
      universeId: 42,
      name: 'VIP',
      description: '',
      forSale: true,
      price: 199,
      managedPricing: false,
      iconAssetId: 777,
    });
  });

  test('rejects a response without a usable item ID', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ name: 'No ID' }));

    await expect(testClient().getMonetizationItem('developer_product', 42, 101))
      .rejects.toThrow('Open Cloud returned a developer product without a valid productId.');
  });

  test('creates a game pass from multipart fields and an icon file', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      gamePassId: 9,
      name: 'VIP',
      description: 'Perks',
      isForSale: false,
      iconAssetId: 0,
      priceInformation: { defaultPriceInRobux: 199, enabledFeatures: [] },
      isManagedPricingEnabled: true,
    }));

    const created = await testClient().createMonetizationItem('game_pass', 42, {
      name: 'VIP',
      description: 'Perks',
      price: 199,
      forSale: false,
      managedPricing: true,
      icon: { data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), fileName: 'icon.png', mimeType: 'image/png' },
    });

    const { url, init } = requestAt(fetchSpy, 0);
    expect(url).toBe('https://apis.roblox.test/game-passes/v1/universes/42/game-passes');
    expect(init.method).toBe('POST');
    // fetch must set the multipart boundary itself, so no Content-Type is sent.
    expect(init.headers).toEqual({ 'x-api-key': 'test-key' });
    const form = formBody(init);
    expect(form.get('name')).toBe('VIP');
    expect(form.get('description')).toBe('Perks');
    expect(form.get('price')).toBe('199');
    expect(form.get('isForSale')).toBe('false');
    expect(form.get('isManagedPricingEnabled')).toBe('true');
    const icon = form.get('imageFile');
    if (!(icon instanceof File)) throw new Error('Expected imageFile to be a file part');
    expect(icon.name).toBe('icon.png');
    expect(icon.type).toBe('image/png');
    expect(Buffer.from(await icon.arrayBuffer())).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(created).toEqual({
      kind: 'game_pass',
      id: 9,
      universeId: 42,
      name: 'VIP',
      description: 'Perks',
      forSale: false,
      price: 199,
      managedPricing: true,
      iconAssetId: null,
    });
  });

  test('sends only the fields it is given', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      productId: 101,
      name: 'Gems',
      description: '',
      iconImageAssetId: 0,
      universeId: 42,
      isForSale: false,
      priceInformation: null,
      isImmutable: false,
      isManagedPricingEnabled: false,
    }));

    await testClient().createMonetizationItem('developer_product', 42, { name: 'Gems' });

    const { url, init } = requestAt(fetchSpy, 0);
    expect(url).toBe('https://apis.roblox.test/developer-products/v2/universes/42/developer-products');
    expect([...formBody(init).keys()]).toEqual(['name']);
  });

  test('updates with PATCH and accepts an empty 204 response', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    await expect(testClient().updateMonetizationItem('developer_product', 42, 101, { forSale: false }))
      .resolves.toBeUndefined();

    const { url, init } = requestAt(fetchSpy, 0);
    expect(url).toBe('https://apis.roblox.test/developer-products/v2/universes/42/developer-products/101');
    expect(init.method).toBe('PATCH');
    const form = formBody(init);
    expect([...form.keys()]).toEqual(['isForSale']);
    expect(form.get('isForSale')).toBe('false');
  });

  test('reports Roblox monetization error fields with the HTTP status', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      errorCode: 'InvalidPrice',
      errorMessage: 'Price must be at least 1.',
      field: 'price',
      hint: 'Use a whole number of Robux.',
    }, 400));

    const failure = await testClient().createMonetizationItem('developer_product', 42, { name: 'Gems' })
      .then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(OpenCloudRequestError);
    expect(failure).toMatchObject({
      message: 'Open Cloud API error (400): Price must be at least 1.',
      status: 400,
      details: { errorCode: 'InvalidPrice', field: 'price', hint: 'Use a whole number of Robux.' },
    });
  });

  test('keeps the existing permission message for 403 responses', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ errorMessage: 'Forbidden' }, 403));

    await expect(testClient().listMonetizationItems('game_pass', 42)).rejects.toMatchObject({
      message: 'API key lacks required permissions: Forbidden',
      status: 403,
    });
  });
});
