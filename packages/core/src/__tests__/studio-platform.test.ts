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
