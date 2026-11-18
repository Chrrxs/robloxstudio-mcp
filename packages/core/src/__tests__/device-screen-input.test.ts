import type { Plugin } from 'esbuild';
import { loadPluginModule } from './luau-vm.js';

// Device Simulator handling in the plugin (issue #182): screenshots are
// resampled to the full device screen on the server, so input passes screenshot
// pixels straight to VirtualInput; move is refused under touch emulation; and
// captures report the full screen size only when it differs from the viewport.

class Vector2 {
  constructor(readonly X: number, readonly Y: number) {}
}

interface Sent {
  kind: 'button' | 'position' | 'pointer';
  x: number;
  y: number;
  isDown?: boolean;
}

interface Scene {
  viewport: [number, number];
  fullScreen: [number, number];
  device?: string;
  mouseEnabled?: boolean;
  touchEnabled?: boolean;
}

interface InputHandlers {
  simulateMouseInput(request: Record<string, unknown>): Record<string, unknown>;
}

interface DeviceScreen {
  axisScale(fullSize: number, viewportSize: number): number;
  squeezedScreenSize(): { width: number; height: number } | undefined;
}

const renderMonitorStub: Plugin = {
  name: 'render-monitor-stub',
  setup(build) {
    build.onResolve({ filter: /^\.\.\/RenderMonitor$/ }, () => ({ path: 'RenderMonitor', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export const notRenderingReason = () => undefined; export const onRenderResumed = () => {};',
      loader: 'js',
    }));
  },
};

function robloxGlobals(scene: Scene, sent: Sent[], probes: { destroyed: number }) {
  const virtualInput = {
    SendMouseButton: (pos: Vector2, _type: unknown, isDown: boolean) => sent.push({ kind: 'button', x: pos.X, y: pos.Y, isDown }),
    SendMousePosition: (pos: Vector2) => sent.push({ kind: 'position', x: pos.X, y: pos.Y }),
    SendPointerAction: (pos: Vector2) => sent.push({ kind: 'pointer', x: pos.X, y: pos.Y }),
  };
  const services: Record<string, unknown> = {
    UserInputService: {
      get MouseEnabled() { return scene.mouseEnabled ?? true; },
      get TouchEnabled() { return scene.touchEnabled ?? false; },
      CreateVirtualInput: () => virtualInput,
    },
    Workspace: { CurrentCamera: { get ViewportSize() { return new Vector2(...scene.viewport); } } },
    CoreGui: { Name: 'CoreGui' },
    RunService: { Heartbeat: { Wait: () => 0 } },
    StudioDeviceSimulatorService: { GetDeviceAsync: () => scene.device ?? 'default' },
  };

  // A full-scale frame in a ScreenGui with ScreenInsets None and
  // IgnoreGuiInset fills the whole device screen once it is parented.
  class Instance {
    Parent?: Instance | { Name: string };
    ScreenInsets?: string;
    IgnoreGuiInset?: boolean;
    constructor(readonly ClassName: string) {}
    get AbsoluteSize(): Vector2 {
      const gui = this.Parent as Instance | undefined;
      const parented = gui?.Parent === services.CoreGui;
      const fullScreen = gui?.ScreenInsets === 'None' && gui.IgnoreGuiInset === true;
      return parented && fullScreen ? new Vector2(...scene.fullScreen) : new Vector2(...scene.viewport);
    }
    Destroy() {
      if (this.ClassName === 'ScreenGui') probes.destroyed++;
      this.Parent = undefined;
    }
  }

  return {
    game: { GetService: (name: string) => {
      if (!(name in services)) throw new Error(`${name} is not a valid Service name`);
      return services[name];
    } },
    Instance,
    Vector2,
    UDim2: { fromScale: (x: number, y: number) => ({ x, y }) },
    Enum: {
      ScreenInsets: { None: 'None', DeviceSafeInsets: 'DeviceSafeInsets' },
      SafeAreaCompatibility: { None: 'None' },
      UserInputType: { MouseButton1: 'MouseButton1', MouseButton2: 'MouseButton2', MouseButton3: 'MouseButton3' },
    },
    os: { clock: () => 0 },
    task: { wait: () => 0 },
  };
}

async function loadInput(scene: Scene) {
  const sent: Sent[] = [];
  const probes = { destroyed: 0 };
  const handlers = await loadPluginModule<InputHandlers>(
    'studio-plugin/src/modules/handlers/InputHandlers.ts',
    robloxGlobals(scene, sent, probes),
    [renderMonitorStub],
  );
  return { handlers, sent, probes };
}

// iphone_14 LandscapeRight, ScaleToPhysicalSize, as measured in the issue.
const IPHONE_14_LANDSCAPE: Scene = { viewport: [749, 388], fullScreen: [843, 388], device: 'iphone_14', touchEnabled: true };

describe('simulate_mouse_input passes screenshot pixels straight to VirtualInput', () => {
  test('a click under the simulator is not rescaled and creates no probe GUI', async () => {
    const { handlers, sent, probes } = await loadInput(IPHONE_14_LANDSCAPE);

    const result = handlers.simulateMouseInput({ action: 'click', x: 666, y: 180 });

    expect(result).toEqual({ success: true, action: 'click', x: 666, y: 180, button: 'Left' });
    expect(sent).toEqual([
      { kind: 'button', x: 666, y: 180, isDown: true },
      { kind: 'button', x: 666, y: 180, isDown: false },
    ]);
    expect(probes.destroyed).toBe(0);
  });

  test('without the simulator coordinates pass through unchanged', async () => {
    const { handlers, sent } = await loadInput({ viewport: [1456, 912], fullScreen: [1456, 912] });

    handlers.simulateMouseInput({ action: 'click', x: 400.5, y: 300 });
    handlers.simulateMouseInput({ action: 'scroll', x: 10, y: 20, wheel: -1 });
    expect(handlers.simulateMouseInput({ action: 'move', x: 200, y: 250 })).toMatchObject({ success: true });

    expect(sent.map(({ x, y }) => [x, y])).toEqual([[400.5, 300], [400.5, 300], [10, 20], [200, 250]]);
  });
});

describe('move under touch emulation is refused instead of a false success', () => {
  test('simulated touch device with MouseEnabled still true', async () => {
    const { handlers, sent } = await loadInput({ ...IPHONE_14_LANDSCAPE, mouseEnabled: true });

    const result = handlers.simulateMouseInput({ action: 'move', x: 300, y: 150 });

    expect(String(result.error)).toContain('touch device emulation');
    expect(String(result.error)).toContain('action="click"');
    expect(sent).toEqual([]);
  });

  test('simulated touch device whose screen is not squeezed', async () => {
    const { handlers } = await loadInput({ viewport: [1024, 768], fullScreen: [1024, 768], device: 'ipad', touchEnabled: true });

    expect(String(handlers.simulateMouseInput({ action: 'move', x: 10, y: 10 }).error)).toContain('touch device emulation');
  });

  test('a squeezed touch screen counts even when the simulator service reports no device', async () => {
    const { handlers, probes } = await loadInput({ ...IPHONE_14_LANDSCAPE, device: 'default' });

    expect(String(handlers.simulateMouseInput({ action: 'move', x: 10, y: 10 }).error)).toContain('touch device emulation');
    expect(probes.destroyed).toBe(1);
  });

  test('a real touchscreen laptop without the simulator keeps moving the mouse', async () => {
    const { handlers, sent } = await loadInput({ viewport: [1456, 912], fullScreen: [1456, 912], touchEnabled: true, mouseEnabled: true });

    expect(handlers.simulateMouseInput({ action: 'move', x: 200, y: 250 })).toMatchObject({ success: true });
    expect(sent).toEqual([{ kind: 'position', x: 200, y: 250 }]);
  });

  test('a desktop simulator preset without touch keeps moving the mouse', async () => {
    const { handlers } = await loadInput({ viewport: [1280, 720], fullScreen: [1280, 720], device: 'desktop_1080p' });

    expect(handlers.simulateMouseInput({ action: 'move', x: 5, y: 5 })).toMatchObject({ success: true });
  });
});

describe('DeviceScreen', () => {
  test.each([
    [843, 749, 843 / 749],
    [749, 749, 1],
    [749.4, 749, 1],
    [0, 749, 1],
    [843, 0, 1],
  ])('axisScale(%p, %p) = %p', async (full, viewport, expected) => {
    const screen = await loadPluginModule<DeviceScreen>('studio-plugin/src/modules/DeviceScreen.ts');
    expect(screen.axisScale(full, viewport)).toBeCloseTo(expected, 10);
  });

  test.each([
    [IPHONE_14_LANDSCAPE, { width: 843, height: 388 }],
    [{ viewport: [1456, 912], fullScreen: [1456.4, 912] } as Scene, undefined],
  ])('squeezedScreenSize reports the full screen only when it differs from the viewport', async (scene, expected) => {
    const probes = { destroyed: 0 };
    const screen = await loadPluginModule<DeviceScreen>('studio-plugin/src/modules/DeviceScreen.ts', robloxGlobals(scene, [], probes));
    expect(screen.squeezedScreenSize()).toEqual(expected);
    expect(probes.destroyed).toBe(1);
  });
});
