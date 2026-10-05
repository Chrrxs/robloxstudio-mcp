import { readRegularFileWithinLimit } from '../local-file.js';
import {
  OpenCloudRequestError,
  type MonetizationIcon,
  type MonetizationItem,
  type MonetizationItemChanges,
  type MonetizationItemPage,
  type MonetizationKind,
} from '../opencloud-client.js';

/** The Open Cloud surface manage_monetization needs; OpenCloudClient satisfies it. */
export interface MonetizationClient {
  hasApiKey(): boolean;
  listMonetizationItems(kind: MonetizationKind, universeId: number, pageToken?: string): Promise<MonetizationItemPage>;
  getMonetizationItem(kind: MonetizationKind, universeId: number, id: number): Promise<MonetizationItem>;
  createMonetizationItem(
    kind: MonetizationKind,
    universeId: number,
    item: MonetizationItemChanges & { name: string },
  ): Promise<MonetizationItem>;
  updateMonetizationItem(
    kind: MonetizationKind,
    universeId: number,
    id: number,
    changes: MonetizationItemChanges,
  ): Promise<void>;
}

export interface MonetizationContext {
  client: MonetizationClient;
  /** GameId of the connected Studio place; 0 when the place is unpublished. */
  connectedUniverseId(): Promise<number>;
}

type MonetizationAction = 'list' | 'get' | 'create' | 'update';

interface MonetizationRequest {
  action: MonetizationAction;
  kind: MonetizationKind;
  universeId?: number;
  id?: number;
  pageToken?: string;
  name?: string;
  description?: string;
  price?: number;
  forSale?: boolean;
  managedPricing?: boolean;
  imagePath?: string;
}

const MAX_PRICE_ROBUX = 1_000_000_000;
// 200 pages of 50 items; a universe beyond this is checked no further and nothing is created.
const MAX_NAME_SCAN_PAGES = 200;
// Roblox shows icons at 512x512, so a larger file is almost always the wrong file.
const MAX_ICON_BYTES = 10 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const SCOPE_PREFIX: Record<MonetizationKind, string> = {
  developer_product: 'developer-product',
  game_pass: 'game-pass',
};

// Arguments that only some actions accept. Rejecting the rest catches calls
// such as get with a price, which would otherwise silently change nothing.
const ACTION_FIELDS: Record<MonetizationAction, readonly string[]> = {
  list: ['page_token'],
  get: ['id'],
  create: ['name', 'description', 'price', 'for_sale', 'managed_pricing', 'image_path'],
  update: ['id', 'name', 'description', 'price', 'for_sale', 'managed_pricing', 'image_path'],
};
const ACTION_SCOPED_FIELDS = [
  'id', 'page_token', 'name', 'description', 'price', 'for_sale', 'managed_pricing', 'image_path',
];

/** An expected failure reported to the caller as a stable error code. */
class MonetizationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'MonetizationError';
  }
}

function invalidArgument(message: string): MonetizationError {
  return new MonetizationError('invalid_argument', message);
}

function isAction(value: unknown): value is MonetizationAction {
  return value === 'list' || value === 'get' || value === 'create' || value === 'update';
}

function isKind(value: unknown): value is MonetizationKind {
  return value === 'developer_product' || value === 'game_pass';
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
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_PRICE_ROBUX) {
    throw invalidArgument(`price must be a whole number of Robux from 1 to ${MAX_PRICE_ROBUX}.`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (!isPresent(value)) return undefined;
  if (typeof value !== 'string') throw invalidArgument(`${name} must be a string.`);
  return value;
}

// Rejects blank text but returns it unchanged, since a path may end in a space.
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

function parseRequest(request: Record<string, unknown>): MonetizationRequest {
  const { action, kind } = request;
  if (!isAction(action)) throw invalidArgument('action must be list, get, create, or update.');
  if (!isKind(kind)) throw invalidArgument('kind must be developer_product or game_pass.');
  for (const field of ACTION_SCOPED_FIELDS) {
    if (isPresent(request[field]) && !ACTION_FIELDS[action].includes(field)) {
      throw invalidArgument(`${field} is not used by action=${action}.`);
    }
  }

  const parsed: MonetizationRequest = {
    action,
    kind,
    universeId: optionalId(request.universe_id, 'universe_id'),
    id: optionalId(request.id, 'id'),
    pageToken: optionalNonBlankString(request.page_token, 'page_token'),
    name: optionalNonBlankString(request.name, 'name')?.trim(),
    description: optionalString(request.description, 'description'),
    price: optionalPrice(request.price),
    forSale: optionalBoolean(request.for_sale, 'for_sale'),
    managedPricing: optionalBoolean(request.managed_pricing, 'managed_pricing'),
    imagePath: optionalNonBlankString(request.image_path, 'image_path'),
  };
  if (action === 'get' || action === 'update') requiredId(parsed);
  if (action === 'create') {
    requiredName(parsed);
    if (parsed.forSale === true && parsed.price === undefined) {
      throw invalidArgument('price is required to create an item with for_sale=true.');
    }
  }
  if (action === 'update' && Object.keys(itemChanges(parsed)).length === 0 && parsed.imagePath === undefined) {
    throw invalidArgument(
      'update needs at least one of name, description, price, for_sale, managed_pricing, or image_path.',
    );
  }
  return parsed;
}

function requiredId(request: MonetizationRequest): number {
  if (request.id === undefined) throw invalidArgument(`id is required for action=${request.action}.`);
  return request.id;
}

function requiredName(request: MonetizationRequest): string {
  if (request.name === undefined) throw invalidArgument(`name is required for action=${request.action}.`);
  return request.name;
}

function itemChanges(request: MonetizationRequest): MonetizationItemChanges {
  return {
    ...(request.name !== undefined ? { name: request.name } : {}),
    ...(request.description !== undefined ? { description: request.description } : {}),
    ...(request.price !== undefined ? { price: request.price } : {}),
    ...(request.forSale !== undefined ? { forSale: request.forSale } : {}),
    ...(request.managedPricing !== undefined ? { managedPricing: request.managedPricing } : {}),
  };
}

function itemLabel(kind: MonetizationKind): string {
  return kind === 'developer_product' ? 'developer product' : 'game pass';
}

function comparableName(name: string): string {
  return name.trim().toLowerCase();
}

// Roblox cannot delete products or passes, so a duplicate created by a retry is permanent.
async function findItemNamed(
  client: MonetizationClient,
  kind: MonetizationKind,
  universeId: number,
  name: string,
): Promise<MonetizationItem | undefined> {
  const wanted = comparableName(name);
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_NAME_SCAN_PAGES; page++) {
    const result = await client.listMonetizationItems(kind, universeId, pageToken);
    const match = result.items.find((candidate) => comparableName(candidate.name) === wanted);
    if (match) return match;
    if (!result.nextPageToken) return undefined;
    pageToken = result.nextPageToken;
  }
  throw new MonetizationError(
    'duplicate_check_incomplete',
    `Stopped looking for an existing ${itemLabel(kind)} named "${name}" after ${MAX_NAME_SCAN_PAGES} pages, so nothing was created.`,
  );
}

function requiredScopes(request: MonetizationRequest): string[] {
  const prefix = SCOPE_PREFIX[request.kind];
  return request.action === 'list' || request.action === 'get'
    ? [`${prefix}:read`]
    : [`${prefix}:read`, `${prefix}:write`];
}

function publicItem(item: MonetizationItem): Record<string, unknown> {
  return {
    kind: item.kind,
    id: item.id,
    universe_id: item.universeId,
    name: item.name,
    description: item.description,
    for_sale: item.forSale,
    price: item.price,
    managed_pricing: item.managedPricing,
    icon_asset_id: item.iconAssetId,
    ...(item.createdAt !== undefined ? { created_at: item.createdAt } : {}),
    ...(item.updatedAt !== undefined ? { updated_at: item.updatedAt } : {}),
    ...(item.immutable !== undefined ? { immutable: item.immutable } : {}),
  };
}

async function resolveUniverse(request: MonetizationRequest, context: MonetizationContext): Promise<number> {
  if (request.universeId !== undefined) return request.universeId;
  const universeId = await context.connectedUniverseId();
  if (!Number.isSafeInteger(universeId) || universeId <= 0) {
    throw new MonetizationError(
      'unpublished_place',
      'The connected Studio place is not published, so it has no universe. Publish it or pass universe_id.',
    );
  }
  return universeId;
}

function iconType(data: Buffer): { mimeType: MonetizationIcon['mimeType']; extension: string } | undefined {
  if (data.length >= PNG_SIGNATURE.length && data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) {
    return { mimeType: 'image/bmp', extension: 'bmp' };
  }
  return undefined;
}

// The file's bytes, not its extension, decide the upload type.
function readIcon(imagePath: string): MonetizationIcon {
  let data: Buffer;
  try {
    data = readRegularFileWithinLimit(imagePath, 'image_path', (byteLength) => {
      if (byteLength > MAX_ICON_BYTES) {
        throw new Error(`image_path is ${byteLength} bytes; icons are limited to ${MAX_ICON_BYTES} bytes.`);
      }
    });
  } catch (error) {
    throw invalidArgument(error instanceof Error ? error.message : String(error));
  }
  const type = iconType(data);
  if (!type) throw invalidArgument('image_path must be a PNG, JPEG, or BMP file.');
  return { data, fileName: `icon.${type.extension}`, mimeType: type.mimeType };
}

async function runAction(
  request: MonetizationRequest,
  universeId: number,
  client: MonetizationClient,
  icon: MonetizationIcon | undefined,
): Promise<Record<string, unknown>> {
  const { kind } = request;
  const changes: MonetizationItemChanges = { ...itemChanges(request), ...(icon ? { icon } : {}) };
  switch (request.action) {
    case 'list': {
      const page = await client.listMonetizationItems(kind, universeId, request.pageToken);
      return {
        kind,
        universe_id: universeId,
        items: page.items.map(publicItem),
        ...(page.nextPageToken ? { next_page_token: page.nextPageToken } : {}),
      };
    }
    case 'get':
      return { item: publicItem(await client.getMonetizationItem(kind, universeId, requiredId(request))) };
    case 'create': {
      const name = requiredName(request);
      const existing = await findItemNamed(client, kind, universeId, name);
      if (existing) {
        throw new MonetizationError(
          'duplicate_name',
          `A ${itemLabel(kind)} named "${existing.name}" already exists in universe ${universeId}. Update it or choose another name.`,
          { existing: publicItem(existing) },
        );
      }
      const created = await client.createMonetizationItem(kind, universeId, {
        ...changes,
        name,
        forSale: request.forSale ?? false,
      });
      return { created: true, item: publicItem(created) };
    }
    case 'update': {
      const id = requiredId(request);
      await client.updateMonetizationItem(kind, universeId, id, changes);
      try {
        return { updated: true, item: publicItem(await client.getMonetizationItem(kind, universeId, id)) };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
          updated: true,
          item: null,
          warnings: [`The update succeeded, but reading the item back failed: ${reason}`],
        };
      }
    }
  }
}

/** Maps an Open Cloud HTTP failure to a stable error code with recovery hints. */
function openCloudFailure(error: OpenCloudRequestError, request: MonetizationRequest): Record<string, unknown> {
  const { message, status } = error;
  switch (status) {
    case 401:
      return { error: 'unauthorized', message, hint: 'Check ROBLOX_OPEN_CLOUD_API_KEY.' };
    case 403:
      return {
        error: 'forbidden',
        message,
        required_scopes: requiredScopes(request),
        hint: 'Grant these scopes to the API key and add this experience to it.',
      };
    case 404:
      return { error: 'not_found', message, hint: 'Check id, kind, and universe_id.' };
    case 409:
      return { error: 'conflict', message };
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

/** Runs one manage_monetization call and returns its JSON result body. */
export async function runManageMonetization(
  request: Record<string, unknown>,
  context: MonetizationContext,
): Promise<Record<string, unknown>> {
  let parsed: MonetizationRequest | undefined;
  try {
    parsed = parseRequest(request);
    if (!context.client.hasApiKey()) {
      const scopes = requiredScopes(parsed);
      throw new MonetizationError(
        'missing_api_key',
        `ROBLOX_OPEN_CLOUD_API_KEY is not set. Create an Open Cloud API key with ${scopes.join(' and ')} for this experience.`,
        { required_scopes: scopes },
      );
    }
    // Local input errors should surface before Studio or Roblox is contacted.
    const icon = parsed.imagePath === undefined ? undefined : readIcon(parsed.imagePath);
    const universeId = await resolveUniverse(parsed, context);
    return await runAction(parsed, universeId, context.client, icon);
  } catch (error) {
    if (error instanceof MonetizationError) {
      return { error: error.code, message: error.message, ...error.details };
    }
    if (error instanceof OpenCloudRequestError && parsed) return openCloudFailure(error, parsed);
    throw error;
  }
}
