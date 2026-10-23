import {
  EXPERIENCE_DEVICES,
  OpenCloudRequestError,
  SOCIAL_LINK_KINDS,
  type ExperienceDevice,
  type ExperiencePlace,
  type ExperiencePlaceChanges,
  type ExperienceUniverse,
  type ExperienceUniverseChanges,
  type SocialLink,
  type SocialLinkKind,
} from '../opencloud-client.js';

/** The Open Cloud surface manage_experience needs; OpenCloudClient satisfies it. */
export interface ExperienceClient {
  hasApiKey(): boolean;
  getUniverse(universeId: number): Promise<ExperienceUniverse>;
  updateUniverse(universeId: number, changes: ExperienceUniverseChanges): Promise<void>;
  getPlace(universeId: number, placeId: number): Promise<ExperiencePlace>;
  updatePlace(universeId: number, placeId: number, changes: ExperiencePlaceChanges): Promise<void>;
}

export interface ExperienceContext {
  client: ExperienceClient;
  /** GameId of the connected Studio place; 0 when the place is unpublished. */
  connectedUniverseId(): Promise<number>;
}

type ExperienceAction = 'get' | 'update';

interface ExperienceRequest {
  action: ExperienceAction;
  universeId?: number;
  placeId?: number;
  universe: ExperienceUniverseChanges;
  place: ExperiencePlaceChanges;
  confirm: boolean;
}

const MAX_PRICE_ROBUX = 1_000_000_000;

// Arguments that only some actions accept. Rejecting the rest catches calls
// such as get with a name, which would otherwise silently change nothing.
const ACTION_FIELDS: Record<ExperienceAction, readonly string[]> = {
  get: ['place_id'],
  update: [
    'place_id', 'name', 'description', 'server_size', 'voice_chat_enabled', 'private_server_price',
    'disable_private_servers', 'devices', 'social_links', 'remove_social_links', 'confirm',
  ],
};
const ACTION_SCOPED_FIELDS = [...new Set(Object.values(ACTION_FIELDS).flat())];

/** An expected failure reported to the caller as a stable error code. */
class ExperienceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ExperienceError';
  }
}

function invalidArgument(message: string): ExperienceError {
  return new ExperienceError('invalid_argument', message);
}

function isAction(value: unknown): value is ExperienceAction {
  return value === 'get' || value === 'update';
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function optionalId(value: unknown, name: string): number | undefined {
  if (!isPresent(value)) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw invalidArgument(`${name} must be a positive whole number.`);
  }
  return value;
}

function optionalPrice(value: unknown): number | undefined {
  if (!isPresent(value)) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_PRICE_ROBUX) {
    throw invalidArgument(`private_server_price must be a whole number of Robux from 0 to ${MAX_PRICE_ROBUX}.`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (!isPresent(value)) return undefined;
  if (typeof value !== 'string') throw invalidArgument(`${name} must be a string.`);
  return value;
}

function optionalNonBlankString(value: unknown, name: string): string | undefined {
  const text = optionalString(value, name);
  if (text !== undefined && text.trim() === '') throw invalidArgument(`${name} must not be empty.`);
  return text;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (!isPresent(value)) return undefined;
  if (typeof value !== 'boolean') throw invalidArgument(`${name} must be true or false.`);
  return value;
}

function isDevice(value: string): value is ExperienceDevice {
  return (EXPERIENCE_DEVICES as readonly string[]).includes(value);
}

function isSocialLinkKind(value: unknown): value is SocialLinkKind {
  return typeof value === 'string' && (SOCIAL_LINK_KINDS as readonly string[]).includes(value);
}

function parseDevices(value: unknown): Partial<Record<ExperienceDevice, boolean>> | undefined {
  if (!isPresent(value)) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidArgument('devices must be an object of device names to true or false.');
  }
  const devices: Partial<Record<ExperienceDevice, boolean>> = {};
  const entries: Array<[string, unknown]> = Object.entries(value);
  for (const [device, enabled] of entries) {
    if (!isDevice(device)) throw invalidArgument(`devices.${device} is not one of ${EXPERIENCE_DEVICES.join(', ')}.`);
    const parsed = optionalBoolean(enabled, `devices.${device}`);
    if (parsed !== undefined) devices[device] = parsed;
  }
  return devices;
}

function parseSocialLink(entry: unknown): { kind: SocialLinkKind; link: SocialLink } {
  if (
    typeof entry !== 'object' || entry === null || Array.isArray(entry)
    || !('kind' in entry) || !isSocialLinkKind(entry.kind)
  ) {
    throw invalidArgument(`social_links entries need a kind from ${SOCIAL_LINK_KINDS.join(', ')}.`);
  }
  const kind = entry.kind;
  const uri = optionalNonBlankString('uri' in entry ? entry.uri : undefined, `social_links ${kind} uri`);
  if (uri === undefined) throw invalidArgument(`social_links ${kind} uri is required.`);
  const title = optionalString('title' in entry ? entry.title : undefined, `social_links ${kind} title`) ?? '';
  return { kind, link: { title, uri: uri.trim() } };
}

function parseSocialLinks(value: unknown, removals: unknown): Partial<Record<SocialLinkKind, SocialLink | null>> {
  const links: Partial<Record<SocialLinkKind, SocialLink | null>> = {};
  if (isPresent(value)) {
    if (!Array.isArray(value)) throw invalidArgument('social_links must be an array of { kind, title, uri }.');
    for (const entry of value) {
      const { kind, link } = parseSocialLink(entry);
      if (links[kind]) throw invalidArgument(`social_links lists ${kind} more than once.`);
      links[kind] = link;
    }
  }
  if (isPresent(removals)) {
    if (!Array.isArray(removals)) throw invalidArgument('remove_social_links must be an array of link kinds.');
    for (const kind of removals) {
      if (!isSocialLinkKind(kind)) {
        throw invalidArgument(`remove_social_links entries must be one of ${SOCIAL_LINK_KINDS.join(', ')}.`);
      }
      if (links[kind]) throw invalidArgument(`${kind} cannot be set and removed in one call.`);
      links[kind] = null;
    }
  }
  return links;
}

function parseUniverseChanges(request: Record<string, unknown>): ExperienceUniverseChanges {
  const price = optionalPrice(request.private_server_price);
  const disable = optionalBoolean(request.disable_private_servers, 'disable_private_servers');
  if (disable === false) {
    throw invalidArgument('disable_private_servers only accepts true; set private_server_price to enable them.');
  }
  if (disable && price !== undefined) {
    throw invalidArgument('Pass either private_server_price or disable_private_servers, not both.');
  }
  const voiceChatEnabled = optionalBoolean(request.voice_chat_enabled, 'voice_chat_enabled');
  const devices = parseDevices(request.devices);
  const socialLinks = parseSocialLinks(request.social_links, request.remove_social_links);
  return {
    ...(voiceChatEnabled !== undefined ? { voiceChatEnabled } : {}),
    ...(price !== undefined ? { privateServerPriceRobux: price } : {}),
    ...(disable ? { privateServerPriceRobux: null } : {}),
    ...(devices && Object.keys(devices).length > 0 ? { devices } : {}),
    ...(Object.keys(socialLinks).length > 0 ? { socialLinks } : {}),
  };
}

function parsePlaceChanges(request: Record<string, unknown>): ExperiencePlaceChanges {
  const displayName = optionalNonBlankString(request.name, 'name')?.trim();
  const description = optionalString(request.description, 'description');
  const serverSize = optionalId(request.server_size, 'server_size');
  return {
    ...(displayName !== undefined ? { displayName } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(serverSize !== undefined ? { serverSize } : {}),
  };
}

function hasChanges(changes: object): boolean {
  return Object.keys(changes).length > 0;
}

// Setting any private server price cancels existing subscriptions, and
// disabling private servers shuts down running ones; neither can be undone.
function confirmationReason(request: ExperienceRequest): string | undefined {
  if (request.universe.privateServerPriceRobux === null) {
    return 'Disabling private servers shuts down every active private server.';
  }
  if (request.universe.privateServerPriceRobux !== undefined) {
    return 'Setting the private server price cancels every existing private server subscription.';
  }
  return undefined;
}

function parseRequest(request: Record<string, unknown>): ExperienceRequest {
  const { action } = request;
  // Open Cloud ignores visibility in universe updates, and in live testing the
  // legacy endpoint made an experience private but refused to make it public
  // again. A tool that can only go private could take a game down for good.
  if (action === 'set_visibility' || isPresent(request.visibility)) {
    throw new ExperienceError(
      'visibility_not_supported',
      'manage_experience cannot make an experience public or private. Open Cloud ignores visibility changes, and '
        + "Roblox can refuse to make an experience public through an API key. Use Creator Hub or Studio's Game Settings.",
    );
  }
  if (!isAction(action)) throw invalidArgument('action must be get or update.');
  for (const field of ACTION_SCOPED_FIELDS) {
    if (isPresent(request[field]) && !ACTION_FIELDS[action].includes(field)) {
      throw invalidArgument(`${field} is not used by action=${action}.`);
    }
  }

  const parsed: ExperienceRequest = {
    action,
    universeId: optionalId(request.universe_id, 'universe_id'),
    placeId: optionalId(request.place_id, 'place_id'),
    universe: parseUniverseChanges(request),
    place: parsePlaceChanges(request),
    confirm: optionalBoolean(request.confirm, 'confirm') === true,
  };
  if (action === 'update' && !hasChanges(parsed.universe) && !hasChanges(parsed.place)) {
    throw invalidArgument(
      'update needs at least one of name, description, server_size, voice_chat_enabled, private_server_price, '
      + 'disable_private_servers, devices, social_links, or remove_social_links.',
    );
  }
  const reason = confirmationReason(parsed);
  if (reason && !parsed.confirm) {
    throw new ExperienceError('confirmation_required', `${reason} Repeat the call with confirm=true to proceed.`);
  }
  return parsed;
}

function requiredScopes(request: ExperienceRequest): string[] {
  switch (request.action) {
    case 'get':
      return [];
    case 'update':
      return [
        ...(hasChanges(request.universe) ? ['universe:write'] : []),
        ...(hasChanges(request.place) ? ['universe.place:write'] : []),
      ];
  }
}

function publicUniverse(universe: ExperienceUniverse): Record<string, unknown> {
  return {
    universe_id: universe.id,
    name: universe.displayName,
    description: universe.description,
    visibility: universe.visibility.toLowerCase(),
    owner: universe.ownerGroupId !== null ? { group_id: universe.ownerGroupId } : { user_id: universe.ownerUserId },
    age_rating: universe.ageRating,
    voice_chat_enabled: universe.voiceChatEnabled,
    private_server_price: universe.privateServerPriceRobux,
    devices: universe.devices,
    social_links: universe.socialLinks,
    root_place_id: universe.rootPlaceId,
    ...(universe.createdAt !== undefined ? { created_at: universe.createdAt } : {}),
    ...(universe.updatedAt !== undefined ? { updated_at: universe.updatedAt } : {}),
  };
}

function publicPlace(place: ExperiencePlace): Record<string, unknown> {
  return {
    place_id: place.id,
    universe_id: place.universeId,
    name: place.displayName,
    description: place.description,
    server_size: place.serverSize,
    root: place.root,
    ...(place.createdAt !== undefined ? { created_at: place.createdAt } : {}),
    ...(place.updatedAt !== undefined ? { updated_at: place.updatedAt } : {}),
  };
}

async function resolveUniverse(request: ExperienceRequest, context: ExperienceContext): Promise<number> {
  if (request.universeId !== undefined) return request.universeId;
  const universeId = await context.connectedUniverseId();
  if (!Number.isSafeInteger(universeId) || universeId <= 0) {
    throw new ExperienceError(
      'unpublished_place',
      'The connected Studio place is not published, so it has no universe. Publish it or pass universe_id.',
    );
  }
  return universeId;
}

function rootPlaceId(universe: ExperienceUniverse): number {
  if (universe.rootPlaceId === null) {
    throw new ExperienceError('no_root_place', `Universe ${universe.id} has no root place. Pass place_id.`);
  }
  return universe.rootPlaceId;
}

interface ExperienceSnapshot {
  universe: ExperienceUniverse;
  place: ExperiencePlace;
}

// Title and description live on the root place, so place_id defaults to it.
async function readExperience(
  client: ExperienceClient,
  universeId: number,
  placeId: number | undefined,
): Promise<ExperienceSnapshot> {
  const universe = await client.getUniverse(universeId);
  const place = await client.getPlace(universeId, placeId ?? rootPlaceId(universe));
  return { universe, place };
}

function publicExperience({ universe, place }: ExperienceSnapshot): Record<string, unknown> {
  return { universe: publicUniverse(universe), place: publicPlace(place) };
}

// Roblox stores social link URLs in a canonical form, for example without www.
function linkTarget(uri: string): string {
  try {
    const url = new URL(uri);
    return `${url.hostname.toLowerCase().replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}${url.search}`;
  } catch {
    return uri;
  }
}

/** Requested changes that the read-back does not show, by argument name. */
function unconfirmedFields({ universe, place }: ExperienceSnapshot, request: ExperienceRequest): string[] {
  const fields: string[] = [];
  const check = (field: string, confirmed: boolean) => {
    if (!confirmed) fields.push(field);
  };
  const { place: placeChanges, universe: universeChanges } = request;
  if (placeChanges.displayName !== undefined) check('name', place.displayName === placeChanges.displayName);
  if (placeChanges.description !== undefined) check('description', place.description === placeChanges.description);
  if (placeChanges.serverSize !== undefined) check('server_size', place.serverSize === placeChanges.serverSize);
  if (universeChanges.voiceChatEnabled !== undefined) {
    check('voice_chat_enabled', universe.voiceChatEnabled === universeChanges.voiceChatEnabled);
  }
  if (universeChanges.privateServerPriceRobux !== undefined) {
    check('private_server_price', universe.privateServerPriceRobux === universeChanges.privateServerPriceRobux);
  }
  for (const device of EXPERIENCE_DEVICES) {
    const enabled = universeChanges.devices?.[device];
    if (enabled !== undefined) check(`devices.${device}`, universe.devices[device] === enabled);
  }
  for (const kind of SOCIAL_LINK_KINDS) {
    const link = universeChanges.socialLinks?.[kind];
    if (link === undefined) continue;
    const current = universe.socialLinks[kind];
    check(`social_links.${kind}`, link === null
      ? current === undefined
      : current !== undefined && linkTarget(current.uri) === linkTarget(link.uri) && current.title === link.title);
  }
  return fields;
}

async function readBack(
  client: ExperienceClient,
  universeId: number,
  placeId: number | undefined,
  request: ExperienceRequest,
): Promise<Record<string, unknown>> {
  let snapshot: ExperienceSnapshot;
  try {
    snapshot = await readExperience(client, universeId, placeId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { updated: true, warnings: [`The update succeeded, but reading the experience back failed: ${reason}`] };
  }
  // Open Cloud reads can briefly return values from before a write. Saying so
  // keeps a caller from retrying a change, such as a price, that already applied.
  const unconfirmed = unconfirmedFields(snapshot, request);
  const warnings = unconfirmed.length > 0
    ? [`Roblox accepted the update, but reading it back still shows different values for ${unconfirmed.join(', ')}. `
      + 'Reads can lag a few seconds behind writes; check with action=get before retrying.']
    : [];
  return { updated: true, ...publicExperience(snapshot), ...(warnings.length > 0 ? { warnings } : {}) };
}

type ExperienceStep = 'read' | 'place' | 'universe';

/** How far a call got, so a failure can name the step that failed and what already changed. */
interface ExperienceProgress {
  step: ExperienceStep;
  applied: string[];
}

const STEP_SCOPES: Record<ExperienceStep, readonly string[]> = {
  read: [],
  place: ['universe.place:write'],
  universe: ['universe:write'],
};

async function runAction(
  request: ExperienceRequest,
  universeId: number,
  client: ExperienceClient,
  progress: ExperienceProgress,
): Promise<Record<string, unknown>> {
  switch (request.action) {
    case 'get':
      return publicExperience(await readExperience(client, universeId, request.placeId));
    case 'update': {
      // Resolve the root place before changing anything, so a failed lookup leaves nothing half-applied.
      const placeId = hasChanges(request.place)
        ? request.placeId ?? rootPlaceId(await client.getUniverse(universeId))
        : request.placeId;
      // The place goes first: Roblox refuses it during Team Create, and the
      // universe step can cancel private server subscriptions for good.
      if (placeId !== undefined && hasChanges(request.place)) {
        progress.step = 'place';
        await client.updatePlace(universeId, placeId, request.place);
        progress.applied.push('place');
      }
      if (hasChanges(request.universe)) {
        progress.step = 'universe';
        await client.updateUniverse(universeId, request.universe);
        progress.applied.push('universe');
      }
      return readBack(client, universeId, placeId, request);
    }
  }
}

/** Maps an Open Cloud HTTP failure to a stable error code with recovery hints. */
function openCloudFailure(error: OpenCloudRequestError, step: ExperienceStep): Record<string, unknown> {
  const { message, status } = error;
  switch (status) {
    case 401:
      return { error: 'unauthorized', message, hint: 'Check ROBLOX_OPEN_CLOUD_API_KEY.' };
    case 403: {
      const scopes = STEP_SCOPES[step];
      return {
        error: 'forbidden',
        message,
        ...(scopes.length > 0 ? { required_scopes: scopes } : {}),
        hint: scopes.length > 0
          ? 'Grant these scopes to the API key and add this experience to it.'
          : 'Add this experience to the API key.',
      };
    }
    case 404:
      return { error: 'not_found', message, hint: 'Check universe_id and place_id.' };
    case 409:
      return step === 'place'
        ? {
          error: 'conflict',
          message,
          hint: 'Roblox refuses place edits while the place is open in an active Team Create session, '
            + 'including one in the connected Studio. Close the place in every Studio that has it open, then retry.',
        }
        : { error: 'conflict', message };
    case 429:
      return { error: 'rate_limited', message, hint: 'Wait before retrying.' };
    default: {
      if (status >= 400 && status < 500) {
        const { field, hint } = error.details;
        return { error: 'invalid_request', message, ...(field ? { field } : {}), ...(hint ? { hint } : {}) };
      }
      return { error: 'open_cloud_error', message, status };
    }
  }
}

/** Runs one manage_experience call and returns its JSON result body. */
export async function runManageExperience(
  request: Record<string, unknown>,
  context: ExperienceContext,
): Promise<Record<string, unknown>> {
  const progress: ExperienceProgress = { step: 'read', applied: [] };
  try {
    const parsed = parseRequest(request);
    if (!context.client.hasApiKey()) {
      const scopes = requiredScopes(parsed);
      throw new ExperienceError(
        'missing_api_key',
        `ROBLOX_OPEN_CLOUD_API_KEY is not set. Create an Open Cloud API key${
          scopes.length > 0 ? ` with ${scopes.join(' and ')}` : ''
        } for this experience.`,
        scopes.length > 0 ? { required_scopes: scopes } : {},
      );
    }
    const universeId = await resolveUniverse(parsed, context);
    return await runAction(parsed, universeId, context.client, progress);
  } catch (error) {
    const partial = progress.applied.length > 0 ? { applied: progress.applied } : {};
    if (error instanceof ExperienceError) {
      return { error: error.code, message: error.message, ...error.details, ...partial };
    }
    if (error instanceof OpenCloudRequestError) return { ...openCloudFailure(error, progress.step), ...partial };
    throw error;
  }
}
