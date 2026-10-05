export interface OpenCloudConfig {
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
}

export type CreatorStoreSearchCategory =
  | 'Audio'
  | 'Model'
  | 'Decal'
  | 'Plugin'
  | 'MeshPart'
  | 'Video'
  | 'FontFamily';

export interface AssetSearchParams {
  searchCategoryType: CreatorStoreSearchCategory;
  query?: string;
  pageToken?: string;
  pageNumber?: number;
  maxPageSize?: number;
  sortDirection?: 'None' | 'Ascending' | 'Descending';
  sortCategory?: 'Relevance' | 'Trending' | 'Top' | 'AudioDuration' | 'CreateTime' | 'UpdatedTime' | 'Ratings';
  userId?: number;
  groupId?: number;
}

export interface CreatorInfo {
  userId?: number;
  groupId?: number;
  name?: string;
  verified?: boolean;
}

export interface VotingInfo {
  showVotes: boolean;
  upVotes: number;
  downVotes: number;
  canVote: boolean;
  voteCount: number;
  upVotePercent: number;
}

export interface AssetInfo {
  id: number;
  textureId?: number;
  name: string;
  description?: string;
  assetTypeId?: number;
  durationSeconds?: number;
  createTime?: string;
  updateTime?: string;
  categoryPath?: string;
}

export interface CreatorStoreAsset {
  voting?: VotingInfo;
  creator?: CreatorInfo;
  asset?: AssetInfo;
  creatorStoreProduct?: {
    purchasable: boolean;
    purchasePrice?: {
      currencyCode: string;
      quantity: {
        significand: number;
        exponent: number;
      };
    };
  };
}

export interface AssetSearchResponse {
  nextPageToken?: string;
  creatorStoreAssets: CreatorStoreAsset[];
  totalResults: number;
  filteredKeyword?: string;
}

export interface ThumbnailResponse {
  targetId: number;
  state: 'Completed' | 'Pending' | 'Error' | 'Blocked';
  imageUrl?: string;
}

export type AssetType = 'Audio' | 'Decal' | 'Model' | 'Animation' | 'Video';

export interface AssetUploadRequest {
  assetType: AssetType;
  displayName: string;
  description: string;
  creationContext: {
    creator: {
      userId?: string;
      groupId?: string;
    };
  };
}

export interface AssetOperationResponse {
  path: string;
  done: boolean;
  response?: {
    '@type': string;
    assetId: string;
    displayName: string;
    assetType: string;
    revisionId?: string;
    revisionCreateTime?: string;
  };
  error?: {
    code: number;
    message: string;
  };
}

export interface AssetVersionInfo {
  path: string;
  createTime?: string;
  creationContext?: {
    creator?: {
      userId?: string;
      groupId?: string;
    };
  };
  moderationResult?: {
    moderationState?: string;
  };
  published?: boolean;
}

export interface AssetVersionsResponse {
  assetVersions: AssetVersionInfo[];
  nextPageToken?: string;
}

export interface DownloadedAudioAsset {
  data: Buffer;
  mimeType: 'audio/mpeg' | 'audio/ogg' | 'audio/wav' | 'audio/flac';
}

export type MonetizationKind = 'developer_product' | 'game_pass';

/** One developer product or game pass, normalized across both Open Cloud APIs. */
export interface MonetizationItem {
  kind: MonetizationKind;
  id: number;
  universeId: number;
  name: string;
  description: string;
  forSale: boolean;
  /** Default price in Robux; null when Roblox reports no price. */
  price: number | null;
  managedPricing: boolean;
  iconAssetId: number | null;
  createdAt?: string;
  updatedAt?: string;
  /** Developer products only: Roblox refuses edits to immutable products. */
  immutable?: boolean;
}

export interface MonetizationItemPage {
  items: MonetizationItem[];
  nextPageToken?: string;
}

export interface MonetizationIcon {
  data: Buffer;
  fileName: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/bmp';
}

/** Fields sent to Roblox; omitted fields keep their current values on update. */
export interface MonetizationItemChanges {
  name?: string;
  description?: string;
  price?: number;
  forSale?: boolean;
  managedPricing?: boolean;
  icon?: MonetizationIcon;
}

interface MonetizationApi {
  label: string;
  collectionPath(universeId: number): string;
  listField: string;
  idField: string;
  iconField: string;
}

// The developer product and game pass APIs differ only in paths and field names.
const MONETIZATION_APIS: Record<MonetizationKind, MonetizationApi> = {
  developer_product: {
    label: 'developer product',
    collectionPath: (universeId) => `/developer-products/v2/universes/${universeId}/developer-products`,
    listField: 'developerProducts',
    idField: 'productId',
    iconField: 'iconImageAssetId',
  },
  game_pass: {
    label: 'game pass',
    collectionPath: (universeId) => `/game-passes/v1/universes/${universeId}/game-passes`,
    listField: 'gamePasses',
    idField: 'gamePassId',
    iconField: 'iconAssetId',
  },
};

function readField(source: unknown, key: string): unknown {
  return typeof source === 'object' && source !== null ? Reflect.get(source, key) : undefined;
}

function positiveSafeInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeMonetizationItem(
  kind: MonetizationKind,
  universeId: number,
  value: unknown,
): MonetizationItem {
  const api = MONETIZATION_APIS[kind];
  const id = positiveSafeInteger(readField(value, api.idField));
  if (id === undefined) {
    throw new Error(`Open Cloud returned a ${api.label} without a valid ${api.idField}.`);
  }
  const name = readField(value, 'name');
  const description = readField(value, 'description');
  const price = readField(readField(value, 'priceInformation'), 'defaultPriceInRobux');
  const createdAt = readField(value, 'createdTimestamp');
  const updatedAt = readField(value, 'updatedTimestamp');
  const immutable = readField(value, 'isImmutable');
  return {
    kind,
    id,
    universeId: positiveSafeInteger(readField(value, 'universeId')) ?? universeId,
    name: typeof name === 'string' ? name : '',
    description: typeof description === 'string' ? description : '',
    forSale: readField(value, 'isForSale') === true,
    price: typeof price === 'number' && Number.isSafeInteger(price) && price >= 0 ? price : null,
    managedPricing: readField(value, 'isManagedPricingEnabled') === true,
    iconAssetId: positiveSafeInteger(readField(value, api.iconField)) ?? null,
    ...(typeof createdAt === 'string' ? { createdAt } : {}),
    ...(typeof updatedAt === 'string' ? { updatedAt } : {}),
    ...(kind === 'developer_product' && typeof immutable === 'boolean' ? { immutable } : {}),
  };
}

type AssetDeliveryResponse = {
  location?: string;
  errors?: Array<{
    code?: number;
    message?: string;
  }>;
};

function detectAudioMimeType(
  data: Buffer,
): DownloadedAudioAsset['mimeType'] | undefined {
  if (data.length >= 4 && data.subarray(0, 4).toString('ascii') === 'OggS') {
    return 'audio/ogg';
  }
  if (data.length >= 4 && data.subarray(0, 4).toString('ascii') === 'fLaC') {
    return 'audio/flac';
  }
  if (
    data.length >= 12
    && data.subarray(0, 4).toString('ascii') === 'RIFF'
    && data.subarray(8, 12).toString('ascii') === 'WAVE'
  ) {
    return 'audio/wav';
  }
  if (
    data.length >= 3
    && (
      data.subarray(0, 3).toString('ascii') === 'ID3'
      || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)
    )
  ) {
    return 'audio/mpeg';
  }
  return undefined;
}

export interface OpenCloudErrorDetails {
  errorCode?: string | number;
  field?: string;
  hint?: string;
}

/** A non-2xx Open Cloud response; messages keep the client's established wording. */
export class OpenCloudRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: OpenCloudErrorDetails = {},
  ) {
    super(message);
    this.name = 'OpenCloudRequestError';
  }
}

async function openCloudResponseError(response: Response): Promise<OpenCloudRequestError> {
  const errorBody = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(errorBody);
  } catch {
    parsed = undefined;
  }
  const text = (key: string): string | undefined => {
    const value = readField(parsed, key);
    return typeof value === 'string' && value ? value : undefined;
  };
  // Most Open Cloud APIs use detail or message; monetization APIs use errorMessage.
  const errorMessage = text('detail') ?? text('message') ?? text('errorMessage') ?? errorBody;
  const errorCode = readField(parsed, 'errorCode');
  const field = text('field');
  const hint = text('hint');
  const details: OpenCloudErrorDetails = {
    ...(typeof errorCode === 'string' || typeof errorCode === 'number' ? { errorCode } : {}),
    ...(field ? { field } : {}),
    ...(hint ? { hint } : {}),
  };

  const { status } = response;
  let message: string;
  if (status === 401) {
    message = 'Invalid or expired API key';
  } else if (status === 403) {
    message = `API key lacks required permissions: ${errorMessage}`;
  } else if (status === 429) {
    message = 'Rate limit exceeded. Please try again later.';
  } else {
    message = `Open Cloud API error (${status}): ${errorMessage}`;
  }
  return new OpenCloudRequestError(message, status, details);
}

function monetizationForm(changes: MonetizationItemChanges): FormData {
  const form = new FormData();
  if (changes.name !== undefined) form.append('name', changes.name);
  if (changes.description !== undefined) form.append('description', changes.description);
  if (changes.price !== undefined) form.append('price', String(changes.price));
  if (changes.forSale !== undefined) form.append('isForSale', String(changes.forSale));
  if (changes.managedPricing !== undefined) {
    form.append('isManagedPricingEnabled', String(changes.managedPricing));
  }
  if (changes.icon) {
    form.append(
      'imageFile',
      new Blob([new Uint8Array(changes.icon.data)], { type: changes.icon.mimeType }),
      changes.icon.fileName,
    );
  }
  return form;
}

export class OpenCloudClient {
  private apiKey: string;
  private baseUrl: string;
  private timeout: number;

  constructor(config: OpenCloudConfig = {}) {
    this.apiKey = config.apiKey || process.env.ROBLOX_OPEN_CLOUD_API_KEY || '';
    this.baseUrl = config.baseUrl || 'https://apis.roblox.com';
    this.timeout = config.timeout || 30000;
  }

  hasApiKey(): boolean {
    return !!this.apiKey;
  }

  private async request<T>(
    endpoint: string,
    options: {
      method?: string;
      params?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      authRequired?: boolean;
    } = {}
  ): Promise<T> {
    const { method = 'GET', params, body, authRequired = true } = options;

    if (authRequired && !this.apiKey) {
      throw new Error(
        'Open Cloud API key not configured. Set ROBLOX_OPEN_CLOUD_API_KEY environment variable.'
      );
    }

    const url = new URL(`${this.baseUrl}${endpoint}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (authRequired && this.apiKey) {
        headers['x-api-key'] = this.apiKey;
      }

      const response = await fetch(url.toString(), {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) throw await openCloudResponseError(response);

      return (await response.json()) as T;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Request timed out');
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error('Request timed out');
        }
        throw error;
      }
      throw new Error(`Unknown error: ${String(error)}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async searchAssets(params: AssetSearchParams): Promise<AssetSearchResponse> {
    return this.request<AssetSearchResponse>('/toolbox-service/v2/assets:search', {
      authRequired: false,
      params: {
        searchCategoryType: params.searchCategoryType,
        query: params.query,
        pageToken: params.pageToken,
        pageNumber: params.pageNumber,
        maxPageSize: params.maxPageSize || 25,
        sortDirection: params.sortDirection,
        sortCategory: params.sortCategory,
        userId: params.userId,
        groupId: params.groupId,
      },
    });
  }

  async getAssetDetails(assetId: number): Promise<CreatorStoreAsset> {
    return this.request<CreatorStoreAsset>(`/toolbox-service/v2/assets/${assetId}`, {
      authRequired: false,
    });
  }

  async listAssetVersions(
    assetId: number | string,
    maxPageSize = 10,
    pageToken?: string,
  ): Promise<AssetVersionsResponse> {
    return this.request<AssetVersionsResponse>(`/assets/v1/assets/${assetId}/versions`, {
      params: {
        maxPageSize,
        pageToken,
      },
    });
  }

  async listMonetizationItems(
    kind: MonetizationKind,
    universeId: number,
    pageToken?: string,
  ): Promise<MonetizationItemPage> {
    const api = MONETIZATION_APIS[kind];
    const response = await this.request<unknown>(`${api.collectionPath(universeId)}/creator`, {
      params: { pageToken },
    });
    const rows: unknown = readField(response, api.listField);
    if (!Array.isArray(rows)) {
      throw new Error(`Open Cloud returned a ${api.label} list without ${api.listField}.`);
    }
    const nextPageToken = readField(response, 'nextPageToken');
    return {
      items: rows.map((row: unknown) => normalizeMonetizationItem(kind, universeId, row)),
      ...(typeof nextPageToken === 'string' && nextPageToken ? { nextPageToken } : {}),
    };
  }

  async getMonetizationItem(
    kind: MonetizationKind,
    universeId: number,
    id: number,
  ): Promise<MonetizationItem> {
    const path = `${MONETIZATION_APIS[kind].collectionPath(universeId)}/${id}/creator`;
    return normalizeMonetizationItem(kind, universeId, await this.request<unknown>(path));
  }

  async createMonetizationItem(
    kind: MonetizationKind,
    universeId: number,
    item: MonetizationItemChanges & { name: string },
  ): Promise<MonetizationItem> {
    const response = await this.requestMultipart<unknown>(
      MONETIZATION_APIS[kind].collectionPath(universeId),
      monetizationForm(item),
    );
    return normalizeMonetizationItem(kind, universeId, response);
  }

  /** Changes only the given fields. Roblox answers with an empty 204. */
  async updateMonetizationItem(
    kind: MonetizationKind,
    universeId: number,
    id: number,
    changes: MonetizationItemChanges,
  ): Promise<void> {
    const path = `${MONETIZATION_APIS[kind].collectionPath(universeId)}/${id}`;
    await this.sendMultipart(path, monetizationForm(changes), 'PATCH', async (response) => {
      await response.arrayBuffer();
    });
  }

  async getAssetThumbnail(
    assetId: number,
    size: '150x150' | '420x420' | '768x432' = '420x420'
  ): Promise<{ base64: string; mimeType: string } | null> {
    const url = `https://thumbnails.roblox.com/v1/assets?assetIds=${assetId}&size=${size}&format=Png`;

    try {
      const signal = AbortSignal.timeout(this.timeout);
      const response = await fetch(url, { signal });
      if (!response.ok) return null;

      const data = (await response.json()) as { data: ThumbnailResponse[] };
      const thumbnail = data.data[0];

      if (!thumbnail || thumbnail.state !== 'Completed' || !thumbnail.imageUrl) {
        return null;
      }

      // Fetch the actual image and convert to base64
      const imageResponse = await fetch(thumbnail.imageUrl, { signal });
      if (!imageResponse.ok) return null;

      const arrayBuffer = await imageResponse.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString('base64');
      return { base64, mimeType: 'image/png' };
    } catch {
      return null;
    }
  }

  async getAssetThumbnails(
    assetIds: number[],
    size: '150x150' | '420x420' | '768x432' = '420x420'
  ): Promise<Map<number, string>> {
    const result = new Map<number, string>();
    if (assetIds.length === 0) return result;

    const batches = [];
    for (let i = 0; i < assetIds.length; i += 100) {
      batches.push(assetIds.slice(i, i + 100));
    }

    for (const batch of batches) {
      const url = `https://thumbnails.roblox.com/v1/assets?assetIds=${batch.join(',')}&size=${size}&format=Png`;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(this.timeout) });
        if (response.ok) {
          const data = (await response.json()) as { data: ThumbnailResponse[] };
          for (const thumbnail of data.data) {
            if (thumbnail.state === 'Completed' && thumbnail.imageUrl) {
              result.set(thumbnail.targetId, thumbnail.imageUrl);
            }
          }
        }
      } catch {
        // Continue with other batches on failure
      }
    }

    return result;
  }

  async downloadAudioAssetContent(
    assetId: number,
    maxBytes: number,
  ): Promise<DownloadedAudioAsset> {
    if (!this.apiKey) {
      throw new Error(
        'Open Cloud API key not configured. Set ROBLOX_OPEN_CLOUD_API_KEY with the legacy-asset:manage scope to download audio previews.',
      );
    }
    if (!Number.isSafeInteger(assetId) || assetId <= 0) {
      throw new Error('Audio asset ID must be a positive integer.');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('Audio preview byte limit must be a positive integer.');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const deliveryResponse = await fetch(
        `${this.baseUrl}/asset-delivery-api/v1/assetId/${assetId}`,
        {
          headers: {
            'x-api-key': this.apiKey,
          },
          signal: controller.signal,
        },
      );
      if (!deliveryResponse.ok) {
        const scopeHint = deliveryResponse.status === 403
          ? ' The Open Cloud API key lacks the legacy-asset:manage scope required to download audio.'
          : '';
        throw new Error(
          `Roblox asset delivery request failed (${deliveryResponse.status}).${scopeHint}`,
        );
      }

      const delivery = await deliveryResponse.json() as AssetDeliveryResponse;
      if (!delivery.location) {
        const detail = delivery.errors
          ?.map((entry) => entry.message)
          .filter((message): message is string => !!message)
          .join('; ');
        throw new Error(detail || 'Roblox asset delivery returned no download location.');
      }

      const location = new URL(delivery.location);
      if (
        location.protocol !== 'https:'
        || !(
          location.hostname === 'contentdelivery.roblox.com'
          || location.hostname === 'rbxcdn.com'
          || location.hostname.endsWith('.rbxcdn.com')
        )
      ) {
        throw new Error('Roblox asset delivery returned an untrusted download location.');
      }

      const contentResponse = await fetch(location, {
        signal: controller.signal,
      });
      if (!contentResponse.ok) {
        throw new Error(
          `Roblox audio download failed (${contentResponse.status}).`,
        );
      }

      const declaredLength = Number(contentResponse.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new Error(`Audio asset exceeds the ${maxBytes}-byte preview limit.`);
      }
      if (!contentResponse.body) {
        throw new Error('Roblox audio download returned an empty body.');
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const reader = contentResponse.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          throw new Error(`Audio asset exceeds the ${maxBytes}-byte preview limit.`);
        }
        chunks.push(Buffer.from(value));
      }

      const data = Buffer.concat(chunks, totalBytes);
      if (data.length === 0) {
        throw new Error('Roblox audio download returned no bytes.');
      }
      const mimeType = detectAudioMimeType(data);
      if (!mimeType) {
        throw new Error('Downloaded asset is not a supported MP3, OGG, WAV, or FLAC audio file.');
      }
      return { data, mimeType };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Audio preview download timed out.');
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async createAsset(
    uploadRequest: AssetUploadRequest,
    fileContent: Buffer,
    fileName: string
  ): Promise<AssetOperationResponse> {
    const formData = new FormData();
    formData.append('request', JSON.stringify(uploadRequest));
    formData.append(
      'fileContent',
      new Blob([new Uint8Array(fileContent)], { type: this.getMimeType(fileName) }),
      fileName
    );

    const operation = await this.requestMultipart<AssetOperationResponse>(
      '/assets/v1/assets',
      formData
    );
    if (operation.done) return operation;
    return this.pollOperation(operation.path);
  }

  private getMimeType(fileName: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      // Image (Decal)
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      bmp: 'image/bmp',
      tga: 'image/tga',
      // Audio
      mp3: 'audio/mpeg',
      ogg: 'audio/ogg',
      wav: 'audio/wav',
      flac: 'audio/flac',
      // Model
      fbx: 'model/fbx',
      gltf: 'model/gltf+json',
      glb: 'model/gltf-binary',
      rbxm: 'model/x-rbxm',
      rbxmx: 'model/x-rbxm',
      // Video
      mp4: 'video/mp4',
      mov: 'video/mov',
    };
    if (!ext || !mimeTypes[ext]) {
      throw new Error(
        `Unsupported file format: .${ext ?? '(none)'}. Supported: ` +
        'Image: png/jpg/bmp/tga, Audio: mp3/ogg/wav/flac, Model: fbx/gltf/glb/rbxm/rbxmx, Video: mp4/mov'
      );
    }
    return mimeTypes[ext];
  }

  private requestMultipart<T>(endpoint: string, formData: FormData): Promise<T> {
    return this.sendMultipart(endpoint, formData, 'POST', async (response) => (await response.json()) as T);
  }

  // readResponse runs inside the deadline, so a stalled body still times out.
  private async sendMultipart<T>(
    endpoint: string,
    formData: FormData,
    method: 'POST' | 'PATCH',
    readResponse: (response: Response) => Promise<T>,
  ): Promise<T> {
    if (!this.apiKey) {
      throw new Error(
        'Open Cloud API key not configured. Set ROBLOX_OPEN_CLOUD_API_KEY environment variable.'
      );
    }

    const url = `${this.baseUrl}${endpoint}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      // fetch derives the multipart Content-Type and boundary from FormData.
      const response = await fetch(url, {
        method,
        headers: { 'x-api-key': this.apiKey },
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) throw await openCloudResponseError(response);
      return await readResponse(response);
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Request timed out');
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error('Request timed out');
        }
        throw error;
      }
      throw new Error(`Unknown error: ${String(error)}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async pollOperation(
    operationPath: string,
    maxAttempts = 30,
    intervalMs = 2000
  ): Promise<AssetOperationResponse> {
    const operationId = operationPath.replace('operations/', '');
    for (let i = 0; i < maxAttempts; i++) {
      const result = await this.request<AssetOperationResponse>(
        `/assets/v1/operations/${operationId}`
      );
      if (result.done) return result;
      if (result.error) {
        throw new Error(`Asset upload failed: ${result.error.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error(
      `Asset upload timed out after ${(maxAttempts * intervalMs) / 1000}s. Operation ID: ${operationId}`
    );
  }
}
