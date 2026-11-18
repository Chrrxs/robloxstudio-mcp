// Linux (Wine) host capture. Studio runs under Wine on an X display, so the
// server grabs the Studio window through X11: the Studio process's own
// environment names its DISPLAY and XAUTHORITY, _NET_WM_PID (read with xprop)
// maps windows to Studio processes, and a small python3/Xlib helper reads the
// window's composited pixmap (see GRAB_SCRIPT).
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isWineStudioCommand, realUidFromStatus } from './studio-wine.js';
import type { HostCaptureOptions, HostCaptureResult, HostWindowCapture, HostWindowIdentity } from './host-capture.js';

const X_TOOL_TIMEOUT_MS = 10_000;
const MAX_XPROP_OUTPUT_BYTES = 256 * 1024;
const MAX_GRAB_BYTES = 256 * 1024 * 1024;
// Studio opens small helper windows; the main window is far larger.
const MIN_STUDIO_WINDOW_EDGE = 200;

export type X11Session = { display: string; xauthority?: string };

export type LinuxStudioWindow = {
  windowId: number;
  processId: number;
  title: string;
  session: X11Session;
};

export type DecodedWindowGrab = { width: number; height: number; rgba: Buffer };

// Injection seams for tests; the defaults read /proc and run the X tools.
export type LinuxHostCaptureDeps = {
  readFile: (file: string) => Buffer;
  listProcessIds: () => number[];
  runXTool: (executable: string, args: string[], session: X11Session, maxBytes: number) => Promise<Buffer>;
};

// Only DISPLAY and XAUTHORITY are taken from the environment; nothing else in
// it is kept or reported (it can hold credentials).
export function x11SessionFromEnviron(environ: Buffer): X11Session | undefined {
  let display: string | undefined;
  let xauthority: string | undefined;
  for (const entry of environ.toString('utf8').split('\0')) {
    if (entry.startsWith('DISPLAY=')) display = entry.slice('DISPLAY='.length);
    else if (entry.startsWith('XAUTHORITY=')) xauthority = entry.slice('XAUTHORITY='.length);
  }
  return display ? { display, ...(xauthority ? { xauthority } : {}) } : undefined;
}

export const LINUX_NO_STUDIO_DISPLAY_ERROR =
  'no running Roblox Studio process exposes an X11 DISPLAY; Linux host capture needs Studio running under Wine on an X server';

// Only this user's processes are read, as in listWineStudioProcesses: another
// user's Studio is never ours to capture, and its environment is not ours to read.
function ownedByCurrentUser(pid: number, deps: LinuxHostCaptureDeps): boolean {
  const uid = process.getuid?.();
  if (uid === undefined) return true;
  try {
    return realUidFromStatus(deps.readFile(`/proc/${pid}/status`).toString('utf8')) === uid;
  } catch {
    return false;
  }
}

function processSession(pid: number, deps: LinuxHostCaptureDeps): X11Session | undefined {
  if (!ownedByCurrentUser(pid, deps)) return undefined;
  try {
    return x11SessionFromEnviron(deps.readFile(`/proc/${pid}/environ`));
  } catch {
    return undefined;
  }
}

function isStudioProcess(pid: number, deps: LinuxHostCaptureDeps): boolean {
  if (!ownedByCurrentUser(pid, deps)) return false;
  try {
    return isWineStudioCommand(deps.readFile(`/proc/${pid}/cmdline`).toString('utf8').split('\0')[0] || undefined);
  } catch {
    return false;
  }
}

export function runBoundedXTool(executable: string, args: string[], session: X11Session, maxBytes: number): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  // A minimal environment: the X tools need only the display and its cookie.
  // Without XAUTHORITY, Xlib looks for $HOME/.Xauthority (startx/xinit), and
  // HOME is not passed; the processes belong to this user, so it is our home.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    DISPLAY: session.display,
    XAUTHORITY: session.xauthority ?? path.join(os.homedir(), '.Xauthority'),
  };
  const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  let size = 0;
  let stderr = '';
  let failure: Error | undefined;
  const stop = (message: string) => {
    failure ??= new Error(message);
    child.kill('SIGKILL');
  };
  const timer = setTimeout(() => stop(`${executable} timed out after ${X_TOOL_TIMEOUT_MS}ms`), X_TOOL_TIMEOUT_MS);
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > maxBytes) { stop(`${executable} output exceeded ${maxBytes} bytes`); return; }
    chunks.push(chunk);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { if (stderr.length < 4096) stderr += chunk; });
  child.on('error', (error: NodeJS.ErrnoException) => {
    failure ??= error.code === 'ENOENT'
      ? new Error(`${executable} is not installed; Linux host capture needs xprop (x11-utils) and python3 with libX11`)
      : error;
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (failure) reject(failure);
    else if (code !== 0) reject(new Error(`${executable} exited with code ${code}: ${stderr.trim().slice(0, 600)}`));
    else resolve(Buffer.concat(chunks));
  });
  return promise;
}

const DEFAULT_DEPS: LinuxHostCaptureDeps = {
  readFile: (file) => fs.readFileSync(file),
  listProcessIds: () => fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)).map(Number),
  runXTool: runBoundedXTool,
};

export function parseClientList(output: string): number[] {
  const match = /#\s*(.*)$/m.exec(output);
  if (!match) return [];
  return match[1].split(',').map((id) => Number.parseInt(id.trim(), 16)).filter((id) => Number.isSafeInteger(id) && id > 0);
}

function propertyValue(output: string, name: string): string | undefined {
  const line = output.split('\n').find((candidate) => candidate.startsWith(`${name}`) && /[=:]/.test(candidate.slice(name.length, name.length + 3)));
  if (!line) return undefined;
  const value = line.slice(line.search(/[=:]/) + 1).trim();
  return value === '' || value.startsWith('not found') ? undefined : value;
}

function unquote(value: string | undefined): string {
  if (!value) return '';
  const match = /^"(.*)"$/s.exec(value);
  return (match ? match[1] : value).replace(/\\(.)/g, '$1');
}

export type X11WindowProperties = { processId?: number; title: string; hidden: boolean };

export function parseWindowProperties(output: string): X11WindowProperties {
  const pid = Number(propertyValue(output, '_NET_WM_PID'));
  const title = unquote(propertyValue(output, '_NET_WM_NAME') ?? propertyValue(output, 'WM_NAME'));
  const state = propertyValue(output, '_NET_WM_STATE') ?? '';
  return {
    ...(Number.isSafeInteger(pid) && pid > 0 ? { processId: pid } : {}),
    title,
    hidden: state.includes('_NET_WM_STATE_HIDDEN'),
  };
}

async function studioWindowsOnSession(
  session: X11Session,
  deps: LinuxHostCaptureDeps,
  studioProcess: (pid: number) => boolean,
): Promise<LinuxStudioWindow[]> {
  const list = (await deps.runXTool('xprop', ['-root', '-notype', '_NET_CLIENT_LIST'], session, MAX_XPROP_OUTPUT_BYTES)).toString('utf8');
  const windows: LinuxStudioWindow[] = [];
  for (const windowId of parseClientList(list)) {
    let output: string;
    try {
      output = (await deps.runXTool('xprop', ['-id', `0x${windowId.toString(16)}`, '-notype', '_NET_WM_PID', '_NET_WM_NAME', 'WM_NAME', '_NET_WM_STATE'], session, MAX_XPROP_OUTPUT_BYTES)).toString('utf8');
    } catch {
      continue; // The window closed between listing and inspection.
    }
    const properties = parseWindowProperties(output);
    if (properties.processId === undefined || properties.hidden || !studioProcess(properties.processId)) continue;
    windows.push({ windowId, processId: properties.processId, title: properties.title, session });
  }
  return windows;
}

// Grabs one window through Xlib (python3 + ctypes; no build step, no extra
// package). It names the composited backing pixmap of the window's top-level
// frame, so the grab is the window's own content in full, even where other
// windows cover it or it hangs off the screen. Without a compositor it reads
// the window's on-screen part from the root window instead. Output: one JSON
// header line, then the raw ZPixmap rows.
const GRAB_SCRIPT = String.raw`
import ctypes, json, sys
from ctypes import POINTER, Structure, byref, c_char_p, c_int, c_long, c_uint, c_ulong, c_void_p
class XImage(Structure):
    _fields_ = [('width', c_int), ('height', c_int), ('xoffset', c_int), ('format', c_int), ('data', c_void_p),
                ('byte_order', c_int), ('bitmap_unit', c_int), ('bitmap_bit_order', c_int), ('bitmap_pad', c_int),
                ('depth', c_int), ('bytes_per_line', c_int), ('bits_per_pixel', c_int),
                ('red_mask', c_ulong), ('green_mask', c_ulong), ('blue_mask', c_ulong)]
def fail(code, message):
    sys.stderr.write(message)
    sys.exit(code)
x11 = ctypes.CDLL('libX11.so.6')
x11.XOpenDisplay.restype = c_void_p
x11.XOpenDisplay.argtypes = [c_char_p]
x11.XQueryTree.argtypes = [c_void_p, c_ulong, POINTER(c_ulong), POINTER(c_ulong), POINTER(c_void_p), POINTER(c_uint)]
x11.XGetGeometry.argtypes = [c_void_p, c_ulong, POINTER(c_ulong), POINTER(c_int), POINTER(c_int), POINTER(c_uint), POINTER(c_uint), POINTER(c_uint), POINTER(c_uint)]
x11.XTranslateCoordinates.argtypes = [c_void_p, c_ulong, c_ulong, c_int, c_int, POINTER(c_int), POINTER(c_int), POINTER(c_ulong)]
x11.XGetImage.restype = POINTER(XImage)
x11.XGetImage.argtypes = [c_void_p, c_ulong, c_int, c_int, c_uint, c_uint, c_ulong, c_int]
x11.XFree.argtypes = [c_void_p]
x11.XFreePixmap.argtypes = [c_void_p, c_ulong]
x11.XSync.argtypes = [c_void_p, c_int]
errors = []
HANDLER = ctypes.CFUNCTYPE(c_int, c_void_p, c_void_p)
def on_error(display, event):
    errors.append(1)
    return 0
handler = HANDLER(on_error)
x11.XSetErrorHandler(handler)
display = x11.XOpenDisplay(None)
if not display:
    fail(2, 'cannot open the X display')
window = int(sys.argv[1], 0)
root = c_ulong(); parent = c_ulong(); children = c_void_p(); count = c_uint()
top = window
while True:
    if not x11.XQueryTree(display, top, byref(root), byref(parent), byref(children), byref(count)):
        fail(3, 'the window closed')
    if children:
        x11.XFree(children)
    if parent.value == root.value:
        break
    top = parent.value
gx = c_int(); gy = c_int(); width = c_uint(); height = c_uint(); border = c_uint(); depth = c_uint(); child = c_ulong()
x11.XGetGeometry(display, window, byref(c_ulong()), byref(gx), byref(gy), byref(width), byref(height), byref(border), byref(depth))
image = None
source = 'composite'
try:
    composite = ctypes.CDLL('libXcomposite.so.1')
    composite.XCompositeNameWindowPixmap.restype = c_ulong
    composite.XCompositeNameWindowPixmap.argtypes = [c_void_p, c_ulong]
    ox = c_int(); oy = c_int()
    x11.XTranslateCoordinates(display, window, top, 0, 0, byref(ox), byref(oy), byref(child))
    pixmap = composite.XCompositeNameWindowPixmap(display, top)
    x11.XSync(display, 0)
    if pixmap and not errors:
        image = x11.XGetImage(display, pixmap, ox.value, oy.value, width.value, height.value, 0xFFFFFFFF, 2)
        x11.XSync(display, 0)
        x11.XFreePixmap(display, pixmap)
    if errors:
        image = None
except OSError:
    pass
if not image:
    del errors[:]
    source = 'screen'
    # The root window shows whatever is on screen there; an unmapped Studio
    # (minimized, other workspace) would yield other windows' pixels.
    class XWindowAttributes(Structure):
        _fields_ = [('x', c_int), ('y', c_int), ('width', c_int), ('height', c_int), ('border_width', c_int), ('depth', c_int),
                    ('visual', c_void_p), ('root', c_ulong), ('cls', c_int), ('bit_gravity', c_int), ('win_gravity', c_int),
                    ('backing_store', c_int), ('backing_planes', c_ulong), ('backing_pixel', c_ulong), ('save_under', c_int),
                    ('colormap', c_ulong), ('map_installed', c_int), ('map_state', c_int), ('all_event_masks', c_long),
                    ('your_event_mask', c_long), ('do_not_propagate_mask', c_long), ('override_redirect', c_int), ('screen', c_void_p)]
    x11.XGetWindowAttributes.argtypes = [c_void_p, c_ulong, POINTER(XWindowAttributes)]
    attributes = XWindowAttributes()
    if not x11.XGetWindowAttributes(display, window, byref(attributes)) or errors:
        fail(3, 'the window closed')
    if attributes.map_state != 2:  # IsViewable: the window and all its ancestors are mapped
        fail(6, 'Studio window is not visible on screen (minimized or on another workspace?) and the display has no compositor')
    ax = c_int(); ay = c_int(); rw = c_uint(); rh = c_uint()
    x11.XTranslateCoordinates(display, window, root.value, 0, 0, byref(ax), byref(ay), byref(child))
    x11.XGetGeometry(display, root.value, byref(c_ulong()), byref(gx), byref(gy), byref(rw), byref(rh), byref(border), byref(depth))
    x0 = max(0, ax.value); y0 = max(0, ay.value)
    x1 = min(rw.value, ax.value + width.value); y1 = min(rh.value, ay.value + height.value)
    if x1 <= x0 or y1 <= y0:
        fail(4, 'the window is entirely off-screen and the display has no compositor')
    image = x11.XGetImage(display, root.value, x0, y0, x1 - x0, y1 - y0, 0xFFFFFFFF, 2)
    x11.XSync(display, 0)
    if not image or errors:
        fail(5, 'XGetImage failed')
data = image.contents
masks = [data.red_mask, data.green_mask, data.blue_mask]
if not all(masks):
    # Images of pixmaps carry no masks; the pixmap uses the screen's visual.
    class Visual(Structure):
        _fields_ = [('ext_data', c_void_p), ('visualid', c_ulong), ('cls', c_int),
                    ('red_mask', c_ulong), ('green_mask', c_ulong), ('blue_mask', c_ulong)]
    x11.XDefaultVisual.restype = POINTER(Visual)
    x11.XDefaultVisual.argtypes = [c_void_p, c_int]
    x11.XDefaultScreen.argtypes = [c_void_p]
    visual = x11.XDefaultVisual(display, x11.XDefaultScreen(display)).contents
    masks = [visual.red_mask, visual.green_mask, visual.blue_mask]
header = {'width': data.width, 'height': data.height, 'bitsPerPixel': data.bits_per_pixel, 'bytesPerLine': data.bytes_per_line,
          'byteOrder': data.byte_order, 'redMask': masks[0], 'greenMask': masks[1], 'blueMask': masks[2], 'source': source}
out = sys.stdout.buffer
out.write(json.dumps(header).encode() + b'\n')
out.write(ctypes.string_at(data.data, data.bytes_per_line * data.height))
out.flush()
`;

export type WindowGrabHeader = {
  width: number;
  height: number;
  bitsPerPixel: number;
  bytesPerLine: number;
  byteOrder: number;
  redMask: number;
  greenMask: number;
  blueMask: number;
  source: 'composite' | 'screen';
};

// Decodes the grab helper's output (a JSON header line, then 24- or 32-bit
// TrueColor ZPixmap rows in the image's own byte order) into RGBA.
export function decodeWindowGrab(data: Buffer): DecodedWindowGrab {
  const newline = data.indexOf(0x0a);
  if (newline < 0) throw new Error('the window grab returned no header');
  const header = JSON.parse(data.subarray(0, newline).toString('utf8')) as WindowGrabHeader;
  const { width, height, bitsPerPixel, bytesPerLine, byteOrder } = header;
  const start = newline + 1;
  if (bitsPerPixel !== 32 && bitsPerPixel !== 24) throw new Error(`unsupported pixel size ${bitsPerPixel} bits (need a 24-bit TrueColor display)`);
  if (!(width > 0 && height > 0)) throw new Error('the window grab returned an empty image');
  if (bytesPerLine < width * (bitsPerPixel / 8) || data.length < start + bytesPerLine * height) {
    throw new Error('the window grab output is truncated');
  }
  const channels = [header.redMask, header.greenMask, header.blueMask].map((mask) => {
    if (!mask) throw new Error('the window grab has no colour masks');
    let shift = 0;
    while (((mask >>> shift) & 1) === 0) shift++;
    return { mask, shift, max: mask >>> shift };
  });
  const bytesPerPixel = bitsPerPixel / 8;
  const little = byteOrder === 0;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    let src = start + y * bytesPerLine;
    let dst = y * width * 4;
    for (let x = 0; x < width; x++) {
      const pixel = bytesPerPixel === 4
        ? (little ? data.readUInt32LE(src) : data.readUInt32BE(src))
        : (little ? data[src] | (data[src + 1] << 8) | (data[src + 2] << 16) : (data[src] << 16) | (data[src + 1] << 8) | data[src + 2]);
      for (let c = 0; c < 3; c++) {
        const { mask, shift, max } = channels[c];
        const value = (pixel & mask) >>> shift;
        rgba[dst + c] = max === 255 ? value : Math.round((value * 255) / max);
      }
      rgba[dst + 3] = 255;
      src += bytesPerPixel;
      dst += 4;
    }
  }
  return { width, height, rgba };
}

async function grabWindow(window: LinuxStudioWindow, deps: LinuxHostCaptureDeps): Promise<HostWindowCapture> {
  const output = await deps.runXTool('python3', ['-c', GRAB_SCRIPT, `0x${window.windowId.toString(16)}`], window.session, MAX_GRAB_BYTES);
  const { width, height, rgba } = decodeWindowGrab(output);
  const identity: HostWindowIdentity = { windowId: window.windowId, processId: window.processId, bundleIdentifier: `x11${window.session.display}` };
  return { width, height, rgba, title: window.title, identity };
}

// Sessions to search: the hinted Studio process's display first, then every
// other display that runs Studio (multiplayer clients share their parent's).
function candidateSessions(processId: number | undefined, deps: LinuxHostCaptureDeps): { sessions: X11Session[]; studioPids: Set<number> } {
  const studioPids = new Set<number>();
  for (const pid of deps.listProcessIds()) {
    if (isStudioProcess(pid, deps)) studioPids.add(pid);
  }
  const sessions: X11Session[] = [];
  const add = (session: X11Session | undefined) => {
    if (session && !sessions.some((existing) => existing.display === session.display && existing.xauthority === session.xauthority)) sessions.push(session);
  };
  if (processId !== undefined) add(processSession(processId, deps));
  for (const pid of studioPids) add(processSession(pid, deps));
  return { sessions, studioPids };
}

// Cheap pre-check (a /proc scan, no X round trip): whether any Studio session
// with an X display exists, so callers skip the plugin's marker transaction
// (simulator fit, magenta markers) when no window grab could run.
export function hasLinuxStudioX11Session(deps: LinuxHostCaptureDeps = DEFAULT_DEPS): boolean {
  try {
    return candidateSessions(undefined, deps).sessions.length > 0;
  } catch {
    return false;
  }
}

// Captures one Studio window. With expectedIdentity it re-grabs exactly that
// window. Otherwise windows of options.processId come first, then windows whose
// title contains titleHint; options.accept picks among several (the caller
// checks for its viewport markers).
export async function captureLinuxStudioWindow(
  titleHint?: string,
  expectedIdentity?: HostWindowIdentity,
  options: HostCaptureOptions = {},
  deps: LinuxHostCaptureDeps = DEFAULT_DEPS,
): Promise<HostCaptureResult> {
  try {
    if (expectedIdentity) {
      // Re-grab exactly the located window: same display, same owning process.
      const session = processSession(expectedIdentity.processId, deps);
      const windowArg = `0x${expectedIdentity.windowId.toString(16)}`;
      const changed = { ok: false as const, error: 'the Studio window identity changed or the window closed; retry the capture' };
      if (!session || `x11${session.display}` !== expectedIdentity.bundleIdentifier) return changed;
      let properties: X11WindowProperties;
      try {
        properties = parseWindowProperties((await deps.runXTool('xprop', ['-id', windowArg, '-notype', '_NET_WM_PID', '_NET_WM_NAME', 'WM_NAME', '_NET_WM_STATE'], session, MAX_XPROP_OUTPUT_BYTES)).toString('utf8'));
      } catch {
        return changed;
      }
      if (properties.processId !== expectedIdentity.processId) return changed;
      if (properties.hidden) return { ok: false, error: 'the Studio window is minimized; restore it and retry the capture' };
      return { ok: true, capture: await grabWindow({ windowId: expectedIdentity.windowId, processId: expectedIdentity.processId, title: properties.title, session }, deps) };
    }

    const { sessions, studioPids } = candidateSessions(options.processId, deps);
    if (options.processId !== undefined) studioPids.add(options.processId);
    if (sessions.length === 0) return { ok: false, error: LINUX_NO_STUDIO_DISPLAY_ERROR };
    const studioProcess = (pid: number) => studioPids.has(pid) || isStudioProcess(pid, deps);
    const rank = (window: LinuxStudioWindow) =>
      (window.processId === options.processId ? 0 : 2) + (titleHint && window.title.includes(titleHint) ? 0 : 1);

    // Sessions are searched lazily: the hinted Studio's display usually holds
    // the viewport, so other displays are listed only when it does not.
    let first: HostWindowCapture | undefined;
    let lastError: string | undefined;
    let windowsSeen = 0;
    for (const session of sessions) {
      let windows: LinuxStudioWindow[];
      try {
        windows = await studioWindowsOnSession(session, deps, studioProcess);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        continue; // A stale display of an orphaned Studio must not block the others.
      }
      windowsSeen += windows.length;
      const ordered = windows.map((window, index) => ({ window, index }))
        .sort((a, b) => rank(a.window) - rank(b.window) || a.index - b.index)
        .map(({ window }) => window);
      for (const window of ordered) {
        let capture: HostWindowCapture;
        try {
          capture = await grabWindow(window, deps);
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          continue;
        }
        if (capture.width < MIN_STUDIO_WINDOW_EDGE || capture.height < MIN_STUDIO_WINDOW_EDGE) continue;
        if (!options.accept || options.accept(capture)) return { ok: true, capture };
        first ??= capture;
      }
    }
    // Nothing matched: return the best candidate so the caller reports why.
    if (first) return { ok: true, capture: first };
    if (windowsSeen === 0 && lastError === undefined) {
      return { ok: false, error: 'no visible Roblox Studio window was found on the X display (is it minimized or on another workspace?)' };
    }
    return { ok: false, error: lastError ?? 'no Roblox Studio window on the X display is large enough to hold a viewport' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
