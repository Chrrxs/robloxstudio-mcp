import { detectStudioPlatform } from '../studio-platform.js';

const WSL_KERNEL = 'Linux version 6.6.87.2-microsoft-standard-WSL2';
const NATIVE_LINUX_KERNEL = 'Linux version 6.8.0-generic';

describe('Studio platform capabilities', () => {
  test('native Windows uses the retained Windows launcher', () => {
    expect(detectStudioPlatform({
      platform: 'win32',
    })).toMatchObject({
      hostPlatform: 'windows',
      isWsl: false,
      windowsInteropAvailable: true,
      processIdentity: {
        supported: true,
        launcher: 'windows-retained',
      },
    });
  });

  test('WSL with standard environment markers uses verified Windows interop', () => {
    expect(detectStudioPlatform({
      platform: 'linux',
      kernelVersion: WSL_KERNEL,
      wslInterop: '/run/WSL/123_interop',
      wslDistroName: 'Ubuntu',
      windowsRootPresent: true,
      wslPathPresent: true,
      windowsInteropAvailable: true,
    })).toMatchObject({
      hostPlatform: 'wsl',
      isWsl: true,
      processIdentity: {
        supported: true,
        launcher: 'wsl-windows-retained',
      },
    });
  });

  test('sanitized Codex WSL environment does not require inherited markers', () => {
    expect(detectStudioPlatform({
      platform: 'linux',
      kernelVersion: WSL_KERNEL,
      windowsRootPresent: true,
      wslPathPresent: true,
      windowsInteropAvailable: true,
    })).toMatchObject({
      hostPlatform: 'wsl',
      isWsl: true,
      windowsInteropAvailable: true,
      processIdentity: {
        supported: true,
        launcher: 'wsl-windows-retained',
      },
    });
  });

  test('native Linux does not advertise the retained Windows launcher', () => {
    expect(detectStudioPlatform({
      platform: 'linux',
      kernelVersion: NATIVE_LINUX_KERNEL,
      windowsInteropAvailable: false,
    })).toMatchObject({
      hostPlatform: 'linux',
      isWsl: false,
      processIdentity: {
        supported: false,
        launcher: 'unavailable',
      },
    });
  });

  test('native Linux without a Wine launcher names the launcher setting as remediation', () => {
    expect(detectStudioPlatform({
      platform: 'linux',
      kernelVersion: NATIVE_LINUX_KERNEL,
    }).processIdentity.reason).toContain('ROBLOX_STUDIO_WINE_LAUNCHER');
  });

  test('native Linux with an executable Wine launcher uses the retained Wine launcher', () => {
    expect(detectStudioPlatform({
      platform: 'linux',
      kernelVersion: NATIVE_LINUX_KERNEL,
      windowsInteropAvailable: false,
      wineLauncher: '/opt/studio/launch-studio',
      wineLauncherExecutable: true,
    })).toEqual({
      hostPlatform: 'linux',
      isWsl: false,
      windowsInteropAvailable: false,
      processIdentity: {
        supported: true,
        launcher: 'wine-retained',
      },
      wineLauncher: '/opt/studio/launch-studio',
    });
  });

  test('a Wine launcher that is not executable is rejected with its path', () => {
    const capabilities = detectStudioPlatform({
      platform: 'linux',
      kernelVersion: NATIVE_LINUX_KERNEL,
      wineLauncher: '/opt/studio/missing',
      wineLauncherExecutable: false,
    });
    expect(capabilities).toMatchObject({
      hostPlatform: 'linux',
      processIdentity: { supported: false, launcher: 'unavailable' },
    });
    expect(capabilities.processIdentity.reason).toContain('/opt/studio/missing');
  });

  test.each([true, false])('WSL ignores the Wine launcher (Windows interop: %p)', (windowsInteropAvailable) => {
    expect(detectStudioPlatform({
      platform: 'linux',
      kernelVersion: WSL_KERNEL,
      windowsInteropAvailable,
      wineLauncher: '/opt/studio/launch-studio',
      wineLauncherExecutable: true,
    }).processIdentity.launcher).toBe(windowsInteropAvailable ? 'wsl-windows-retained' : 'unavailable');
  });

  test('a container sharing a WSL kernel is rejected without live Windows interop', () => {
    expect(detectStudioPlatform({
      platform: 'linux',
      kernelVersion: WSL_KERNEL,
      windowsRootPresent: true,
      wslPathPresent: true,
      windowsInteropAvailable: false,
    })).toMatchObject({
      hostPlatform: 'linux',
      isWsl: false,
      windowsInteropAvailable: false,
      processIdentity: {
        supported: false,
        launcher: 'unavailable',
      },
    });
  });
});
