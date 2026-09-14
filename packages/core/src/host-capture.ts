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

export type HostWindowCapture = {
  width: number;
  height: number;
  rgba: Buffer;
  title: string;
};

export type HostCaptureResult =
  | { ok: true; capture: HostWindowCapture }
  | { ok: false; error: string };

export type ViewportRect = { x: number; y: number; width: number; height: number };

export type ViewportMarkerHint = {
  viewportWidth: number;
  viewportHeight: number;
  markerSize: number;
};

const HOST_CAPTURE_TIMEOUT_MS = 20_000;
// Marker colour is pure magenta; allow for colour management / compositor rounding.
const MARKER_MIN_RB = 200;
const MARKER_MAX_G = 60;
// The marker bounding box must match the viewport within this ratio, or be a
// consistent DPI scale of it (same factor on both axes within this tolerance).
const MARKER_SCALE_TOLERANCE = 0.03;

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
): { rect: ViewportRect } | { error: string } {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (!isMarkerPixel(rgba, row + x * 4)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) {
    return { error: 'no viewport markers were visible in the Studio window capture' };
  }

  const rect = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };

  // All four corners of the box must themselves be marker pixels; a stray
  // magenta pixel elsewhere in Studio's chrome would otherwise stretch the box.
  const inset = Math.max(1, Math.floor(hint.markerSize / 4));
  const corners: Array<[number, number]> = [
    [minX + inset, minY + inset],
    [maxX - inset, minY + inset],
    [minX + inset, maxY - inset],
    [maxX - inset, maxY - inset],
  ];
  for (const [x, y] of corners) {
    if (!isMarkerPixel(rgba, (y * width + x) * 4)) {
      return { error: `viewport markers were found but do not form a rectangle (box ${rect.width}x${rect.height} at ${rect.x},${rect.y})` };
    }
  }

  const scaleX = rect.width / hint.viewportWidth;
  const scaleY = rect.height / hint.viewportHeight;
  if (Math.abs(scaleX - scaleY) > MARKER_SCALE_TOLERANCE * Math.max(scaleX, scaleY)) {
    return {
      error:
        `viewport marker box ${rect.width}x${rect.height} does not match the reported ` +
        `${hint.viewportWidth}x${hint.viewportHeight} viewport aspect`,
    };
  }
  return { rect };
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
  const x0 = Math.max(0, Math.min(width - 1, rect.x));
  const y0 = Math.max(0, Math.min(height - 1, rect.y));
  const srcW = Math.max(1, Math.min(rect.width, width - x0));
  const srcH = Math.max(1, Math.min(rect.height, height - y0));

  const exact = srcW === targetWidth && srcH === targetHeight;
  const outW = targetWidth;
  const outH = targetHeight;
  const out = Buffer.alloc(outW * outH * 4);

  if (exact) {
    for (let y = 0; y < outH; y++) {
      rgba.copy(out, y * outW * 4, ((y0 + y) * width + x0) * 4, ((y0 + y) * width + x0 + outW) * 4);
    }
    return { width: outW, height: outH, rgba: out };
  }

  // Bilinear resample from the source rect into the target size.
  const sx = srcW / outW;
  const sy = srcH / outH;
  for (let y = 0; y < outH; y++) {
    const fy = Math.min(srcH - 1, (y + 0.5) * sy - 0.5);
    const iy = Math.max(0, Math.floor(fy));
    const ny = Math.min(srcH - 1, iy + 1);
    const wy = Math.max(0, fy - iy);
    for (let x = 0; x < outW; x++) {
      const fx = Math.min(srcW - 1, (x + 0.5) * sx - 0.5);
      const ix = Math.max(0, Math.floor(fx));
      const nx = Math.min(srcW - 1, ix + 1);
      const wx = Math.max(0, fx - ix);
      const o00 = ((y0 + iy) * width + x0 + ix) * 4;
      const o10 = ((y0 + iy) * width + x0 + nx) * 4;
      const o01 = ((y0 + ny) * width + x0 + ix) * 4;
      const o11 = ((y0 + ny) * width + x0 + nx) * 4;
      const dst = (y * outW + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = rgba[o00 + c] * (1 - wx) + rgba[o10 + c] * wx;
        const bottom = rgba[o01 + c] * (1 - wx) + rgba[o11 + c] * wx;
        out[dst + c] = Math.round(top * (1 - wy) + bottom * wy);
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
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public class Candidate { public IntPtr Handle; public uint Pid; public string Title; }
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
      found.Add(new Candidate { Handle = hWnd, Pid = pid, Title = title });
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
function Emit($obj) { Write-Output ($obj | ConvertTo-Json -Compress) }
$hint = $env:MCP_CAPTURE_TITLE_HINT
$outFile = $env:MCP_CAPTURE_OUT
$candidates = [McpStudioCapture]::Find('RobloxStudioBeta')
if ($candidates.Count -eq 0) { Emit @{ ok = $false; error = 'no visible Roblox Studio window was found' }; exit 0 }
$pick = $null
if ($hint) { $pick = $candidates | Where-Object { $_.Title.StartsWith($hint) } | Select-Object -First 1 }
if ($pick -eq $null -and $candidates.Count -eq 1) { $pick = $candidates[0] }
if ($pick -eq $null) {
  $titles = ($candidates | ForEach-Object { $_.Title }) -join ' | '
  Emit @{ ok = $false; error = "could not pick a Studio window for '$hint' among: $titles" }; exit 0
}
if ([McpStudioCapture]::IsIconic($pick.Handle)) {
  Emit @{ ok = $false; error = "the Studio window '$($pick.Title)' is minimized; restore it (it may stay behind other windows)" }; exit 0
}
$rect = New-Object McpStudioCapture+RECT
[void][McpStudioCapture]::GetClientRect($pick.Handle, [ref]$rect)
$w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) { Emit @{ ok = $false; error = "the Studio window client area is empty ($w x $h)" }; exit 0 }
$bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# PW_CLIENTONLY (1) | PW_RENDERFULLCONTENT (2): DWM-composited client area, occluded windows included.
$printed = [McpStudioCapture]::PrintWindow($pick.Handle, $hdc, 3)
$g.ReleaseHdc($hdc); $g.Dispose()
if (-not $printed) { $bmp.Dispose(); Emit @{ ok = $false; error = 'PrintWindow failed for the Studio window' }; exit 0 }
$bounds = New-Object System.Drawing.Rectangle 0, 0, $w, $h
$data = $bmp.LockBits($bounds, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bytes = New-Object byte[] ($data.Stride * $h)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
$stride = $data.Stride
$bmp.UnlockBits($data); $bmp.Dispose()
[System.IO.File]::WriteAllBytes($outFile, $bytes)
Emit @{ ok = $true; width = $w; height = $h; stride = $stride; title = $pick.Title }
`;

type WindowsCaptureReport = {
  ok: boolean;
  error?: string;
  width?: number;
  height?: number;
  stride?: number;
  title?: string;
};

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.windir;
  if (systemRoot) {
    const candidate = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'powershell.exe';
}

function runWindowsCapture(titleHint: string | undefined, outFile: string): Promise<WindowsCaptureReport> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(WINDOWS_CAPTURE_SCRIPT, 'utf16le').toString('base64');
    const child = spawn(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        env: { ...process.env, MCP_CAPTURE_TITLE_HINT: titleHint ?? '', MCP_CAPTURE_OUT: outFile },
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

// Captures the Studio window's client area as RGBA. `titleHint` is the place
// name shown in the window title (used to pick among several open places).
export async function captureStudioWindow(titleHint?: string): Promise<HostCaptureResult> {
  if (isHostCaptureDisabled()) {
    return { ok: false, error: 'host window capture is disabled by ROBLOX_STUDIO_HOST_CAPTURE' };
  }
  if (!isHostCaptureSupported()) {
    return { ok: false, error: hostCaptureUnsupportedReason() };
  }
  const outFile = path.join(os.tmpdir(), `robloxstudio-mcp-capture-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.bgra`);
  try {
    const report = await runWindowsCapture(titleHint, outFile);
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
    return { ok: true, capture: { width, height, rgba, title: report.title ?? '' } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}
