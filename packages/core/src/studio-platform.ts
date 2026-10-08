import { execFileSync } from 'child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'fs';
import * as path from 'path';

export type StudioHostPlatform = 'windows' | 'wsl' | 'macos' | 'linux';
export type StudioProcessIdentityLauncher =
  | 'windows-retained'
  | 'wsl-windows-retained'
  | 'wine-retained'
  | 'unavailable';

export interface StudioPlatformEvidence {
  platform: NodeJS.Platform;
  kernelVersion?: string;
  wslInterop?: string;
  wslDistroName?: string;
  windowsRootPresent?: boolean;
  wslPathPresent?: boolean;
  windowsInteropAvailable?: boolean;
  /** Raw `ROBLOX_STUDIO_WINE_LAUNCHER` value, if set. */
  wineLauncher?: string;
  /** Whether `wineLauncher` names an executable regular file. */
  wineLauncherExecutable?: boolean;
}

export interface StudioPlatformCapabilities {
  hostPlatform: StudioHostPlatform;
  isWsl: boolean;
  windowsInteropAvailable: boolean;
  processIdentity: {
    supported: boolean;
    launcher: StudioProcessIdentityLauncher;
    reason?: string;
  };
  /** Absolute path of the verified Wine launcher when `launcher` is `wine-retained`. */
  wineLauncher?: string;
}

const WSL_KERNEL_PATTERN = /microsoft|wsl/i;
const WINDOWS_INTEROP_PROBE_TOKEN = 'ROBLOXSTUDIO_MCP_WINDOWS_INTEROP_OK';
const WINDOWS_POWERSHELL =
  '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

export function detectStudioPlatform(
  evidence: StudioPlatformEvidence,
): StudioPlatformCapabilities {
  if (evidence.platform === 'win32') {
    return {
      hostPlatform: 'windows',
      isWsl: false,
      windowsInteropAvailable: true,
      processIdentity: {
        supported: true,
        launcher: 'windows-retained',
      },
    };
  }

  if (evidence.platform === 'darwin') {
    return {
      hostPlatform: 'macos',
      isWsl: false,
      windowsInteropAvailable: false,
      processIdentity: {
        supported: false,
        launcher: 'unavailable',
        reason: 'The retained Windows Studio launcher is unavailable on macOS.',
      },
    };
  }

  const hasWslKernel =
    evidence.platform === 'linux' &&
    WSL_KERNEL_PATTERN.test(evidence.kernelVersion ?? '');
  const hasWindowsInterop =
    hasWslKernel && evidence.windowsInteropAvailable === true;

  if (hasWindowsInterop) {
    return {
      hostPlatform: 'wsl',
      isWsl: true,
      windowsInteropAvailable: true,
      processIdentity: {
        supported: true,
        launcher: 'wsl-windows-retained',
      },
    };
  }

  if (!hasWslKernel && evidence.wineLauncher && evidence.wineLauncherExecutable === true) {
    return {
      hostPlatform: 'linux',
      isWsl: false,
      windowsInteropAvailable: false,
      processIdentity: {
        supported: true,
        launcher: 'wine-retained',
      },
      // Wine hosts are always Linux; keep POSIX semantics when tests run elsewhere.
      wineLauncher: path.posix.resolve(evidence.wineLauncher),
    };
  }

  const reason = hasWslKernel
    ? 'The Linux kernel has a WSL signature, but the live process cannot execute the Windows launcher.'
    : evidence.wineLauncher
      ? `The retained Windows Studio launcher is unavailable on native Linux, and ROBLOX_STUDIO_WINE_LAUNCHER (${evidence.wineLauncher}) is not an executable file.`
      : 'The retained Windows Studio launcher is unavailable on native Linux. Set ROBLOX_STUDIO_WINE_LAUNCHER to an executable Wine launcher to run Studio under Wine.';
  return {
    hostPlatform: 'linux',
    isWsl: false,
    windowsInteropAvailable: false,
    processIdentity: {
      supported: false,
      launcher: 'unavailable',
      reason,
    },
  };
}

function readKernelVersion(): string {
  if (process.platform !== 'linux') return '';
  try {
    return readFileSync('/proc/version', 'utf8');
  } catch {
    return '';
  }
}

function powershellCandidates(): string[] {
  return existsSync(WINDOWS_POWERSHELL)
    ? [WINDOWS_POWERSHELL, 'powershell.exe']
    : ['powershell.exe'];
}

function probeWindowsInterop(kernelVersion: string): boolean {
  if (process.platform !== 'linux' || !WSL_KERNEL_PATTERN.test(kernelVersion)) {
    return false;
  }

  const cwd = existsSync('/mnt/c/Windows') ? '/mnt/c/Windows' : process.cwd();
  for (const command of powershellCandidates()) {
    try {
      const output = execFileSync(
        command,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `[Console]::Write('${WINDOWS_INTEROP_PROBE_TOKEN}')`,
        ],
        {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 3000,
          killSignal: 'SIGKILL',
        },
      ).trim();
      if (output === WINDOWS_INTEROP_PROBE_TOKEN) return true;
    } catch {
      // Try the next known PowerShell path.
    }
  }
  return false;
}

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

let cachedStudioPlatformCapabilities: StudioPlatformCapabilities | undefined;

export function getStudioPlatformCapabilities(): StudioPlatformCapabilities {
  if (cachedStudioPlatformCapabilities) return cachedStudioPlatformCapabilities;

  const kernelVersion = readKernelVersion();
  const wineLauncher = process.env.ROBLOX_STUDIO_WINE_LAUNCHER || undefined;
  cachedStudioPlatformCapabilities = detectStudioPlatform({
    platform: process.platform,
    kernelVersion,
    wslInterop: process.env.WSL_INTEROP,
    wslDistroName: process.env.WSL_DISTRO_NAME,
    windowsRootPresent: existsSync('/mnt/c/Windows'),
    wslPathPresent: existsSync('/usr/bin/wslpath') || existsSync('/bin/wslpath'),
    windowsInteropAvailable: probeWindowsInterop(kernelVersion),
    wineLauncher,
    wineLauncherExecutable: process.platform === 'linux' && wineLauncher !== undefined && isExecutableFile(wineLauncher),
  });
  return cachedStudioPlatformCapabilities;
}
