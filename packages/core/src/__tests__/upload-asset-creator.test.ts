import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools, resolveUploadCreator } from '../tools/index.js';

type Creator = { userId?: string; groupId?: string };

interface Case {
  name: string;
  env: Creator;
  args: Creator;
  expected: Creator | undefined;
}

const CASES: Case[] = [
  { name: 'env group + arg userId', env: { groupId: 'g-env' }, args: { userId: 'u-arg' }, expected: { userId: 'u-arg' } },
  { name: 'both env + arg userId', env: { userId: 'u-env', groupId: 'g-env' }, args: { userId: 'u-arg' }, expected: { userId: 'u-arg' } },
  { name: 'env user + arg groupId', env: { userId: 'u-env' }, args: { groupId: 'g-arg' }, expected: { groupId: 'g-arg' } },
  { name: 'env group only', env: { groupId: 'g-env' }, args: {}, expected: { groupId: 'g-env' } },
  { name: 'both env, no args', env: { userId: 'u-env', groupId: 'g-env' }, args: {}, expected: { groupId: 'g-env' } },
  { name: 'both args', env: {}, args: { userId: 'u-arg', groupId: 'g-arg' }, expected: { groupId: 'g-arg' } },
  { name: 'nothing set', env: {}, args: {}, expected: undefined },
];

function setCreatorEnv(env: Creator): void {
  delete process.env.ROBLOX_CREATOR_USER_ID;
  delete process.env.ROBLOX_CREATOR_GROUP_ID;
  if (env.userId) process.env.ROBLOX_CREATOR_USER_ID = env.userId;
  if (env.groupId) process.env.ROBLOX_CREATOR_GROUP_ID = env.groupId;
}

function replaceClient(tools: RobloxStudioTools, field: 'openCloudClient' | 'cookieClient', client: object): void {
  (tools as unknown as Record<string, object>)[field] = client;
}

describe('upload_asset creator resolution', () => {
  const savedEnv = { ...process.env };
  let directory: string;
  let filePath: string;
  let tools: RobloxStudioTools;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mcp-upload-creator-'));
    filePath = join(directory, 'asset.png');
    await writeFile(filePath, 'not actually png');
    delete process.env.ROBLOSECURITY;
    tools = new RobloxStudioTools(new BridgeService());
  });

  afterEach(async () => {
    await tools.dispose();
    process.env = { ...savedEnv };
    await rm(directory, { recursive: true, force: true });
  });

  test.each(CASES)('resolver: $name', ({ env, args, expected }) => {
    setCreatorEnv(env);
    expect(resolveUploadCreator(args.userId, args.groupId)).toEqual(expected);
  });

  test.each(CASES)('Open Cloud path: $name', async ({ env, args, expected }) => {
    setCreatorEnv(env);
    const createAsset = jest.fn(async () => ({ done: true, response: { assetId: '1' } }));
    replaceClient(tools, 'cookieClient', { hasCookie: () => false });
    replaceClient(tools, 'openCloudClient', { hasApiKey: () => true, createAsset });

    const upload = tools.uploadAsset(filePath, 'Model', 'x', undefined, args.userId, args.groupId);
    if (!expected) {
      await expect(upload).rejects.toThrow('Creator identity required for Open Cloud upload');
      expect(createAsset).not.toHaveBeenCalled();
      return;
    }
    await upload;
    expect(createAsset).toHaveBeenCalledWith(
      expect.objectContaining({ creationContext: { creator: expected } }),
      expect.any(Buffer),
      'asset.png',
    );
  });

  test.each(CASES)('cookie Decal path: $name', async ({ env, args, expected }) => {
    setCreatorEnv(env);
    const uploadImage = jest.fn<Promise<{ assetId: number }>, [Record<string, unknown>]>(async () => ({ assetId: 7 }));
    replaceClient(tools, 'cookieClient', { hasCookie: () => true, uploadImage });
    replaceClient(tools, 'openCloudClient', { hasApiKey: () => false });

    await tools.uploadAsset(filePath, 'Decal', 'x', undefined, args.userId, args.groupId);
    const options = uploadImage.mock.calls[0]?.[0];
    expect(options).toBeDefined();
    const sent: Creator = {};
    if (options && 'userId' in options) sent.userId = String(options.userId);
    if (options && 'groupId' in options) sent.groupId = String(options.groupId);
    expect(sent).toEqual(expected ?? {});
  });
});
