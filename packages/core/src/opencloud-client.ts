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
  includeOnlyVerifiedCreators?: boolean;
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
      if (this.apiKey) {
        headers['x-api-key'] = this.apiKey;
      }

      const response = await fetch(url.toString(), {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMessage: string;
        try {
          const errorJson = JSON.parse(errorBody);
          errorMessage = errorJson.detail || errorJson.message || errorBody;
        } catch {
          errorMessage = errorBody;
        }

        if (response.status === 401) {
          throw new Error('Invalid or expired API key');
        } else if (response.status === 403) {
          throw new Error(`API key lacks required permissions: ${errorMessage}`);
        } else if (response.status === 429) {
          throw new Error('Rate limit exceeded. Please try again later.');
        } else {
          throw new Error(`Open Cloud API error (${response.status}): ${errorMessage}`);
        }
      }

      return (await response.json()) as T;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error('Request timed out');
        }
        throw error;
      }
      throw new Error(`Unknown error: ${String(error)}`);
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
        includeOnlyVerifiedCreators: params.includeOnlyVerifiedCreators,
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

  async getAssetThumbnail(
    assetId: number,
    size: '150x150' | '420x420' | '768x432' = '420x420'
  ): Promise<{ base64: string; mimeType: string } | null> {
    const url = `https://thumbnails.roblox.com/v1/assets?assetIds=${assetId}&size=${size}&format=Png`;

    try {
      const response = await fetch(url);
      if (!response.ok) return null;

      const data = (await response.json()) as { data: ThumbnailResponse[] };
      const thumbnail = data.data[0];

      if (!thumbnail || thumbnail.state !== 'Completed' || !thumbnail.imageUrl) {
        return null;
      }

      // Fetch the actual image and convert to base64
      const imageResponse = await fetch(thumbnail.imageUrl);
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
        const response = await fetch(url);
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

  private async requestMultipart<T>(
    endpoint: string,
    formData: FormData
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
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey },
        body: formData,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMessage: string;
        try {
          const errorJson = JSON.parse(errorBody);
          errorMessage = errorJson.detail || errorJson.message || errorBody;
        } catch {
          errorMessage = errorBody;
        }

        if (response.status === 401) {
          throw new Error('Invalid or expired API key');
        } else if (response.status === 403) {
          throw new Error(`API key lacks required permissions: ${errorMessage}`);
        } else if (response.status === 429) {
          throw new Error('Rate limit exceeded. Please try again later.');
        } else {
          throw new Error(`Open Cloud API error (${response.status}): ${errorMessage}`);
        }
      }

      return (await response.json()) as T;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error('Request timed out');
        }
        throw error;
      }
      throw new Error(`Unknown error: ${String(error)}`);
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
