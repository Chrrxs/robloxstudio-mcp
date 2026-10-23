import { OpenCloudClient } from '../opencloud-client.js';

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

function requestAt(fetchSpy: FetchSpy, index: number): { url: URL; init: RequestInit } {
  const call = fetchSpy.mock.calls[index];
  if (!call) throw new Error(`Expected fetch call ${index}`);
  const [url, init] = call;
  return { url: new URL(String(url)), init: init ?? {} };
}

function jsonBody(init: RequestInit): unknown {
  if (typeof init.body !== 'string') throw new Error('Expected a JSON request body');
  return JSON.parse(init.body);
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Open Cloud experience client', () => {
  test('normalizes a universe from its resource paths', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      path: 'universes/42',
      createTime: '2026-01-01T00:00:00Z',
      updateTime: '2026-01-02T00:00:00Z',
      displayName: 'Obby',
      description: 'Jump',
      group: 'groups/7',
      visibility: 'PRIVATE',
      discordSocialLink: { title: 'Server', uri: 'https://discord.gg/x' },
      twitterSocialLink: { title: '', uri: '' },
      voiceChatEnabled: true,
      ageRating: 'AGE_RATING_13_PLUS',
      privateServerPriceRobux: 25,
      desktopEnabled: true,
      mobileEnabled: false,
      rootPlace: 'universes/42/places/100',
    }));

    const result = await testClient().getUniverse(42);

    const { url, init } = requestAt(fetchSpy, 0);
    expect(url.href).toBe('https://apis.roblox.test/cloud/v2/universes/42');
    expect(init).toMatchObject({ method: 'GET', headers: { 'x-api-key': 'test-key' } });
    expect(result).toEqual({
      id: 42,
      displayName: 'Obby',
      description: 'Jump',
      visibility: 'PRIVATE',
      ownerUserId: null,
      ownerGroupId: 7,
      ageRating: 'AGE_RATING_13_PLUS',
      voiceChatEnabled: true,
      privateServerPriceRobux: 25,
      devices: { desktop: true, mobile: false, tablet: false, console: false, vr: false },
      socialLinks: { discord: { title: 'Server', uri: 'https://discord.gg/x' } },
      rootPlaceId: 100,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    });
  });

  test('masks cleared universe fields and leaves them out of the body', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ path: 'universes/42' }));

    await testClient().updateUniverse(42, {
      voiceChatEnabled: false,
      privateServerPriceRobux: null,
      devices: { vr: true },
      socialLinks: { youtube: { title: 'Channel', uri: 'https://youtube.com/x' }, twitter: null },
    });

    const { url, init } = requestAt(fetchSpy, 0);
    expect(init.method).toBe('PATCH');
    expect(url.pathname).toBe('/cloud/v2/universes/42');
    expect(url.searchParams.get('updateMask')).toBe(
      'voiceChatEnabled,privateServerPriceRobux,vrEnabled,twitterSocialLink,youtubeSocialLink',
    );
    expect(jsonBody(init)).toEqual({
      voiceChatEnabled: false,
      vrEnabled: true,
      youtubeSocialLink: { title: 'Channel', uri: 'https://youtube.com/x' },
    });
  });

  test('reads and patches a place', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({
        path: 'universes/42/places/100',
        displayName: 'Obby',
        description: 'Jump',
        serverSize: 20,
        root: true,
      }))
      .mockResolvedValueOnce(jsonResponse({}));

    const client = testClient();
    expect(await client.getPlace(42, 100)).toEqual({
      id: 100,
      universeId: 42,
      displayName: 'Obby',
      description: 'Jump',
      serverSize: 20,
      root: true,
    });
    await client.updatePlace(42, 100, { displayName: 'Mega Obby', serverSize: 30 });

    const { url, init } = requestAt(fetchSpy, 1);
    expect(init.method).toBe('PATCH');
    expect(url.pathname).toBe('/cloud/v2/universes/42/places/100');
    expect(url.searchParams.get('updateMask')).toBe('displayName,serverSize');
    expect(jsonBody(init)).toEqual({ displayName: 'Mega Obby', serverSize: 30 });
  });
});
