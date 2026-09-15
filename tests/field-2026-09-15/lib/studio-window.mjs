import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TYPES = String.raw`
using System;using System.Collections.Generic;using System.Runtime.InteropServices;using System.Text;
public static class FieldWin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder t, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLengthW(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public class Win { public long Handle; public uint Pid; public string Title; public bool Iconic; }
  public static int[] Stats(byte[] bgra, int stride, int w, int h) {
    var set = new HashSet<int>(); int magenta = 0;
    for (int y = 0; y < h; y++) { int row = y * stride; for (int x = 0; x < w; x++) {
      int o = row + x * 4; int b = bgra[o], g = bgra[o + 1], r = bgra[o + 2];
      set.Add((r << 16) | (g << 8) | b);
      if (r >= 200 && g <= 60 && b >= 200) magenta++;
    } }
    return new int[] { set.Count, magenta };
  }
  public static List<Win> List() {
    var found = new List<Win>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      int n = GetWindowTextLengthW(h); if (n <= 0) return true;
      var sb = new StringBuilder(n + 1); GetWindowTextW(h, sb, sb.Capacity);
      string t = sb.ToString(); if (!t.EndsWith("Roblox Studio")) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      try { if (System.Diagnostics.Process.GetProcessById((int)pid).ProcessName != "RobloxStudioBeta") return true; } catch { return true; }
      found.Add(new Win { Handle = h.ToInt64(), Pid = pid, Title = t, Iconic = IsIconic(h) });
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
`;

function runPs(body) {
  const script = `$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\nAdd-Type -AssemblyName System.Drawing\nAdd-Type -TypeDefinition @"\n${TYPES}\n"@\n${body}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    encoding: 'utf8', timeout: 90_000, windowsHide: true,
  });
  if (res.status !== 0) throw new Error(`powershell failed (${res.status}): ${res.stderr || res.stdout}`);
  const lines = res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

function psPath(dir) {
  return dir.replace(/\\/g, '\\\\');
}

export function listStudioWindows() {
  const out = runPs('$w=[FieldWin]::List(); Write-Output (ConvertTo-Json -Compress -InputObject @($w | ForEach-Object { @{ handle=$_.Handle; pid=$_.Pid; title=$_.Title; iconic=$_.Iconic } }))');
  return Array.isArray(out) ? out : [out];
}

export function findStudioWindowByTitlePrefix(prefix) {
  const all = listStudioWindows();
  const matches = all.filter((w) => w.title.startsWith(prefix));
  if (matches.length !== 1) throw new Error(`expected exactly one Studio window titled '${prefix}...', found ${matches.length}: ${JSON.stringify(all)}`);
  return matches[0];
}

export function placeNameOfTitle(title) {
  const name = title.replace(/ - Roblox Studio$/, '');
  const file = name.split(/[\\/]/).pop();
  return { name, file, base: file.replace(/\.rbxlx?$/i, '') };
}

export function findStudioWindowForPlace(placeName) {
  const all = listStudioWindows();
  const matches = all.filter((w) => {
    const { name, file, base } = placeNameOfTitle(w.title);
    return name === placeName || file === placeName || base === placeName;
  });
  if (matches.length !== 1) throw new Error(`expected exactly one Studio window for place '${placeName}', found ${matches.length}: ${JSON.stringify(all)}`);
  return matches[0];
}

export function findStudioWindowByPid(pid) {
  const all = listStudioWindows();
  const matches = all.filter((w) => Number(w.pid) === Number(pid));
  if (matches.length !== 1) throw new Error(`expected exactly one Studio window for pid ${pid}, found ${matches.length}: ${JSON.stringify(all)}`);
  return matches[0];
}

// The managed record is looked up by instance id first. When the primary
// server could not associate the connection with its launch record (registry
// lock contention while several runners launch Studio at once), the record
// still exists without an instance id; it is then matched through the runner's
// isolated Studio working directory, which run-all.mjs exports to every test.
export async function findManagedStudioWindow(tool, instanceId, placeName) {
  const status = await tool('manage_instance', { action: 'status', instance_id: instanceId });
  console.log(`  manage_instance status -> pid=${status.pid} managed=${status.managed} state=${status.state}`);
  if (Number.isInteger(status.pid) && status.pid > 0) return findStudioWindowByPid(status.pid);
  const workingDirectory = process.env.RSMCP_STUDIO_WORKING_DIRECTORY;
  if (workingDirectory) {
    const listing = await tool('manage_instance', { action: 'status' });
    const records = (listing.managed || []).filter((record) => record.studio_working_directory === workingDirectory);
    const record = records.find((item) => Number.isInteger(item.pid) && item.pid > 0);
    console.log(`  managed records for ${workingDirectory}: ${JSON.stringify(records.map((item) => ({ pid: item.pid, state: item.state, instance_id: item.instance_id })))}`);
    if (record) return findStudioWindowByPid(record.pid);
  }
  return findStudioWindowForPlace(placeName);
}

export function showWindow(handle, cmd) {
  return runPs(`$h=[IntPtr]::new(${handle}); $r=[FieldWin]::ShowWindow($h, ${cmd}); Start-Sleep -Milliseconds 500; Write-Output (ConvertTo-Json -Compress @{ ok=$r; iconic=[FieldWin]::IsIconic($h) })`);
}

export function windowState(handle) {
  return runPs(`$h=[IntPtr]::new(${handle}); Write-Output (ConvertTo-Json -Compress @{ iconic=[FieldWin]::IsIconic($h); visible=[FieldWin]::IsWindowVisible($h); foreground=([FieldWin]::GetForegroundWindow() -eq $h) })`);
}

export function probeWindow(handle, pngDir) {
  const dir = pngDir ?? mkdtempSync(join(tmpdir(), 'field-probe-'));
  const body = [
    `$h=[IntPtr]::new(${handle})`,
    '$rect=New-Object FieldWin+RECT; [void][FieldWin]::GetClientRect($h,[ref]$rect)',
    '$w=$rect.Right-$rect.Left; $hh=$rect.Bottom-$rect.Top',
    '$pt=New-Object FieldWin+POINT; $pt.X=0; $pt.Y=0; [void][FieldWin]::ClientToScreen($h,[ref]$pt)',
    'function Count($bmp) {',
    '  $bounds=New-Object System.Drawing.Rectangle 0,0,$bmp.Width,$bmp.Height',
    '  $data=$bmp.LockBits($bounds,[System.Drawing.Imaging.ImageLockMode]::ReadOnly,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)',
    '  $bytes=New-Object byte[] ($data.Stride*$bmp.Height)',
    '  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0,$bytes,0,$bytes.Length)',
    '  $bmp.UnlockBits($data)',
    '  return [FieldWin]::Stats($bytes,$data.Stride,$bmp.Width,$bmp.Height)',
    '}',
    '$bmp1=New-Object System.Drawing.Bitmap $w,$hh,([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)',
    '$g1=[System.Drawing.Graphics]::FromImage($bmp1); $hdc=$g1.GetHdc(); $printed=[FieldWin]::PrintWindow($h,$hdc,3); $g1.ReleaseHdc($hdc); $g1.Dispose()',
    `$c1=Count $bmp1; $bmp1.Save("${psPath(dir)}\\printwindow.png",[System.Drawing.Imaging.ImageFormat]::Png); $bmp1.Dispose()`,
    '$bmp2=New-Object System.Drawing.Bitmap $w,$hh,([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)',
    '$g2=[System.Drawing.Graphics]::FromImage($bmp2); $g2.CopyFromScreen($pt.X,$pt.Y,0,0,$bmp2.Size); $g2.Dispose()',
    `$c2=Count $bmp2; $bmp2.Save("${psPath(dir)}\\screen.png",[System.Drawing.Imaging.ImageFormat]::Png); $bmp2.Dispose()`,
    `Write-Output (ConvertTo-Json -Compress @{ width=$w; height=$hh; screenX=$pt.X; screenY=$pt.Y; printed=$printed; printwindowColours=$c1[0]; printwindowMagenta=$c1[1]; screenColours=$c2[0]; screenMagenta=$c2[1]; dir="${psPath(dir)}" })`,
  ].join('\n');
  return runPs(body);
}

export function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
