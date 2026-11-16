import {
  captureLinuxStudioWindow,
  decodeWindowGrab,
  parseClientList,
  parseWindowProperties,
  x11SessionFromEnviron,
} from '../host-capture-linux.js';
import type { LinuxHostCaptureDeps, X11Session } from '../host-capture-linux.js';
import { isHostCapturePreferred, isHostCaptureSupported } from '../host-capture.js';

type Rgb = [number, number, number];

// The grab helper's wire format: a JSON header line, then 32-bit
// little-endian TrueColor rows (X's usual BGRX layout), optionally padded.
function grabOutput(width: number, height: number, rgb: Rgb, padding = 0): Buffer {
  const bytesPerLine = width * 4 + padding;
  const header = { width, height, bitsPerPixel: 32, bytesPerLine, byteOrder: 0, redMask: 0xff0000, greenMask: 0xff00, blueMask: 0xff, source: 'composite' };
  const rows = Buffer.alloc(bytesPerLine * height, 0xee);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rows.writeUInt32LE(((rgb[0] << 16) | (rgb[1] << 8) | rgb[2]) >>> 0, y * bytesPerLine + x * 4);
  }
  return Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), rows]);
}

type FakeWindow = { id: number; pid?: number; title: string; hidden?: boolean; size?: [number, number]; rgb?: Rgb };
type FakeProcess = { cmdline: string; environ?: string };

// /proc and the X tools of a fake host: processes by pid, windows by display.
function fakeHost(processes: Record<number, FakeProcess>, displays: Record<string, FakeWindow[]>, broken: string[] = []) {
  const calls: Array<{ executable: string; args: string[]; session: X11Session }> = [];
  const deps: LinuxHostCaptureDeps = {
    readFile: (file) => {
      const match = /^\/proc\/(\d+)\/(environ|cmdline)$/.exec(file);
      const process = match ? processes[Number(match[1])] : undefined;
      const value = match?.[2] === 'environ' ? process?.environ : process?.cmdline;
      if (value === undefined) throw new Error(`ENOENT ${file}`);
      return Buffer.from(value);
    },
    listProcessIds: () => Object.keys(processes).map(Number),
    runXTool: async (executable, args, session) => {
      calls.push({ executable, args, session });
      if (broken.includes(session.display)) throw new Error(`cannot open display ${session.display}`);
      const windows = displays[session.display] ?? [];
      if (executable === 'xprop' && args[0] === '-root') {
        return Buffer.from(`_NET_CLIENT_LIST: window id # ${windows.map((window) => `0x${window.id.toString(16)}`).join(', ')}\n`);
      }
      const window = windows.find((candidate) => candidate.id === Number.parseInt(executable === 'xprop' ? args[1] : args[2], 16));
      if (!window) throw new Error('BadWindow');
      if (executable === 'xprop') {
        return Buffer.from([
          window.pid === undefined ? '_NET_WM_PID:  not found.' : `_NET_WM_PID = ${window.pid}`,
          `_NET_WM_NAME = "${window.title}"`,
          `_NET_WM_STATE = ${window.hidden ? '_NET_WM_STATE_HIDDEN' : ''}`,
        ].join('\n'));
      }
      const [width, height] = window.size ?? [640, 480];
      return grabOutput(width, height, window.rgb ?? [10, 20, 30]);
    },
  };
  return { deps, calls };
}

const studio = (environ: string): FakeProcess => ({ cmdline: 'C:\\Program Files\\Roblox\\RobloxStudioBeta.exe\0-task\0', environ });
const SECRET = 'ROBLOSECURITY=do-not-leak';

describe('Linux X11 session and xprop parsing', () => {
  test('keeps only DISPLAY and XAUTHORITY from a process environment', () => {
    const session = x11SessionFromEnviron(Buffer.from(`HOME=/home/a\0DISPLAY=:124\0${SECRET}\0XAUTHORITY=/tmp/xauth\0`));
    expect(session).toEqual({ display: ':124', xauthority: '/tmp/xauth' });
    expect(x11SessionFromEnviron(Buffer.from('DISPLAY=:7\0'))).toEqual({ display: ':7' });
    expect(x11SessionFromEnviron(Buffer.from(`XAUTHORITY=/tmp/x\0${SECRET}\0`))).toBeUndefined();
  });

  test('parses the client list and window properties', () => {
    expect(parseClientList('_NET_CLIENT_LIST: window id # 0x2c00004, 0x200529\n')).toEqual([0x2c00004, 0x200529]);
    expect(parseClientList('_NET_CLIENT_LIST:  no such atom on any window.')).toEqual([]);
    expect(parseWindowProperties('_NET_WM_PID = 1101162\n_NET_WM_NAME = "Place \\"A\\" - Roblox Studio"\n_NET_WM_STATE = _NET_WM_STATE_HIDDEN'))
      .toEqual({ processId: 1101162, title: 'Place "A" - Roblox Studio', hidden: true });
    expect(parseWindowProperties('_NET_WM_PID:  not found.\n_NET_WM_NAME:  not found.\nWM_NAME = "fallback"\n_NET_WM_STATE = '))
      .toEqual({ title: 'fallback', hidden: false });
  });
});

describe('decodeWindowGrab', () => {
  test('decodes padded 32-bit little-endian rows into RGBA', () => {
    const decoded = decodeWindowGrab(grabOutput(2, 2, [200, 100, 50], 8));
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    expect([...decoded.rgba]).toEqual([200, 100, 50, 255, 200, 100, 50, 255, 200, 100, 50, 255, 200, 100, 50, 255]);
  });

  test('decodes 24-bit big-endian rows', () => {
    const header = { width: 1, height: 1, bitsPerPixel: 24, bytesPerLine: 4, byteOrder: 1, redMask: 0xff0000, greenMask: 0xff00, blueMask: 0xff, source: 'screen' };
    const decoded = decodeWindowGrab(Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), Buffer.from([1, 2, 3, 0])]));
    expect([...decoded.rgba]).toEqual([1, 2, 3, 255]);
  });

  test('rejects truncated output and unsupported pixel sizes', () => {
    const full = grabOutput(4, 4, [1, 1, 1]);
    expect(() => decodeWindowGrab(full.subarray(0, full.length - 1))).toThrow(/truncated/);
    expect(() => decodeWindowGrab(Buffer.from('no header'))).toThrow(/no header/);
    const header = { width: 1, height: 1, bitsPerPixel: 16, bytesPerLine: 2, byteOrder: 0, redMask: 0xf800, greenMask: 0x7e0, blueMask: 0x1f, source: 'screen' };
    expect(() => decodeWindowGrab(Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), Buffer.alloc(2)]))).toThrow(/24-bit/);
  });
});

describe('captureLinuxStudioWindow', () => {
  test('grabs the hinted Studio window with only the display and its cookie', async () => {
    const { deps, calls } = fakeHost(
      { 100: studio(`DISPLAY=:124\0XAUTHORITY=/tmp/a\0${SECRET}\0`), 300: { cmdline: '/usr/bin/xterm\0', environ: 'DISPLAY=:124\0' } },
      { ':124': [
        { id: 0x10, pid: 300, title: 'Studio Place - Roblox Studio' },
        { id: 0x20, pid: 100, title: 'Place splash', size: [120, 80] },
        { id: 0x30, pid: 100, title: 'Hidden', hidden: true },
        { id: 0x40, pid: 100, title: 'Place - Roblox Studio', rgb: [9, 8, 7] },
      ] },
    );
    const result = await captureLinuxStudioWindow('Place', undefined, { processId: 100 }, deps);
    if (!result.ok) throw new Error(result.error);
    expect(result.capture.identity).toEqual({ windowId: 0x40, processId: 100, bundleIdentifier: 'x11:124' });
    expect([...result.capture.rgba.subarray(0, 4)]).toEqual([9, 8, 7, 255]);
    expect(calls.every((call) => JSON.stringify(call.session) === JSON.stringify({ display: ':124', xauthority: '/tmp/a' }))).toBe(true);
    expect(calls.filter((call) => call.executable === 'python3').map((call) => call.args[2])).toEqual(['0x20', '0x40']);
  });

  test('accept selects the window that shows the viewport markers, else the first candidate returns', async () => {
    const host = fakeHost({ 100: studio('DISPLAY=:1\0'), 101: studio('DISPLAY=:1\0') }, { ':1': [
      { id: 0x1, pid: 100, title: 'Place - Roblox Studio', rgb: [1, 1, 1] },
      { id: 0x2, pid: 101, title: 'Place - Server', rgb: [255, 0, 255] },
    ] });
    const accepted = await captureLinuxStudioWindow('Place', undefined, { processId: 100, accept: (capture) => capture.rgba[0] === 255 }, host.deps);
    expect(accepted.ok && accepted.capture.identity?.windowId).toBe(0x2);
    const fallback = await captureLinuxStudioWindow('Place', undefined, { processId: 100, accept: () => false }, host.deps);
    expect(fallback.ok && fallback.capture.identity?.windowId).toBe(0x1);
  });

  test('a stale display of an orphaned Studio does not block a live one', async () => {
    const { deps } = fakeHost({ 7: studio('DISPLAY=:99\0'), 8: studio('DISPLAY=:124\0') }, { ':124': [{ id: 0x5, pid: 8, title: 'Place' }] }, [':99']);
    const result = await captureLinuxStudioWindow(undefined, undefined, { processId: 7 }, deps);
    expect(result.ok && result.capture.identity).toEqual({ windowId: 0x5, processId: 8, bundleIdentifier: 'x11:124' });
  });

  test('re-grabs an identified window directly and refuses a changed owner or display', async () => {
    const host = fakeHost({ 100: studio('DISPLAY=:124\0') }, { ':124': [{ id: 0x40, pid: 100, title: 'Place' }] });
    const identity = { windowId: 0x40, processId: 100, bundleIdentifier: 'x11:124' };
    const again = await captureLinuxStudioWindow('Place', identity, {}, host.deps);
    expect(again.ok && again.capture.identity).toEqual(identity);
    expect(host.calls.some((call) => call.args[0] === '-root')).toBe(false);

    for (const changed of [{ ...identity, processId: 101 }, { ...identity, bundleIdentifier: 'x11:5' }, { ...identity, windowId: 0x41 }]) {
      const result = await captureLinuxStudioWindow('Place', changed, {}, fakeHost({ 100: studio('DISPLAY=:124\0'), 101: studio('DISPLAY=:124\0') }, { ':124': [{ id: 0x40, pid: 100, title: 'Place' }] }).deps);
      expect(result).toEqual({ ok: false, error: expect.stringContaining('identity changed') });
    }
  });

  test('explains a host without a Studio display or window', async () => {
    const none = await captureLinuxStudioWindow('Place', undefined, {}, fakeHost({ 1: { cmdline: '/sbin/init\0', environ: 'DISPLAY=:0\0' } }, {}).deps);
    expect(none).toEqual({ ok: false, error: expect.stringContaining('no running Roblox Studio process exposes an X11 DISPLAY') });
    const hidden = await captureLinuxStudioWindow('Place', undefined, {}, fakeHost({ 100: studio('DISPLAY=:1\0') }, { ':1': [{ id: 0x1, pid: 100, title: 'Place', hidden: true }] }).deps);
    expect(hidden).toEqual({ ok: false, error: expect.stringContaining('no visible Roblox Studio window') });
  });
});

describe('Linux host capture selection', () => {
  test('is supported on Linux and preferred there unless disabled', () => {
    expect(isHostCaptureSupported('linux')).toBe(true);
    expect(isHostCapturePreferred('linux', {})).toBe(true);
    expect(isHostCapturePreferred('linux', { ROBLOX_STUDIO_HOST_CAPTURE: '0' })).toBe(false);
    expect(isHostCapturePreferred('win32', {})).toBe(false);
  });
});
