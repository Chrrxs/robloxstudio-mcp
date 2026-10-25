import { RobloxCookieClient, RobloxCookieRequestError, RobloxUploadOperationError } from '../roblox-cookie-client.js';

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

describe('RobloxCookieClient asset uploads', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('uploads an Image through user-auth and polls the operation with CSRF retry', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', {
        status: 403,
        headers: { 'x-csrf-token': 'csrf-token' },
      }))
      .mockResolvedValueOnce(jsonResponse({
        path: 'operations/upload-123',
        operationId: 'upload-123',
        done: false,
      }))
      .mockResolvedValueOnce(jsonResponse({
        path: 'operations/upload-123',
        operationId: 'upload-123',
        done: true,
        response: { assetId: '987654321' },
      }));

    const client = new RobloxCookieClient('cookie-value');
    const result = await client.uploadImage({
      fileContent: Buffer.from('png data'),
      fileName: 'reference.png',
      displayName: 'Reference',
      description: 'Reference image',
      userId: '12345',
    });

    expect(result).toEqual({ assetId: 987654321 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://apis.roblox.com/assets/user-auth/v1/assets',
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://apis.roblox.com/assets/user-auth/v1/assets',
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      'https://apis.roblox.com/assets/user-auth/v1/operations/upload-123',
    );

    const retryHeaders = fetchMock.mock.calls[1][1]?.headers as Record<string, string>;
    expect(retryHeaders.Cookie).toBe('.ROBLOSECURITY=cookie-value');
    expect(retryHeaders['X-CSRF-TOKEN']).toBe('csrf-token');

    const formData = fetchMock.mock.calls[1][1]?.body as FormData;
    expect(JSON.parse(String(formData.get('request')))).toEqual({
      assetType: 'Image',
      displayName: 'Reference',
      description: 'Reference image',
      creationContext: { creator: { userId: '12345' } },
    });
    const fileContent = formData.get('fileContent') as Blob & { name: string };
    expect(fileContent.name).toBe('reference.png');
    expect(fileContent.type).toBe('image/png');
  });

  test('resolves the authenticated user when no creator ID is configured', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({
        id: 24680,
        name: 'Builder',
        displayName: 'Builder',
      }))
      .mockResolvedValueOnce(jsonResponse({
        path: 'operations/upload-456',
        operationId: 'upload-456',
        done: true,
        response: { assetId: '11223344' },
      }));

    const client = new RobloxCookieClient('cookie-value');
    const result = await client.uploadImage({
      fileContent: Buffer.from('jpeg data'),
      fileName: 'texture.jpg',
      displayName: 'Texture',
      description: '',
    });

    expect(result).toEqual({ assetId: 11223344 });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://users.roblox.com/v1/users/authenticated',
    );
    const formData = fetchMock.mock.calls[1][1]?.body as FormData;
    expect(JSON.parse(String(formData.get('request')))).toMatchObject({
      creationContext: { creator: { userId: '24680' } },
    });
  });

  test('uses group ownership when both creator IDs are provided', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({
        path: 'operations/upload-789',
        operationId: 'upload-789',
        done: true,
        response: { assetId: 55667788 },
      }));

    const client = new RobloxCookieClient('cookie-value');
    await client.uploadImage({
      fileContent: Buffer.from('image data'),
      fileName: 'group-image.bmp',
      displayName: 'Group Image',
      description: '',
      userId: '12345',
      groupId: '67890',
    });

    const formData = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(JSON.parse(String(formData.get('request'))).creationContext).toEqual({
      creator: { groupId: '67890' },
    });
  });

  test('surfaces operation failures', async () => {
    jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({
        path: 'operations/upload-failed',
        operationId: 'upload-failed',
        done: false,
      }))
      .mockResolvedValueOnce(jsonResponse({
        path: 'operations/upload-failed',
        operationId: 'upload-failed',
        done: true,
        error: { code: 7, message: 'Asset moderation rejected the upload' },
      }));

    const client = new RobloxCookieClient('cookie-value');
    const failure = client.uploadImage({
      fileContent: Buffer.from('image data'),
      fileName: 'rejected.tga',
      displayName: 'Rejected',
      description: '',
      userId: '12345',
    });
    await expect(failure).rejects.toBeInstanceOf(RobloxUploadOperationError);
    await expect(failure).rejects.toThrow('Image upload failed: Asset moderation rejected the upload');
  });

  test('reports when the create request leaves and when Roblox accepts it', async () => {
    const events: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      events.push(`fetch ${String(input)}`);
      return String(input).endsWith('/assets')
        ? jsonResponse({ path: 'operations/upload-1', operationId: 'upload-1', done: false })
        : jsonResponse({ operationId: 'upload-1', done: true, response: { assetId: '5' } });
    });

    const client = new RobloxCookieClient('cookie-value');
    await expect(client.uploadImage({
      fileContent: Buffer.from('png data'), fileName: 'reference.png', displayName: 'Reference', description: '', userId: '1',
      onSending: () => events.push('sending'),
      onAccepted: (operationId) => events.push(`accepted ${operationId}`),
    })).resolves.toEqual({ assetId: 5 });
    expect(events).toEqual([
      'sending',
      'fetch https://apis.roblox.com/assets/user-auth/v1/assets',
      'accepted upload-1',
      'fetch https://apis.roblox.com/assets/user-auth/v1/operations/upload-1',
    ]);
  });

  test('a refused create request carries its HTTP status', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad image', { status: 400 }));
    const client = new RobloxCookieClient('cookie-value');
    const failure = client.uploadImage({
      fileContent: Buffer.from('png data'), fileName: 'reference.png', displayName: 'Reference', description: '', userId: '1',
    });
    await expect(failure).rejects.toBeInstanceOf(RobloxCookieRequestError);
    await expect(failure).rejects.toMatchObject({ status: 400, message: 'Image upload failed (400): bad image' });
  });

  test('resumes polling an accepted upload without sending the image again', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ operationId: 'upload-2', done: true, response: { assetId: '6' } }));
    await expect(new RobloxCookieClient('cookie-value').resumeImageUpload('upload-2')).resolves.toEqual({ assetId: 6 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://apis.roblox.com/assets/user-auth/v1/operations/upload-2');
  });
});
