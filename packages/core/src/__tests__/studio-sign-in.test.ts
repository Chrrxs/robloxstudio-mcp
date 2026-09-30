import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  fileTimeToUnixMs, parseStudioSignIn, readStudioSignInSessions, studioSessionLogStartMs, waitForStudioSignInToSettle,
} from '../studio-sign-in.js';

const START = '[FLog::StudioKeyEvents] login (automatic) [start]';
const line = (time: string, text: string) => `${time},0.8,766c,6,Info ${text}`;

describe('Studio sign-in settling (log event names only)', () => {
  let logsRoot: string;
  const processStartedAtMs = Date.UTC(2026, 8, 30, 15, 3, 53, 400);
  const name = '0.741.19.7411056_20260930T150353Z_Studio_6FDD2_last.log';

  beforeEach(() => { logsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-sign-in-')); });
  afterEach(() => { fs.rmSync(logsRoot, { recursive: true, force: true }); });

  function clock(start: number) {
    const state = { time: start, sleeps: [] as number[] };
    return { state, now: () => state.time, sleep: async (ms: number) => { state.sleeps.push(ms); state.time += ms; } };
  }

  test('derives session start from the log name and process start from FILETIME', () => {
    expect(studioSessionLogStartMs(name)).toBe(Date.UTC(2026, 8, 30, 15, 3, 53));
    expect(studioSessionLogStartMs('RobloxStudioInstaller_8FF59.log')).toBeUndefined();
    expect(fileTimeToUnixMs('116444736000000000')).toBe(0);
    const ms = Date.UTC(2026, 8, 30, 15, 3, 53, 400);
    expect(fileTimeToUnixMs(String(BigInt(ms) * 10000n + 116444736000000000n + 9999n))).toBe(ms);
  });

  test('tracks start, end, outcome and end time without reading other content', () => {
    expect(parseStudioSignIn(name, [line('2026-09-30T15:03:53.816Z', START)].join('\r\n')))
      .toEqual({ name, signingIn: true });
    expect(parseStudioSignIn(name, [
      line('2026-09-30T15:03:53.816Z', START),
      line('2026-09-30T15:03:54.000Z', '[FLog::StudioKeyEvents] login [end][failure]'),
      line('2026-09-30T15:04:10.000Z', '[FLog::StudioKeyEvents] login (manual) [start]'),
      line('2026-09-30T15:04:12.500Z', '[FLog::StudioKeyEvents] login [end][success]'),
    ].join('\n'))).toEqual({ name, signingIn: false, outcome: 'success', lastEndMs: Date.parse('2026-09-30T15:04:12.500Z') });
  });

  test('only sessions that began around the process start are considered', async () => {
    fs.writeFileSync(path.join(logsRoot, name), line('2026-09-30T15:03:53.816Z', START));
    fs.writeFileSync(path.join(logsRoot, '0.741.19.7411056_20260930T144942Z_Studio_E04C6_last.log'), line('x', START));
    fs.writeFileSync(path.join(logsRoot, 'RobloxStudioInstaller_8FF59.log'), START);
    await expect(readStudioSignInSessions(logsRoot, processStartedAtMs - 2000, processStartedAtMs + 30000))
      .resolves.toEqual([{ name, signingIn: true }]);
    await expect(readStudioSignInSessions(path.join(logsRoot, 'missing'), 0, Number.MAX_SAFE_INTEGER)).resolves.toEqual([]);
  });

  test('an in-progress sign-in blocks termination until it ends, then allows a persistence period', async () => {
    const file = path.join(logsRoot, name);
    fs.writeFileSync(file, line('2026-09-30T15:03:53.816Z', START));
    const time = clock(processStartedAtMs + 1000);
    const sleep = async (ms: number) => {
      await time.sleep(ms);
      if (time.state.time >= processStartedAtMs + 3000 && !fs.readFileSync(file, 'utf8').includes('[end]')) {
        fs.appendFileSync(file, `\n${line(new Date(time.state.time).toISOString(), '[FLog::StudioKeyEvents] login [end][success]')}`);
      }
    };
    await expect(waitForStudioSignInToSettle({ logsRoot, processStartedAtMs, now: time.now, sleep })).resolves.toBe('settled');
    expect(time.state.time).toBeGreaterThanOrEqual(processStartedAtMs + 3000 + 1500);
  });

  test('a sign-in that never ends is bounded', async () => {
    fs.writeFileSync(path.join(logsRoot, name), line('2026-09-30T15:03:53.816Z', START));
    const time = clock(processStartedAtMs + 1000);
    await expect(waitForStudioSignInToSettle({ logsRoot, processStartedAtMs, timeoutMs: 15_000, ...time }))
      .resolves.toBe('timeout');
    expect(time.state.time - (processStartedAtMs + 1000)).toBeGreaterThanOrEqual(15_000);
  });

  test('a young Studio is given time to start signing in; an old idle one is closed at once', async () => {
    const young = clock(processStartedAtMs + 500);
    await expect(waitForStudioSignInToSettle({ logsRoot, processStartedAtMs, ...young })).resolves.toBe('idle');
    expect(young.state.time).toBeGreaterThanOrEqual(processStartedAtMs + 5000);
    const old = clock(processStartedAtMs + 600_000);
    fs.writeFileSync(path.join(logsRoot, name), [
      line('2026-09-30T15:03:53.816Z', START),
      line('2026-09-30T15:03:54.100Z', '[FLog::StudioKeyEvents] login [end][success]'),
    ].join('\n'));
    await expect(waitForStudioSignInToSettle({ logsRoot, processStartedAtMs, ...old })).resolves.toBe('settled');
    expect(old.state.sleeps).toEqual([]);
  });
});
