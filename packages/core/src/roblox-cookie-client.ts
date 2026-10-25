export interface CookieImageUploadOptions {
  fileContent: Buffer;
  fileName: string;
  displayName: string;
  description: string;
  userId?: string;
  groupId?: string;
  /** Called just before the create request is sent. */
  onSending?: () => void;
  /** Called when Roblox accepts the create request as a long-running operation. */
  onAccepted?: (operationId: string) => void;
}

/** A non-2xx response; Roblox answered, so status says whether it acted. */
export class RobloxCookieRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'RobloxCookieRequestError';
  }
}

/** An upload operation that finished without a usable asset: Roblox reported an error, or no asset ID. */
export class RobloxUploadOperationError extends Error {
  constructor(
    message: string,
    /** The operation reported no error, only no asset ID; the asset may exist. */
    readonly completedWithoutAsset = false,
  ) {
    super(message);
    this.name = 'RobloxUploadOperationError';
  }
}

interface UserAuthAssetOperation {
  path?: string;
  operationId?: string;
  done?: boolean;
  response?: {
    assetId?: string | number;
    code?: string | number;
    message?: string;
  };
  error?: {
    code?: string | number;
    message?: string;
  };
  code?: string | number;
  message?: string;
}

export class RobloxCookieClient {
  private cookie: string;
  private csrfToken: string | null = null;

  constructor(cookie?: string) {
    this.cookie = cookie || process.env.ROBLOSECURITY || '';
  }

  hasCookie(): boolean {
    return !!this.cookie;
  }

  private async fetchWithCsrf(
    url: string,
    options: RequestInit = {}
  ): Promise<Response> {
    options = { ...options, signal: options.signal ?? AbortSignal.timeout(30_000) };
    const headers: Record<string, string> = {
      Cookie: `.ROBLOSECURITY=${this.cookie}`,
      ...(options.headers as Record<string, string> || {}),
    };

    if (this.csrfToken) {
      headers['X-CSRF-TOKEN'] = this.csrfToken;
    }

    const response = await fetch(url, { ...options, headers });

    if (response.status === 403) {
      const newToken = response.headers.get('x-csrf-token');
      if (newToken) {
        this.csrfToken = newToken;
        headers['X-CSRF-TOKEN'] = newToken;
        await response.body?.cancel();
        return fetch(url, { ...options, headers });
      }
    }

    return response;
  }

  async uploadImage(options: CookieImageUploadOptions): Promise<{ assetId: number }> {
    if (!this.cookie) {
      throw new Error('ROBLOSECURITY cookie is not set.');
    }

    const creator = await this.resolveCreator(options.userId, options.groupId);
    const request = {
      assetType: 'Image',
      displayName: options.displayName,
      description: options.description,
      creationContext: { creator },
    };
    const formData = new FormData();
    formData.append('request', JSON.stringify(request));
    formData.append(
      'fileContent',
      new Blob(
        [new Uint8Array(options.fileContent)],
        { type: this.getImageMimeType(options.fileName) },
      ),
      options.fileName,
    );

    options.onSending?.();
    const response = await this.fetchWithCsrf(
      'https://apis.roblox.com/assets/user-auth/v1/assets',
      {
        method: 'POST',
        body: formData,
      },
    );
    const operation = await this.readOperation(response, 'Image upload');
    return { assetId: await this.completeOperation(operation, options.onAccepted) };
  }

  /** Continues polling an upload operation Roblox already accepted. */
  async resumeImageUpload(operationId: string): Promise<{ assetId: number }> {
    if (!this.cookie) {
      throw new Error('ROBLOSECURITY cookie is not set.');
    }
    return { assetId: await this.pollOperation(operationId) };
  }

  private async resolveCreator(
    userId?: string,
    groupId?: string,
  ): Promise<{ userId: string } | { groupId: string }> {
    if (groupId) return { groupId };
    if (userId) return { userId };

    const response = await this.fetchWithCsrf(
      'https://users.roblox.com/v1/users/authenticated',
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to resolve authenticated Roblox user (${response.status}): ${body}`);
    }

    const authenticatedUser = await response.json() as { id?: number | string };
    const resolvedUserId = String(authenticatedUser.id ?? '');
    if (!/^\d+$/.test(resolvedUserId) || resolvedUserId === '0') {
      throw new Error('Authenticated Roblox user response did not include a valid user ID.');
    }
    return { userId: resolvedUserId };
  }

  private getImageMimeType(fileName: string): string {
    const extension = fileName.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      bmp: 'image/bmp',
      tga: 'image/tga',
    };
    const mimeType = extension ? mimeTypes[extension] : undefined;
    if (mimeType) return mimeType;
    throw new Error(
      `Unsupported image format: .${extension ?? '(none)'}. Supported: png/jpg/jpeg/bmp/tga`,
    );
  }

  private async readOperation(
    response: Response,
    action: string,
  ): Promise<UserAuthAssetOperation> {
    const body = await response.text();
    if (!response.ok) {
      throw new RobloxCookieRequestError(`${action} failed (${response.status}): ${body}`, response.status);
    }

    try {
      return JSON.parse(body) as UserAuthAssetOperation;
    } catch {
      throw new Error(`${action} returned malformed JSON: ${body}`);
    }
  }

  private operationAssetId(operation: UserAuthAssetOperation): number | null {
    const rawAssetId = operation.response?.assetId;
    if (rawAssetId === undefined) return null;
    const assetId = Number(rawAssetId);
    if (!Number.isSafeInteger(assetId) || assetId <= 0) {
      throw new Error(`Image upload returned an invalid asset ID: ${String(rawAssetId)}`);
    }
    return assetId;
  }

  private operationError(operation: UserAuthAssetOperation): string | null {
    if (operation.error?.message) return operation.error.message;
    if (operation.response?.message && operation.response.assetId === undefined) {
      return operation.response.message;
    }
    if (operation.message) return operation.message;
    return null;
  }

  private async completeOperation(operation: UserAuthAssetOperation, onAccepted?: (operationId: string) => void): Promise<number> {
    const initialError = this.operationError(operation);
    if (initialError) throw new RobloxUploadOperationError(`Image upload failed: ${initialError}`);

    const initialAssetId = this.operationAssetId(operation);
    if (initialAssetId !== null) return initialAssetId;
    if (operation.done) {
      throw new RobloxUploadOperationError('Image upload completed without an asset ID.', true);
    }

    const operationId = operation.operationId ?? operation.path?.split('/').pop();
    if (!operationId) {
      throw new Error('Image upload response did not include an operation ID.');
    }
    onAccepted?.(operationId);
    return this.pollOperation(operationId);
  }

  private async pollOperation(
    operationId: string,
    maxAttempts = 30,
    intervalMs = 2000,
  ): Promise<number> {
    const url = `https://apis.roblox.com/assets/user-auth/v1/operations/${encodeURIComponent(operationId)}`;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const response = await this.fetchWithCsrf(url);
      const operation = await this.readOperation(response, 'Image upload status');
      const operationError = this.operationError(operation);
      if (operationError) throw new RobloxUploadOperationError(`Image upload failed: ${operationError}`);

      const assetId = this.operationAssetId(operation);
      if (assetId !== null) return assetId;
      if (operation.done) {
        throw new RobloxUploadOperationError('Image upload completed without an asset ID.', true);
      }
      if (attempt < maxAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }
    throw new Error(
      `Image upload timed out after ${(maxAttempts * intervalMs) / 1000}s. Operation ID: ${operationId}`,
    );
  }

  async getAssetDetails(
    assetIds: number[]
  ): Promise<Array<Record<string, unknown>>> {
    if (!this.cookie) {
      throw new Error('ROBLOSECURITY cookie is not set.');
    }

    const response = await this.fetchWithCsrf(
      'https://itemconfiguration.roblox.com/v1/creations/get-asset-details',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetIds }),
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to get asset details (${response.status}): ${body}`);
    }

    return response.json() as Promise<Array<Record<string, unknown>>>;
  }
}
