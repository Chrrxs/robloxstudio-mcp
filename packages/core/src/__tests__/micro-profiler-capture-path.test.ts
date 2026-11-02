import fs from 'fs';
import os from 'os';
import * as path from 'path';
import {
  defaultCaptureDirectory,
  pruneDefaultCaptures,
  resolveCapturePath,
  writeCaptureFile,
} from '../micro-profiler/capture.js';

const HOUR_MS = 60 * 60_000;
const NOW = Date.parse('2026-06-01T12:00:00.000Z');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmcp-micro-profiler-path-'));
  jest.spyOn(os, 'tmpdir').mockReturnValue(tmpDir);
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeAged(name: string, ageMs: number): void {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, '');
  const seconds = (NOW - ageMs) / 1000;
  fs.utimesSync(file, seconds, seconds);
}

describe('micro-profiler capture paths', () => {
  test('generated paths for the same time and role differ', async () => {
    const now = new Date('2026-06-01T12:00:00.000Z');
    const first = await resolveCapturePath(undefined, 'client-1', now);
    const second = await resolveCapturePath(undefined, 'client-1', now);
    expect(first.generated).toBe(true);
    expect(second.generated).toBe(true);
    expect(first.path).not.toBe(second.path);
    expect(path.dirname(first.path)).toBe(defaultCaptureDirectory());
    expect(path.basename(first.path)).toMatch(
      new RegExp(`^micro-profiler-2026-06-01T12-00-00-000Z-client-1-${process.pid}-[0-9a-f]{8}\\.gprx$`),
    );
  });

  test('an explicit output_path is not generated', async () => {
    const target = await resolveCapturePath(path.join(tmpDir, 'mine.gprx'), 'server');
    expect(target).toEqual({ path: path.join(tmpDir, 'mine.gprx'), generated: false });
  });

  test('a generated path never overwrites an existing file', async () => {
    const target = await resolveCapturePath(undefined, 'server');
    fs.writeFileSync(target.path, 'other process');
    await expect(writeCaptureFile(target, Buffer.from('new'))).rejects.toMatchObject({ code: 'EEXIST' });
    expect(fs.readFileSync(target.path, 'utf8')).toBe('other process');
  });

  test('an explicit output_path is overwritten', async () => {
    const file = path.join(tmpDir, 'nested', 'mine.gprx');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, 'old');
    await writeCaptureFile({ path: file, generated: false }, Buffer.from('new'));
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
  });
});

describe('pruneDefaultCaptures', () => {
  test('keeps the newest older captures, leaves young ones, and prunes old-format names', async () => {
    // Old-format names (no process ID) from earlier versions.
    writeAged('micro-profiler-2026-01-01T00-00-00-000Z-server.gprx', 5 * HOUR_MS);
    writeAged('micro-profiler-2026-01-01T00-00-00-000Z-server.gprx.window.json', 5 * HOUR_MS);
    writeAged('micro-profiler-2026-01-02T00-00-00-000Z-server-11-aaaaaaaa.gprx', 4 * HOUR_MS);
    writeAged('micro-profiler-2026-01-02T00-00-00-000Z-server-11-aaaaaaaa.gprx.window.json', 4 * HOUR_MS);
    writeAged('micro-profiler-2026-01-03T00-00-00-000Z-server-11-bbbbbbbb.gprx', 3 * HOUR_MS);
    writeAged('micro-profiler-2026-01-04T00-00-00-000Z-client-1.gprx', 2 * HOUR_MS);
    // Just written by another process: younger than the grace period, so kept
    // even though the directory is over the cap.
    writeAged('micro-profiler-2026-05-01T00-00-00-000Z-server-22-cccccccc.gprx', 60_000);
    writeAged('micro-profiler-2026-05-02T00-00-00-000Z-server-22-dddddddd.gprx', 0);
    writeAged('mine.gprx', 5 * HOUR_MS);

    await pruneDefaultCaptures(tmpDir, 2, 10 * 60_000, NOW);

    expect(fs.readdirSync(tmpDir).sort()).toEqual([
      'micro-profiler-2026-01-03T00-00-00-000Z-server-11-bbbbbbbb.gprx',
      'micro-profiler-2026-01-04T00-00-00-000Z-client-1.gprx',
      'micro-profiler-2026-05-01T00-00-00-000Z-server-22-cccccccc.gprx',
      'micro-profiler-2026-05-02T00-00-00-000Z-server-22-dddddddd.gprx',
      'mine.gprx',
    ]);
  });

  test('deletes nothing while every capture is young', async () => {
    for (let day = 1; day <= 4; day++) writeAged(`micro-profiler-2026-05-0${day}T00-00-00-000Z-server-1-0000000${day}.gprx`, 0);
    await pruneDefaultCaptures(tmpDir, 1, 10 * 60_000, NOW);
    expect(fs.readdirSync(tmpDir)).toHaveLength(4);
  });
});
