import * as fs from 'fs';
import * as path from 'path';
import { captureMacStudioWindow, parseMacCaptureReport, runBoundedCaptureProcess } from '../host-capture-macos.js';

const identity = { windowId: 42, processId: 123, bundleIdentifier: 'com.Roblox.RobloxStudio' };
const report = { ok: true, width: 2, height: 2, title: 'Place - Roblox Studio', identity };

describe('macOS capture report boundary', () => {
  it.each([
    'macOS Screen Recording permission is not granted to the MCP host',
    'multiple Roblox Studio windows match the requested place title; the capture is ambiguous',
  ])('preserves a native failure without attempting to read image bytes: %s', async (error) => {
    const result = await captureMacStudioWindow('Place', undefined, async () => JSON.stringify({ ok: false, error }));
    expect(result).toEqual({ ok: false, error });
  });

  it.each([
    { width: 0 }, { width: 1.5 }, { height: -1 }, { width: 16385 }, { width: 16384, height: 16384 },
    { identity: { ...identity, bundleIdentifier: 'other.app' } },
    { identity: { ...identity, processId: 0 } }, { identity: { ...identity, windowId: 1.5 } },
  ])('rejects unsafe metadata %j', (change) => {
    expect(() => parseMacCaptureReport(JSON.stringify({ ...report, ...change }))).toThrow(/invalid macOS capture/);
  });

  it.each([
    { ...identity, windowId: 43 }, { ...identity, processId: 124 }, { ...identity, bundleIdentifier: 'other.app' },
  ])('rejects changed window identity %j', (expected) => {
    expect(() => parseMacCaptureReport(JSON.stringify(report), expected)).toThrow(/identity changed/);
  });

  it('rejects oversized output metadata', () => {
    expect(() => parseMacCaptureReport(' '.repeat(65537))).toThrow(/byte limit/);
  });

  it('returns exact RGBA bytes and stable identity and cleans its private directory', async () => {
    let outputPath = '';
    const pixels = Buffer.from(Array.from({ length: 16 }, (_, index) => index));
    const result = await captureMacStudioWindow('Place', identity, async (output, hint, expected) => {
      outputPath = output;
      expect(hint).toBe('Place');
      expect(expected).toEqual(identity);
      fs.writeFileSync(output, pixels);
      return JSON.stringify(report);
    });
    expect(result).toEqual({ ok: true, capture: { width: 2, height: 2, title: report.title, identity, rgba: pixels } });
    expect(fs.existsSync(path.dirname(outputPath))).toBe(false);
  });

  it.each([0, 15, 17])('rejects a %i-byte file when dimensions require 16 bytes and cleans up', async (size) => {
    let outputPath = '';
    const result = await captureMacStudioWindow('Place', undefined, async (output) => {
      outputPath = output;
      fs.writeFileSync(output, Buffer.alloc(size));
      return JSON.stringify(report);
    });
    expect(result).toEqual({ ok: false, error: 'macOS capture returned an invalid RGBA byte count' });
    expect(fs.existsSync(path.dirname(outputPath))).toBe(false);
  });

  it('cleans up when the helper fails', async () => {
    let outputPath = '';
    const result = await captureMacStudioWindow('Place', undefined, async (output) => {
      outputPath = output;
      throw new Error('capture failed');
    });
    expect(result).toEqual({ ok: false, error: 'capture failed' });
    expect(fs.existsSync(path.dirname(outputPath))).toBe(false);
  });
});

describe('bounded macOS helper process runner (no Studio access)', () => {
  it('returns stdout and passes arguments without a shell', async () => {
    const literal = '$(echo surprise); `echo surprise`';
    await expect(runBoundedCaptureProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal], 2000))
      .resolves.toBe(literal);
  });

  it('kills a timed-out child', async () => {
    await expect(runBoundedCaptureProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 100))
      .rejects.toThrow(/timed out/);
  });

  it('kills a child that exceeds the combined output limit', async () => {
    await expect(runBoundedCaptureProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(65537)); setInterval(() => {}, 1000)'], 2000))
      .rejects.toThrow(/output byte limit/);
  });

  it('reports failed starts', async () => {
    await expect(runBoundedCaptureProcess('/does/not/exist/mcp-capture', [], 2000)).rejects.toThrow();
  });
});
