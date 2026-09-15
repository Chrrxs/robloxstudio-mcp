// Host-side Studio window capture.
//
// Roblox's in-engine capture APIs cannot always see the play viewport:
// StudioCaptureService refuses the play client (CanCaptureScreenshot() is
// false and RequestScreenshotPermissionAsync raises "Feature not supported
// yet"), and CaptureService:CaptureScreenshot returns a fully black frame from
// the play client on some Studio builds (observed with the Vulkan renderer),
// while the edit DataModel is simply not rendered during a playtest. None of
// that depends on the Studio window being focused: the client keeps rendering
// at full rate behind other windows.
//
// So when Studio hands back nothing usable, the MCP server grabs the Studio
// window itself through the host OS. On Windows PrintWindow(PW_RENDERFULLCONTENT)
// asks DWM for the window's composited surface, which works while the window
// is behind other windows (only a minimized window has no surface). The plugin
// pins four magenta squares to the viewport corners so the window capture can
// be cropped to exactly the viewport — the coordinate space simulate_mouse_input
// expects — without guessing at Studio's dock layout or the DPI scale.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type HostCaptureMethod = 'printwindow' | 'screen';

export type StudioWindowInfo = {
  handle: number;
  pid: number;
  title: string;
  placeName: string;
  isIconic: boolean;
};

export type HostWindowCapture = {
  width: number;
  height: number;
  rgba: Buffer;
  title: string;
  handle: number;
  method: HostCaptureMethod;
  clientOrigin: { x: number; y: number };
  restored: boolean;
  foreground: boolean;
  magentaPixels: Partial<Record<HostCaptureMethod, number>>;
};

export type HostCaptureResult =
  | { ok: true; capture: HostWindowCapture }
  | { ok: false; error: string };

export type HostCaptureOptions = {
  method?: HostCaptureMethod | 'auto';
  foreground?: boolean;
  pid?: number;
};

export type StudioWindowListResult =
  | { ok: true; windows: StudioWindowInfo[] }
  | { ok: false; error: string };

export type ViewportRect = { x: number; y: number; width: number; height: number };

export type ViewportClip = { edge: 'top' | 'bottom'; pixels: number };

export type ViewportLocateResult =
  | { rect: ViewportRect; markerPixels: number; scaleX: number; scaleY: number; clipped?: ViewportClip }
  | { error: string; branch: 'none' | 'rectangle'; markerPixels: number };

export type ViewportMarkerHint = {
  viewportWidth: number;
  viewportHeight: number;
  markerSize: number;
};

const HOST_CAPTURE_TIMEOUT_MS = 20_000;
// Marker colour is pure magenta; allow for colour management / compositor rounding.
const MARKER_MIN_RB = 200;
const MARKER_MAX_G = 60;
const STUDIO_TITLE_SUFFIX = ' - Roblox Studio';

export function isHostCaptureDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.ROBLOX_STUDIO_HOST_CAPTURE ?? '').trim().toLowerCase();
  return value === '0' || value === 'false' || value === 'off';
}

export function isHostCaptureSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

export function hostCaptureUnsupportedReason(platform: NodeJS.Platform = process.platform): string {
  return `host window capture is only implemented on Windows (this is ${platform})`;
}

// True when every pixel has the same RGB value — what Studio returns when the
// capture path had no rendered frame to read (black, or occasionally a flat
// clear colour). A real viewport always has some variation.
export function isUniformFrame(rgba: Buffer, width: number, height: number): boolean {
  const pixels = width * height;
  if (pixels <= 0 || rgba.length < pixels * 4) return false;
  const r = rgba[0];
  const g = rgba[1];
  const b = rgba[2];
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    if (rgba[o] !== r || rgba[o + 1] !== g || rgba[o + 2] !== b) return false;
  }
  return true;
}

function isMarkerPixel(rgba: Buffer, offset: number): boolean {
  return rgba[offset] >= MARKER_MIN_RB && rgba[offset + 1] <= MARKER_MAX_G && rgba[offset + 2] >= MARKER_MIN_RB;
}

// Locates the viewport inside a window capture from the corner markers.
// Returns undefined (with a reason) when the markers cannot be found or the
// box they span does not look like the viewport the plugin reported.
export function findViewportRect(
  rgba: Buffer,
  width: number,
  height: number,
  hint: ViewportMarkerHint,
): ViewportLocateResult {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let markerPixels = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (!isMarkerPixel(rgba, row + x * 4)) continue;
      markerPixels++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) {
    return { error: 'no viewport markers were visible in the Studio window capture', branch: 'none', markerPixels };
  }

  const box = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  const inset = Math.max(1, Math.floor(hint.markerSize / 4));
  const marker = (x: number, y: number) => isMarkerPixel(rgba, (y * width + x) * 4);
  const rectangleError = (): ViewportLocateResult => ({
    error: `viewport markers were found but do not form a rectangle (box ${box.width}x${box.height} at ${box.x},${box.y})`,
    branch: 'rectangle',
    markerPixels,
  });

  if (box.width < hint.markerSize * 3 || !marker(minX + inset, minY + inset) || !marker(maxX - inset, minY + inset)) {
    return rectangleError();
  }

  if (box.height >= hint.markerSize * 2) {
    if (!marker(minX + inset, maxY - inset) || !marker(maxX - inset, maxY - inset)) return rectangleError();
    return { rect: box, markerPixels, scaleX: box.width / hint.viewportWidth, scaleY: box.height / hint.viewportHeight };
  }

  const scale = box.width / hint.viewportWidth;
  const rectHeight = Math.round(hint.viewportHeight * scale);
  const overflowIfTopRow = Math.max(0, minY + rectHeight - height);
  const overflowIfBottomRow = Math.max(0, rectHeight - 1 - maxY);
  const topRow = overflowIfTopRow <= overflowIfBottomRow;
  const rect = topRow
    ? { x: minX, y: minY, width: box.width, height: rectHeight }
    : { x: minX, y: maxY + 1 - rectHeight, width: box.width, height: rectHeight };
  return {
    rect,
    markerPixels,
    scaleX: scale,
    scaleY: scale,
    clipped: { edge: topRow ? 'bottom' : 'top', pixels: topRow ? overflowIfTopRow : overflowIfBottomRow },
  };
}

export function studioWindowPlaceName(title: string): string {
  return title.endsWith(STUDIO_TITLE_SUFFIX) ? title.slice(0, -STUDIO_TITLE_SUFFIX.length) : title;
}

export function studioWindowMatchesHint(title: string, hint: string): boolean {
  if (!hint) return false;
  const name = studioWindowPlaceName(title);
  if (name === hint) return true;
  const file = name.split(/[\\/]/).pop() ?? name;
  if (file === hint) return true;
  return file.replace(/\.rbxlx?$/i, '') === hint;
}

// Crops the window capture to the viewport rect and resamples it to the
// viewport's logical size so image pixels equal viewport coordinates even at
// fractional display scaling. Only an exactly matching rect can be copied:
// rounding by even one pixel must not change the restored coordinate space.
export function cropToViewport(
  rgba: Buffer,
  width: number,
  height: number,
  rect: ViewportRect,
  targetWidth: number,
  targetHeight: number,
): { width: number; height: number; rgba: Buffer } {
  const inside = rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= height;
  const exact = inside && rect.width === targetWidth && rect.height === targetHeight;
  const outW = targetWidth;
  const outH = targetHeight;
  const out = Buffer.alloc(outW * outH * 4);

  if (exact) {
    for (let y = 0; y < outH; y++) {
      rgba.copy(out, y * outW * 4, ((rect.y + y) * width + rect.x) * 4, ((rect.y + y) * width + rect.x + outW) * 4);
    }
    return { width: outW, height: outH, rgba: out };
  }

  // Bilinear resample from the source rect into the target size.
  const sx = rect.width / outW;
  const sy = rect.height / outH;
  for (let y = 0; y < outH; y++) {
    const fy = rect.y + Math.min(rect.height - 1, (y + 0.5) * sy - 0.5);
    const iy = Math.floor(fy);
    const ny = Math.min(rect.y + rect.height - 1, iy + 1);
    const wy = Math.max(0, fy - iy);
    const rowOk = iy >= 0 && ny < height;
    for (let x = 0; x < outW; x++) {
      const dst = (y * outW + x) * 4;
      const fx = rect.x + Math.min(rect.width - 1, (x + 0.5) * sx - 0.5);
      const ix = Math.floor(fx);
      const nx = Math.min(rect.x + rect.width - 1, ix + 1);
      const wx = Math.max(0, fx - ix);
      if (!rowOk || ix < 0 || nx >= width) {
        out[dst + 3] = 255;
        continue;
      }
      const o00 = (iy * width + ix) * 4;
      const o10 = (iy * width + nx) * 4;
      const o01 = (ny * width + ix) * 4;
      const o11 = (ny * width + nx) * 4;
      for (let c = 0; c < 4; c++) {
        const topRow = rgba[o00 + c] * (1 - wx) + rgba[o10 + c] * wx;
        const bottomRow = rgba[o01 + c] * (1 - wx) + rgba[o11 + c] * wx;
        out[dst + c] = Math.round(topRow * (1 - wy) + bottomRow * wy);
      }
    }
  }
  return { width: outW, height: outH, rgba: out };
}

// PowerShell program that finds the Studio window and dumps its client area
// as raw 32-bit BGRA. Inputs arrive through environment variables so no
// shell quoting is involved; the single JSON line on stdout is the result.
const WINDOWS_CAPTURE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class McpStudioCapture {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public class Candidate { public IntPtr Handle; public uint Pid; public string Title; public bool Iconic; }
  public static bool EnablePerMonitorDpi() {
    try { return SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { return false; }
  }
  public static List<Candidate> Find(string processName) {
    var found = new List<Candidate>();
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      int length = GetWindowTextLengthW(hWnd);
      if (length <= 0) return true;
      var sb = new StringBuilder(length + 1);
      GetWindowTextW(hWnd, sb, sb.Capacity);
      string title = sb.ToString();
      if (!title.EndsWith("Roblox Studio", StringComparison.Ordinal)) return true;
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      try {
        var proc = System.Diagnostics.Process.GetProcessById((int)pid);
        if (!string.Equals(proc.ProcessName, processName, StringComparison.OrdinalIgnoreCase)) return true;
      } catch { return true; }
      found.Add(new Candidate { Handle = hWnd, Pid = pid, Title = title, Iconic = IsIconic(hWnd) });
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static bool BringToFront(IntPtr hWnd) {
    if (GetForegroundWindow() == hWnd) return true;
    SetForegroundWindow(hWnd);
    if (GetForegroundWindow() == hWnd) return true;
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(hWnd);
    System.Threading.Thread.Sleep(150);
    return GetForegroundWindow() == hWnd;
  }
  public static int CountMarkers(byte[] bgra, int stride, int width, int height) {
    int count = 0;
    for (int y = 0; y < height; y++) {
      int row = y * stride;
      for (int x = 0; x < width; x++) {
        int o = row + x * 4;
        if (bgra[o + 2] >= 200 && bgra[o + 1] <= 60 && bgra[o] >= 200) count++;
      }
    }
    return count;
  }
}
"@
function Emit($obj) { Write-Output ($obj | ConvertTo-Json -Compress -Depth 4) }
function PlaceName($title) {
  $suffix = ' - Roblox Studio'
  if ($title.EndsWith($suffix)) { return $title.Substring(0, $title.Length - $suffix.Length) }
  return $title
}
function MatchesHint($title, $hint) {
  if (-not $hint) { return $false }
  $name = PlaceName $title
  if ($name -eq $hint) { return $true }
  $file = $name.Split([char[]]@([char]92, [char]47))[-1]
  if ($file -eq $hint) { return $true }
  return (($file -replace '\.rbxlx?$', '') -eq $hint)
}
function Grab($handle, $method) {
  $rect = New-Object McpStudioCapture+RECT
  [void][McpStudioCapture]::GetClientRect($handle, [ref]$rect)
  $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
  if ($w -le 0 -or $h -le 0) { return @{ ok = $false; error = "the Studio window client area is empty ($w x $h)" } }
  $origin = New-Object McpStudioCapture+POINT
  [void][McpStudioCapture]::ClientToScreen($handle, [ref]$origin)
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  if ($method -eq 'screen') {
    $g.CopyFromScreen($origin.X, $origin.Y, 0, 0, $bmp.Size)
    $g.Dispose()
  } else {
    $hdc = $g.GetHdc()
    $printed = [McpStudioCapture]::PrintWindow($handle, $hdc, 3)
    $g.ReleaseHdc($hdc); $g.Dispose()
    if (-not $printed) { $bmp.Dispose(); return @{ ok = $false; error = 'PrintWindow failed for the Studio window' } }
  }
  $bounds = New-Object System.Drawing.Rectangle 0, 0, $w, $h
  $data = $bmp.LockBits($bounds, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $bytes = New-Object byte[] ($data.Stride * $h)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
  $stride = $data.Stride
  $bmp.UnlockBits($data); $bmp.Dispose()
  $magenta = [McpStudioCapture]::CountMarkers($bytes, $stride, $w, $h)
  return @{ ok = $true; width = $w; height = $h; stride = $stride; bytes = $bytes; magenta = $magenta; originX = $origin.X; originY = $origin.Y; method = $method }
}
$dpiAware = [McpStudioCapture]::EnablePerMonitorDpi()
$mode = $env:MCP_CAPTURE_MODE
$hint = $env:MCP_CAPTURE_TITLE_HINT
$pidHint = 0
if ($env:MCP_CAPTURE_PID) { $pidHint = [int]$env:MCP_CAPTURE_PID }
$outFile = $env:MCP_CAPTURE_OUT
$requestedMethod = $env:MCP_CAPTURE_METHOD
$wantForeground = $env:MCP_CAPTURE_FOREGROUND -eq '1'
$candidates = [McpStudioCapture]::Find('RobloxStudioBeta')
if ($mode -eq 'list') {
  $list = @($candidates | ForEach-Object { @{ handle = [int64]$_.Handle; pid = $_.Pid; title = $_.Title; placeName = (PlaceName $_.Title); isIconic = $_.Iconic } })
  Emit @{ ok = $true; windows = $list; dpiAware = $dpiAware }; exit 0
}
if ($candidates.Count -eq 0) { Emit @{ ok = $false; error = 'no visible Roblox Studio window was found' }; exit 0 }
$pick = $null
if ($pidHint -gt 0) { $pick = $candidates | Where-Object { $_.Pid -eq $pidHint } | Select-Object -First 1 }
if ($pick -eq $null -and $hint) {
  $matches = @($candidates | Where-Object { MatchesHint $_.Title $hint })
  if ($matches.Count -eq 1) { $pick = $matches[0] }
  elseif ($matches.Count -gt 1) {
    $titles = ($matches | ForEach-Object { "$($_.Title) (pid $($_.Pid))" }) -join ' | '
    Emit @{ ok = $false; error = "several Studio windows match '$hint' (pid hint $pidHint): $titles" }; exit 0
  }
}
if ($pick -eq $null -and $candidates.Count -eq 1) { $pick = $candidates[0] }
if ($pick -eq $null) {
  $titles = ($candidates | ForEach-Object { "$($_.Title) (pid $($_.Pid))" }) -join ' | '
  Emit @{ ok = $false; error = "could not pick a Studio window for '$hint' (pid hint $pidHint) among: $titles" }; exit 0
}
$restored = $false
if ([McpStudioCapture]::IsIconic($pick.Handle)) {
  [void][McpStudioCapture]::ShowWindow($pick.Handle, 9)
  $restored = $true
  $wantForeground = $true
}
$foreground = $false
if ($wantForeground -or $requestedMethod -eq 'screen') {
  $foreground = [McpStudioCapture]::BringToFront($pick.Handle)
  Start-Sleep -Milliseconds 400
} elseif ($restored) {
  Start-Sleep -Milliseconds 400
}
if ([McpStudioCapture]::IsIconic($pick.Handle)) {
  Emit @{ ok = $false; error = "the Studio window '$($pick.Title)' is minimized and could not be restored" }; exit 0
}
$magenta = @{}
$grab = $null
if ($requestedMethod -eq 'screen') {
  $grab = Grab $pick.Handle 'screen'
  if ($grab.ok) { $magenta['screen'] = $grab.magenta }
} else {
  $grab = Grab $pick.Handle 'printwindow'
  if ($grab.ok) { $magenta['printwindow'] = $grab.magenta }
  if ($requestedMethod -eq 'auto' -and $grab.ok -and $grab.magenta -eq 0) {
    $foreground = [McpStudioCapture]::BringToFront($pick.Handle)
    Start-Sleep -Milliseconds 400
    $second = Grab $pick.Handle 'screen'
    if ($second.ok) { $magenta['screen'] = $second.magenta; $grab = $second }
  }
}
if (-not $grab.ok) { Emit $grab; exit 0 }
[System.IO.File]::WriteAllBytes($outFile, $grab.bytes)
Emit @{
  ok = $true; width = $grab.width; height = $grab.height; stride = $grab.stride; title = $pick.Title; handle = [int64]$pick.Handle
  method = $grab.method; originX = $grab.originX; originY = $grab.originY; restored = $restored; foreground = $foreground; magenta = $magenta; dpiAware = $dpiAware
}
`;

type WindowsCaptureReport = {
  ok: boolean;
  error?: string;
  width?: number;
  height?: number;
  stride?: number;
  title?: string;
  handle?: number;
  method?: HostCaptureMethod;
  originX?: number;
  originY?: number;
  restored?: boolean;
  foreground?: boolean;
  magenta?: Partial<Record<HostCaptureMethod, number>>;
  windows?: StudioWindowInfo[];
};

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.windir;
  if (systemRoot) {
    const candidate = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'powershell.exe';
}

function runWindowsHelper(env: Record<string, string>): Promise<WindowsCaptureReport> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(WINDOWS_CAPTURE_SCRIPT, 'utf16le').toString('base64');
    const child = spawn(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`host window capture timed out after ${HOST_CAPTURE_TIMEOUT_MS}ms`));
    }, HOST_CAPTURE_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`could not start PowerShell for host window capture: ${error.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
      const last = lines[lines.length - 1];
      if (last && last.startsWith('{')) {
        try {
          resolve(JSON.parse(last) as WindowsCaptureReport);
          return;
        } catch {
          // fall through to the generic failure below
        }
      }
      const detail = (stderr.trim() || stdout.trim()).slice(0, 600);
      reject(new Error(`host window capture helper exited with code ${code}${detail ? `: ${detail}` : ''}`));
    });
  });
}

function hostCaptureAvailability(): string | undefined {
  if (isHostCaptureDisabled()) return 'host window capture is disabled by ROBLOX_STUDIO_HOST_CAPTURE';
  if (!isHostCaptureSupported()) return hostCaptureUnsupportedReason();
  return undefined;
}

export async function listStudioWindows(): Promise<StudioWindowListResult> {
  const unavailable = hostCaptureAvailability();
  if (unavailable) return { ok: false, error: unavailable };
  try {
    const report = await runWindowsHelper({ MCP_CAPTURE_MODE: 'list', MCP_CAPTURE_TITLE_HINT: '', MCP_CAPTURE_OUT: '' });
    if (!report.ok) return { ok: false, error: report.error ?? 'window listing failed' };
    return { ok: true, windows: report.windows ?? [] };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function pickStudioWindow(windows: StudioWindowInfo[], titleHint?: string, pid?: number): { ok: true; window: StudioWindowInfo } | { ok: false; error: string } {
  if (windows.length === 0) return { ok: false, error: 'no visible Roblox Studio window was found' };
  const byPid = pid ? windows.find((window) => window.pid === pid) : undefined;
  if (byPid) return { ok: true, window: byPid };
  const matches = titleHint ? windows.filter((window) => studioWindowMatchesHint(window.title, titleHint)) : [];
  if (matches.length === 1) return { ok: true, window: matches[0] };
  if (matches.length > 1) {
    return { ok: false, error: `several Studio windows match '${titleHint}' (pid hint ${pid ?? 0}): ${matches.map((window) => `${window.title} (pid ${window.pid})`).join(' | ')}` };
  }
  if (windows.length === 1) return { ok: true, window: windows[0] };
  return { ok: false, error: `could not pick a Studio window for '${titleHint ?? ''}' (pid hint ${pid ?? 0}) among: ${windows.map((window) => `${window.title} (pid ${window.pid})`).join(' | ')}` };
}

export async function findStudioWindow(titleHint?: string, pid?: number): Promise<{ ok: true; window: StudioWindowInfo } | { ok: false; error: string }> {
  const listed = await listStudioWindows();
  if (!listed.ok) return listed;
  return pickStudioWindow(listed.windows, titleHint, pid);
}

// Captures the Studio window's client area as RGBA. `titleHint` is the place
// name shown in the window title (used to pick among several open places).
export async function captureStudioWindow(titleHint?: string, options: HostCaptureOptions = {}): Promise<HostCaptureResult> {
  const unavailable = hostCaptureAvailability();
  if (unavailable) return { ok: false, error: unavailable };
  const outFile = path.join(os.tmpdir(), `robloxstudio-mcp-capture-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.bgra`);
  try {
    const report = await runWindowsHelper({
      MCP_CAPTURE_MODE: 'capture',
      MCP_CAPTURE_TITLE_HINT: titleHint ?? '',
      MCP_CAPTURE_OUT: outFile,
      MCP_CAPTURE_METHOD: options.method ?? 'printwindow',
      MCP_CAPTURE_FOREGROUND: options.foreground ? '1' : '0',
      MCP_CAPTURE_PID: options.pid ? String(options.pid) : '',
    });
    if (!report.ok || !report.width || !report.height || !report.stride) {
      return { ok: false, error: report.error ?? 'host window capture returned no image' };
    }
    const raw = fs.readFileSync(outFile);
    const { width, height, stride } = report;
    const rgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      const src = y * stride;
      const dst = y * width * 4;
      for (let x = 0; x < width; x++) {
        const s = src + x * 4;
        const d = dst + x * 4;
        rgba[d] = raw[s + 2];
        rgba[d + 1] = raw[s + 1];
        rgba[d + 2] = raw[s];
        rgba[d + 3] = 255;
      }
    }
    return {
      ok: true,
      capture: {
        width,
        height,
        rgba,
        title: report.title ?? '',
        handle: report.handle ?? 0,
        method: report.method ?? 'printwindow',
        clientOrigin: { x: report.originX ?? 0, y: report.originY ?? 0 },
        restored: report.restored === true,
        foreground: report.foreground === true,
        magentaPixels: report.magenta ?? {},
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}
