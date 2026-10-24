import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, constants, openSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeService } from '../bridge-service.js';
import { readRegularFileWithinLimitAsync } from '../local-file.js';
import { OPEN_CLOUD_ASSET_UPLOAD_LIMIT_BYTES } from '../opencloud-client.js';
import { readRbxmInput } from '../rbxm-input.js';
import { RobloxStudioTools } from '../tools/index.js';

const posixTest = process.platform === 'win32' ? test.skip : test;
const linuxTest = process.platform === 'linux' ? test : test.skip;

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mcp-local-file-'));
});

afterEach(async () => {
  jest.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function makeFifo(name = 'input.rbxm'): string {
  const fifo = join(directory, name);
  execFileSync('mkfifo', [fifo]);
  return fifo;
}

function openDescriptorCount(): number {
  return readdirSync('/proc/self/fd').length;
}

const accept = () => {};

/**
 * Settles `read` or fails. Deterministic fake time cannot help here: before
 * the fix the reader is parked inside open(2) on a libuv worker, which no
 * timer, abort signal, or process.exit can release. A real-time watchdog
 * opens the FIFO's write end non-blocking, which completes the stuck open so
 * the worker (and Jest) can finish, and then fails the test.
 */
async function settleWithinWatchdog<T>(fifo: string, read: Promise<T>): Promise<T> {
  let released = false;
  const watchdog = setTimeout(() => {
    released = true;
    try {
      closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
    } catch {
      // ENXIO means no reader is blocked in open; nothing to release.
    }
  }, 2_000);
  const settled = await read.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  clearTimeout(watchdog);
  if (released) throw new Error(`Reading ${fifo} blocked until the watchdog released it.`);
  if (!settled.ok) throw settled.error;
  return settled.value;
}

describe('readRegularFileWithinLimitAsync', () => {
  test('reads an ordinary file and passes its size to the validator', async () => {
    const file = join(directory, 'plain.bin');
    await writeFile(file, 'hello world');
    const sizes: number[] = [];
    const data = await readRegularFileWithinLimitAsync(file, 'File', (size) => sizes.push(size));
    expect(data).toEqual(Buffer.from('hello world'));
    expect(sizes).toEqual([11]);
  });

  test('reports a missing file as not found', async () => {
    await expect(readRegularFileWithinLimitAsync(join(directory, 'missing'), 'File', accept))
      .rejects.toThrow('File not found');
  });

  posixTest('rejects a FIFO with no writer promptly', async () => {
    const fifo = makeFifo();
    await expect(settleWithinWatchdog(fifo, readRegularFileWithinLimitAsync(fifo, 'File', accept)))
      .rejects.toThrow('must reference a regular file');
  });

  test('rejects a directory', async () => {
    const child = join(directory, 'child');
    await mkdir(child);
    await expect(readRegularFileWithinLimitAsync(child, 'File', accept))
      .rejects.toThrow('must reference a regular file');
  });

  test('rejects an over-limit file before allocating a buffer', async () => {
    const file = join(directory, 'sparse.bin');
    await writeFile(file, '');
    await truncate(file, 64 * 1024 * 1024);
    const allocate = jest.spyOn(Buffer, 'allocUnsafe');
    await expect(readRegularFileWithinLimitAsync(file, 'File', (size) => {
      if (size > 1024) throw new Error('too large');
    })).rejects.toThrow('too large');
    expect(allocate).not.toHaveBeenCalled();
  });

  test('rejects a file that grows while it is read', async () => {
    const file = join(directory, 'growing.bin');
    await writeFile(file, 'start');
    let validations = 0;
    // The validator runs after fstat and before the read, so appending here
    // makes the file larger than the size the reader sized its buffer for.
    await expect(readRegularFileWithinLimitAsync(file, 'File', () => {
      if (validations++ === 0) appendFileSync(file, 'more bytes');
    })).rejects.toThrow('size changed while reading');
  });

  test('applies the limit to bytes that appear while reading', async () => {
    const file = join(directory, 'growing-past-limit.bin');
    await writeFile(file, 'start');
    let validations = 0;
    await expect(readRegularFileWithinLimitAsync(file, 'File', (size) => {
      if (validations++ === 0) appendFileSync(file, 'more bytes');
      else if (size > 5) throw new Error('grew past the limit');
    })).rejects.toThrow('grew past the limit');
  });

  test('stops between chunks when aborted mid-read', async () => {
    const file = join(directory, 'large.bin');
    await writeFile(file, Buffer.alloc(256 * 1024, 1));
    const controller = new AbortController();
    const original = controller.signal.throwIfAborted.bind(controller.signal);
    let checks = 0;
    jest.spyOn(controller.signal, 'throwIfAborted').mockImplementation(() => {
      // Check 1 is on entry and check 2 precedes the first chunk; abort before the second.
      if (++checks === 3) controller.abort(new Error('aborted mid-read'));
      original();
    });
    await expect(readRegularFileWithinLimitAsync(file, 'File', accept, controller.signal))
      .rejects.toThrow('aborted mid-read');
    expect(checks).toBe(3);
  });

  linuxTest('closes the descriptor after every rejected read', async () => {
    const fifo = makeFifo();
    const file = join(directory, 'large.bin');
    await writeFile(file, Buffer.alloc(256 * 1024, 1));
    const before = openDescriptorCount();
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(readRegularFileWithinLimitAsync(fifo, 'File', accept)).rejects.toThrow('regular file');
      await expect(readRegularFileWithinLimitAsync(directory, 'File', accept)).rejects.toThrow('regular file');
      await expect(readRegularFileWithinLimitAsync(file, 'File', () => {
        throw new Error('too large');
      })).rejects.toThrow('too large');
      const controller = new AbortController();
      const original = controller.signal.throwIfAborted.bind(controller.signal);
      let checks = 0;
      jest.spyOn(controller.signal, 'throwIfAborted').mockImplementation(() => {
        if (++checks === 3) controller.abort(new Error('aborted'));
        original();
      });
      await expect(readRegularFileWithinLimitAsync(file, 'File', accept, controller.signal))
        .rejects.toThrow('aborted');
    }
    expect(openDescriptorCount()).toBe(before);
  });
});

describe('readRbxmInput local paths', () => {
  posixTest('rejects a FIFO with no writer promptly', async () => {
    const fifo = makeFifo();
    await expect(settleWithinWatchdog(fifo, readRbxmInput({ path: fifo }, 'game.Workspace')))
      .rejects.toThrow('regular file');
  });

  test('rejects a directory', async () => {
    await expect(readRbxmInput({ path: directory }, 'game.Workspace')).rejects.toThrow('regular file');
  });
});

describe('uploadAsset local file admission', () => {
  let tools: RobloxStudioTools;
  let fetchSpy: jest.SpiedFunction<typeof fetch>;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env.ROBLOX_OPEN_CLOUD_API_KEY = 'test-key';
    process.env.ROBLOX_CREATOR_USER_ID = '123';
    delete process.env.ROBLOSECURITY;
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network must not be used'));
    tools = new RobloxStudioTools(new BridgeService());
  });

  afterEach(async () => {
    await tools.dispose();
    process.env = { ...savedEnv };
  });

  test('keeps the file-not-found message', async () => {
    await expect(tools.uploadAsset(join(directory, 'missing.rbxm'), 'Model', 'x'))
      .rejects.toThrow('File not found');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  posixTest('rejects a FIFO before any network request', async () => {
    const fifo = makeFifo('model.rbxm');
    await expect(settleWithinWatchdog(fifo, tools.uploadAsset(fifo, 'Model', 'x')))
      .rejects.toThrow('regular file');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('rejects a directory before any network request', async () => {
    const child = join(directory, 'model.rbxm');
    await mkdir(child);
    await expect(tools.uploadAsset(child, 'Model', 'x')).rejects.toThrow('regular file');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('rejects a file over the 20 MB Create Asset limit before any network request', async () => {
    const file = join(directory, 'huge.rbxm');
    await writeFile(file, '');
    await truncate(file, OPEN_CLOUD_ASSET_UPLOAD_LIMIT_BYTES + 1);
    const allocate = jest.spyOn(Buffer, 'allocUnsafe');
    await expect(tools.uploadAsset(file, 'Model', 'x')).rejects.toThrow('20 MB');
    expect(allocate).not.toHaveBeenCalledWith(OPEN_CLOUD_ASSET_UPLOAD_LIMIT_BYTES + 2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('admits a video over 20 MB, which Roblox accepts up to 3.75 GB', async () => {
    const file = join(directory, 'clip.mp4');
    await writeFile(file, '');
    await truncate(file, OPEN_CLOUD_ASSET_UPLOAD_LIMIT_BYTES + 1);
    // Size admission passes; the mocked network is the first thing to fail.
    await expect(tools.uploadAsset(file, 'Video', 'x')).rejects.toThrow('network must not be used');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
