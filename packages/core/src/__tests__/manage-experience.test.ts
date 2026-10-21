import { BridgeService } from '../bridge-service.js';
import { OpenCloudRequestError } from '../opencloud-client.js';
import type {
  ExperiencePlace,
  ExperiencePlaceChanges,
  ExperienceUniverse,
  ExperienceUniverseChanges,
} from '../opencloud-client.js';
import { RobloxStudioTools } from './test-tools.js';

class ExperienceTestBridge extends BridgeService {
  protected override notifyPeerRegistered(): void {
    // Simulated topology must not mutate the local managed-Studio registry.
  }
}

function universe(overrides: Partial<ExperienceUniverse> = {}): ExperienceUniverse {
  return {
    id: 42,
    displayName: 'Obby',
    description: 'Jump',
    visibility: 'PUBLIC',
    ownerUserId: null,
    ownerGroupId: 7,
    ageRating: 'AGE_RATING_ALL',
    voiceChatEnabled: false,
    privateServerPriceRobux: null,
    devices: { desktop: true, mobile: true, tablet: true, console: false, vr: false },
    socialLinks: {},
    rootPlaceId: 100,
    ...overrides,
  };
}

function place(overrides: Partial<ExperiencePlace> = {}): ExperiencePlace {
  return {
    id: 100,
    universeId: 42,
    displayName: 'Obby',
    description: 'Jump',
    serverSize: 20,
    root: true,
    ...overrides,
  };
}

type FakeClient = {
  hasApiKey: jest.Mock<boolean, []>;
  getUniverse: jest.Mock<Promise<ExperienceUniverse>, [number]>;
  updateUniverse: jest.Mock<Promise<void>, [number, ExperienceUniverseChanges]>;
  getPlace: jest.Mock<Promise<ExperiencePlace>, [number, number]>;
  updatePlace: jest.Mock<Promise<void>, [number, number, ExperiencePlaceChanges]>;
  setUniverseActive: jest.Mock<Promise<void>, [number, boolean]>;
};

function fakeClient(): FakeClient {
  return {
    hasApiKey: jest.fn<boolean, []>(() => true),
    getUniverse: jest.fn<Promise<ExperienceUniverse>, [number]>(async () => universe()),
    updateUniverse: jest.fn<Promise<void>, [number, ExperienceUniverseChanges]>(async () => undefined),
    getPlace: jest.fn<Promise<ExperiencePlace>, [number, number]>(async () => place()),
    updatePlace: jest.fn<Promise<void>, [number, number, ExperiencePlaceChanges]>(async () => undefined),
    setUniverseActive: jest.fn<Promise<void>, [number, boolean]>(async () => undefined),
  };
}

function body(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const text = result.content[0]?.text;
  if (!text) throw new Error('Expected a text tool result');
  return JSON.parse(text) as Record<string, unknown>;
}

async function claimStudioRequest(bridge: BridgeService, transportPeerId: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const queued = bridge.claimNextRequestForTransport(transportPeerId, 'experience-test');
    if (queued) return queued;
    await Promise.resolve();
  }
  throw new Error('Expected a queued Studio request');
}

describe('manage_experience', () => {
  let bridge: BridgeService;
  let tools: RobloxStudioTools;
  let client: FakeClient;

  beforeEach(() => {
    bridge = new ExperienceTestBridge();
    tools = new RobloxStudioTools(bridge);
    client = fakeClient();
    (tools as unknown as { openCloudClient: object }).openCloudClient = client;
  });

  afterEach(() => {
    bridge.clearAllPendingRequests();
  });

  test('gets the universe and its root place as snake_case', async () => {
    const result = body(await tools.manageExperience({ action: 'get', universe_id: 42 }));

    expect(client.getPlace).toHaveBeenCalledWith(42, 100);
    expect(result).toEqual({
      universe: {
        universe_id: 42,
        name: 'Obby',
        description: 'Jump',
        visibility: 'public',
        owner: { group_id: 7 },
        age_rating: 'AGE_RATING_ALL',
        voice_chat_enabled: false,
        private_server_price: null,
        devices: { desktop: true, mobile: true, tablet: true, console: false, vr: false },
        social_links: {},
        root_place_id: 100,
      },
      place: {
        place_id: 100,
        universe_id: 42,
        name: 'Obby',
        description: 'Jump',
        server_size: 20,
        root: true,
      },
    });
  });

  test('defaults to the universe of the connected Studio place', async () => {
    expect(bridge.registerPeer({
      peerId: 'edit', transportPeerId: 'edit', instanceId: 'instance:obby',
      role: 'edit', placeId: 100, placeName: 'Obby',
    }).ok).toBe(true);

    const pending = tools.manageExperience({ action: 'get' }, 'instance:obby');
    const request = await claimStudioRequest(bridge, 'edit');
    expect(request.endpoint).toBe('/api/place-info');
    bridge.resolveRequest(request.requestId, { placeId: 100, gameId: 777 });

    await pending;
    expect(client.getUniverse).toHaveBeenCalledWith(777);
  });

  test('refuses an unpublished Studio place', async () => {
    expect(bridge.registerPeer({
      peerId: 'edit', transportPeerId: 'edit', instanceId: 'instance:local',
      role: 'edit', placeId: 0, placeName: 'Local',
    }).ok).toBe(true);

    const pending = tools.manageExperience({ action: 'get' });
    const request = await claimStudioRequest(bridge, 'edit');
    bridge.resolveRequest(request.requestId, { placeId: 0, gameId: 0 });

    expect(body(await pending)).toMatchObject({ error: 'unpublished_place' });
    expect(client.getUniverse).not.toHaveBeenCalled();
  });

  test('changes the experience title through the root place and reads it back', async () => {
    const result = body(await tools.manageExperience({
      action: 'update', universe_id: 42, name: '  Mega Obby ', description: '',
    }));

    expect(client.updateUniverse).not.toHaveBeenCalled();
    expect(client.updatePlace).toHaveBeenCalledWith(42, 100, { displayName: 'Mega Obby', description: '' });
    expect(result).toMatchObject({ updated: true, place: { place_id: 100 } });
  });

  test('edits an explicit place without looking up the root place', async () => {
    await tools.manageExperience({ action: 'update', universe_id: 42, place_id: 200, server_size: 50 });

    expect(client.updatePlace).toHaveBeenCalledWith(42, 200, { serverSize: 50 });
    expect(client.getUniverse).toHaveBeenCalledTimes(1);
  });

  test('sends universe settings, link removals, and disabled private servers', async () => {
    await tools.manageExperience({
      action: 'update',
      universe_id: 42,
      voice_chat_enabled: true,
      devices: { console: true, vr: false },
      social_links: [{ kind: 'discord', title: 'Server', uri: ' https://discord.gg/x ' }],
      remove_social_links: ['twitter'],
      disable_private_servers: true,
      confirm: true,
    });

    expect(client.updateUniverse).toHaveBeenCalledWith(42, {
      voiceChatEnabled: true,
      privateServerPriceRobux: null,
      devices: { console: true, vr: false },
      socialLinks: { discord: { title: 'Server', uri: 'https://discord.gg/x' }, twitter: null },
    });
    expect(client.updatePlace).not.toHaveBeenCalled();
  });

  test.each([
    [{ action: 'set_visibility', visibility: 'private' }, 'removes every player'],
    [{ action: 'update', private_server_price: 50 }, 'cancels every private server subscription'],
    [{ action: 'update', disable_private_servers: true }, 'shuts down every active private server'],
  ])('requires confirm for irreversible changes: %j', async (request, reason) => {
    const result = body(await tools.manageExperience({ ...request, universe_id: 42 }));

    expect(result).toMatchObject({ error: 'confirmation_required', message: expect.stringContaining(reason) });
    expect(client.updateUniverse).not.toHaveBeenCalled();
    expect(client.setUniverseActive).not.toHaveBeenCalled();
  });

  test('makes the experience public without confirm and reports the new visibility', async () => {
    client.getUniverse.mockResolvedValue(universe({ visibility: 'PUBLIC' }));

    const result = body(await tools.manageExperience({ action: 'set_visibility', universe_id: 42, visibility: 'public' }));

    expect(client.setUniverseActive).toHaveBeenCalledWith(42, true);
    expect(result).toMatchObject({ updated: true, universe: { visibility: 'public' } });
  });

  test('makes the experience private when confirmed', async () => {
    await tools.manageExperience({ action: 'set_visibility', universe_id: 42, visibility: 'private', confirm: true });

    expect(client.setUniverseActive).toHaveBeenCalledWith(42, false);
  });

  test('still reports success when the follow-up read fails', async () => {
    client.getUniverse.mockRejectedValue(new Error('read failed'));

    const result = body(await tools.manageExperience({ action: 'update', universe_id: 42, voice_chat_enabled: true }));

    expect(result).toEqual({
      updated: true,
      warnings: ['The update succeeded, but reading the experience back failed: read failed'],
    });
  });

  test('reports what was already applied when a later step fails', async () => {
    client.updatePlace.mockRejectedValue(new OpenCloudRequestError('Open Cloud API error (409): busy', 409));

    const result = body(await tools.manageExperience({
      action: 'update', universe_id: 42, name: 'New', voice_chat_enabled: true,
    }));

    expect(result).toMatchObject({
      error: 'conflict',
      applied: ['universe'],
      hint: expect.stringContaining('Team Create'),
    });
  });

  test('names the scopes a forbidden update needs', async () => {
    client.updatePlace.mockRejectedValue(new OpenCloudRequestError('API key lacks required permissions: no', 403));

    const result = body(await tools.manageExperience({ action: 'update', universe_id: 42, name: 'New' }));

    expect(result).toMatchObject({ error: 'forbidden', required_scopes: ['universe.place:write'] });
  });

  test('requires an Open Cloud API key and names the scopes it needs', async () => {
    client.hasApiKey.mockReturnValue(false);

    const result = body(await tools.manageExperience({ action: 'set_visibility', universe_id: 42, visibility: 'public' }));

    expect(result).toMatchObject({ error: 'missing_api_key', required_scopes: ['legacy-universe:manage'] });
    expect(client.setUniverseActive).not.toHaveBeenCalled();
  });

  test.each([
    [{ action: 'delete' }, 'action'],
    [{ action: 'get', universe_id: 0 }, 'universe_id'],
    [{ action: 'get', name: 'x' }, 'name'],
    [{ action: 'set_visibility', name: 'x', visibility: 'public' }, 'name'],
    [{ action: 'set_visibility' }, 'visibility'],
    [{ action: 'set_visibility', visibility: 'friends' }, 'visibility'],
    [{ action: 'update' }, 'update needs'],
    [{ action: 'update', name: '   ' }, 'name'],
    [{ action: 'update', server_size: 0 }, 'server_size'],
    [{ action: 'update', private_server_price: -1, confirm: true }, 'private_server_price'],
    [{ action: 'update', private_server_price: 5, disable_private_servers: true, confirm: true }, 'not both'],
    [{ action: 'update', disable_private_servers: false }, 'disable_private_servers'],
    [{ action: 'update', devices: { fridge: true } }, 'devices.fridge'],
    [{ action: 'update', devices: { vr: 'yes' } }, 'devices.vr'],
    [{ action: 'update', social_links: { discord: { uri: 'x' } } }, 'social_links must be an array'],
    [{ action: 'update', social_links: [{ kind: 'myspace', uri: 'x' }] }, 'kind'],
    [{ action: 'update', social_links: [{ kind: 'discord', title: 'x' }] }, 'discord uri'],
    [{ action: 'update', social_links: [{ kind: 'discord', uri: 'x' }, { kind: 'discord', uri: 'y' }] }, 'more than once'],
    [{ action: 'update', remove_social_links: ['myspace'] }, 'remove_social_links'],
    [{ action: 'update', social_links: [{ kind: 'discord', uri: 'x' }], remove_social_links: ['discord'] }, 'set and removed'],
  ])('rejects invalid arguments before calling Roblox: %j', async (request, field) => {
    const result = body(await tools.manageExperience({ universe_id: 42, ...request }));

    expect(result).toMatchObject({ error: 'invalid_argument', message: expect.stringContaining(field) });
    expect(client.getUniverse).not.toHaveBeenCalled();
    expect(client.updateUniverse).not.toHaveBeenCalled();
    expect(client.updatePlace).not.toHaveBeenCalled();
    expect(client.setUniverseActive).not.toHaveBeenCalled();
  });
});
