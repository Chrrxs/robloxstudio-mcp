import childProcess, { ChildProcess } from 'child_process';
import { once } from 'events';
import fs from 'fs';
import os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { captureStudioWindow } from '../host-capture.js';
import type { HostWindowIdentity } from '../host-capture.js';

const identity: HostWindowIdentity = { windowId: 42, processId: 123, bundleIdentifier: 'RobloxStudioBeta' };
const report = { ok: true, width: 1, height: 2, stride: 8, title: 'Place - Roblox Studio', identity };
// Include row padding and nonopaque source alpha to exercise the native BGRA boundary.
const bgra = Buffer.from([10, 20, 30, 40, 201, 202, 203, 204, 50, 60, 70, 80, 205, 206, 207, 208]);
const rgba = Buffer.from([30, 20, 10, 255, 70, 60, 50, 255]);

describe('Windows capture process boundary (no native window access)', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let root: string;
  let pendingLifecycles: Promise<void>[];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-capture-windows-test-'));
    pendingLifecycles = [];
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
    jest.replaceProperty(process, 'env', { ...process.env, ROBLOX_STUDIO_HOST_CAPTURE: '1' });
    delete process.env.SystemRoot;
    delete process.env.windir;
    delete process.env.MCP_CAPTURE_EXPECTED_IDENTITY;
    jest.spyOn(os, 'tmpdir').mockReturnValue(root);
  });

  afterEach(async () => {
    try {
      await Promise.all(pendingLifecycles);
    } finally {
      jest.restoreAllMocks();
      jest.useRealTimers();
      Object.defineProperty(process, 'platform', platformDescriptor);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function helperReturns(payload: object) {
    const outputs: string[] = [];
    const read = jest.spyOn(fs, 'readFileSync');
    const remove = jest.spyOn(fs, 'rmSync');
    const spawn = jest.spyOn(childProcess, 'spawn').mockImplementation((_command, _args, options) => {
      const output = options?.env?.MCP_CAPTURE_OUT;
      if (!output || path.dirname(output) !== root) throw new Error('capture must use the private test output directory');
      outputs.push(output);
      // Even failures leave a file behind: the production finally block must remove it.
      fs.writeFileSync(output, bgra);
      const child = new ChildProcess();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      child.stdout = stdout;
      child.stderr = stderr;
      const lifecycle = Promise.all([once(stdout, 'end'), once(stderr, 'end')]).then(() => {
        child.emit('close', 'ok' in payload && payload.ok === true ? 0 : 1, null);
        stdout.destroy();
        stderr.destroy();
      });
      pendingLifecycles.push(lifecycle);
      // Production attaches its stream/close listeners after spawn returns.
      queueMicrotask(() => {
        stdout.end(`${JSON.stringify(payload)}\n`);
        stderr.end();
      });
      return child;
    });
    return { outputs, read, remove, spawn };
  }

  function expectCleanedUp(helper: { outputs: string[]; remove: jest.SpyInstance }) {
    expect(helper.outputs).toHaveLength(1);
    const output = helper.outputs[0];
    expect(helper.remove).toHaveBeenCalledWith(output, { force: true });
    expect(fs.existsSync(output)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  }

  it('preserves HWND/PID/process identity and converts padded BGRA rows to opaque RGBA', async () => {
    const helper = helperReturns(report);

    const result = await captureStudioWindow('Place');

    expect(result).toEqual({ ok: true, capture: { width: 1, height: 2, title: report.title, identity, rgba } });
    expect(helper.spawn).toHaveBeenCalledTimes(1);
    expect(helper.read).toHaveBeenCalledWith(helper.outputs[0]);
    expectCleanedUp(helper);
  });

  it('forwards the pinned identity and literal title through the environment', async () => {
    const titleHint = 'Place "quoted"; $(not-a-command)';
    const literalReport = { ...report, title: `${titleHint} - Roblox Studio` };
    const helper = helperReturns(literalReport);

    const result = await captureStudioWindow(titleHint, identity);

    expect(helper.spawn).toHaveBeenCalledTimes(1);
    const options = helper.spawn.mock.calls[0][2];
    expect(options?.env?.MCP_CAPTURE_EXPECTED_IDENTITY).toBe(JSON.stringify(identity));
    expect(options?.env?.MCP_CAPTURE_TITLE_HINT).toBe(titleHint);
    expect(result).toEqual({ ok: true, capture: { width: 1, height: 2, title: literalReport.title, identity, rgba } });
    expectCleanedUp(helper);
  });

  it('clears an ambient expected identity when the caller has not selected a window yet', async () => {
    process.env.MCP_CAPTURE_EXPECTED_IDENTITY = JSON.stringify({ ...identity, windowId: 999 });
    const helper = helperReturns(report);

    const result = await captureStudioWindow();

    expect(result.ok).toBe(true);
    expect(helper.spawn.mock.calls[0][2]?.env?.MCP_CAPTURE_EXPECTED_IDENTITY).toBe('');
    expect(helper.spawn.mock.calls[0][2]?.env?.MCP_CAPTURE_TITLE_HINT).toBe('');
    expect(process.env.MCP_CAPTURE_EXPECTED_IDENTITY).toBe(JSON.stringify({ ...identity, windowId: 999 }));
    expectCleanedUp(helper);
  });

  it.each([
    ['window handle', { ...identity, windowId: 43 }],
    ['process ID', { ...identity, processId: 124 }],
    ['process identifier', { ...identity, bundleIdentifier: 'OtherStudio' }],
  ] as const)('rejects a changed %s before reading image bytes', async (_label, changedIdentity) => {
    const helper = helperReturns({ ...report, identity: changedIdentity });

    const result = await captureStudioWindow('Place', identity);

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/identity|window|process/i) });
    expect(helper.read).not.toHaveBeenCalledWith(helper.outputs[0]);
    expectCleanedUp(helper);
  });

  it.each([
    ['missing identity', undefined],
    ['null identity', null],
    ['empty identity', {}],
    ['missing HWND', { processId: identity.processId, bundleIdentifier: identity.bundleIdentifier }],
    ['zero HWND', { ...identity, windowId: 0 }],
    ['negative HWND', { ...identity, windowId: -1 }],
    ['fractional HWND', { ...identity, windowId: 1.5 }],
    ['string HWND', { ...identity, windowId: '42' }],
    ['unsafe HWND', { ...identity, windowId: Number.MAX_SAFE_INTEGER + 1 }],
    ['missing PID', { windowId: identity.windowId, bundleIdentifier: identity.bundleIdentifier }],
    ['zero PID', { ...identity, processId: 0 }],
    ['negative PID', { ...identity, processId: -1 }],
    ['fractional PID', { ...identity, processId: 1.5 }],
    ['string PID', { ...identity, processId: '123' }],
    ['overflowing PID', { ...identity, processId: 0x100000000 }],
    ['missing process identifier', { windowId: identity.windowId, processId: identity.processId }],
    ['wrong process identifier', { ...identity, bundleIdentifier: 'RobloxPlayerBeta' }],
    ['empty process identifier', { ...identity, bundleIdentifier: '' }],
  ])('rejects %s before reading image bytes', async (_label, invalidIdentity) => {
    const helper = helperReturns({ ...report, identity: invalidIdentity });

    const result = await captureStudioWindow('Place');

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/identity|window|process/i) });
    expect(helper.read).not.toHaveBeenCalledWith(helper.outputs[0]);
    expectCleanedUp(helper);
  });

  it.each([
    'multiple Roblox Studio windows match the requested place title; the capture is ambiguous',
    'no Roblox Studio windows match the requested place title',
  ])('preserves a native selection failure and removes partial output: %s', async (error) => {
    const helper = helperReturns({ ok: false, error });

    const result = await captureStudioWindow('Place');

    expect(result).toEqual({ ok: false, error });
    expect(helper.read).not.toHaveBeenCalledWith(helper.outputs[0]);
    expectCleanedUp(helper);
  });

  it.each([
    { width: 0 }, { width: 1.5 }, { height: -1 }, { width: 16385 }, { stride: 3 },
    { stride: 128 * 1024 * 1024 }, { title: null },
  ])('rejects invalid image metadata before reading bytes: %j', async (change) => {
    const helper = helperReturns({ ...report, ...change });
    const result = await captureStudioWindow('Place');
    expect(result).toEqual({ ok: false, error: 'invalid Windows capture dimensions or title' });
    expect(helper.read).not.toHaveBeenCalledWith(helper.outputs[0]);
    expectCleanedUp(helper);
  });

  it('rejects truncated image bytes and removes the output', async () => {
    const helper = helperReturns(report);
    helper.read.mockReturnValue(Buffer.alloc(bgra.length - 1));
    const result = await captureStudioWindow('Place');
    expect(result).toEqual({ ok: false, error: 'Windows capture returned an invalid BGRA byte count' });
    expectCleanedUp(helper);
  });

  it('cleans the temporary output when reading the captured image fails', async () => {
    const helper = helperReturns(report);
    helper.read.mockImplementation(() => { throw new Error('synthetic image read failure'); });

    const result = await captureStudioWindow('Place');

    expect(result).toEqual({ ok: false, error: 'synthetic image read failure' });
    expect(helper.read).toHaveBeenCalledWith(helper.outputs[0]);
    expectCleanedUp(helper);
  });
});
