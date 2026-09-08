import * as path from 'path';
import * as vm from 'vm';
import { build as esbuildBuild } from 'esbuild';
import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';
import { StudioHttpClient } from '../tools/studio-client.js';

function registerRole(
  bridge: BridgeService,
  peerId: string,
  role: string,
  isRunning: boolean,
  transportPeerId = peerId,
) {
  const result = bridge.registerPeer({
    peerId,
    transportPeerId,
    instanceId: 'instance:test',
    role,
    placeId: 0,
    placeName: 'TestPlace',
    dataModelName: 'TestPlace',
    isRunning,
  });
  if (!result.ok) throw new Error(`registerPeer failed: ${result.error.code}`);
}

describe('selection lifecycle tool', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('routes get and set to edit while view follows the screenshot viewport', async () => {
    const bridge = new BridgeService();
    registerRole(bridge, 'edit-session', 'edit', false);
    registerRole(bridge, 'server-session', 'server', true);
    registerRole(bridge, 'client-session', 'client-1', true, 'server-session');

    const request = jest.spyOn(StudioHttpClient.prototype, 'request')
      .mockResolvedValue({ success: true });
    const tools = new RobloxStudioTools(bridge);

    await tools.selection('get', {}, 'instance:test');
    expect(request).toHaveBeenLastCalledWith(
      '/api/get-selection',
      {},
      'edit-session',
      undefined,
      undefined,
      undefined,
    );

    await tools.selection('set', { paths: [], mode: 'set' }, 'instance:test');
    expect(request).toHaveBeenLastCalledWith(
      '/api/set-selection',
      { paths: [], mode: 'set' },
      'edit-session',
      undefined,
      undefined,
      undefined,
    );

    await tools.selection('view', {
      path: 'game.Workspace.Subject',
      padding: 1.25,
    }, 'instance:test');
    expect(request).toHaveBeenLastCalledWith(
      '/api/focus-viewport',
      {
        path: 'game.Workspace.Subject',
        from: undefined,
        padding: 1.25,
        angleY: undefined,
      },
      'client-session',
      undefined,
      undefined,
      undefined,
    );

    await tools.selection('view', {}, 'instance:test');
    expect(request).toHaveBeenLastCalledWith(
      '/api/focus-viewport',
      { path: undefined, from: undefined, padding: undefined, angleY: undefined },
      'client-session',
      undefined,
      undefined,
      undefined,
    );
  });

  test('rejects invalid lifecycle arguments before dispatch', async () => {
    const tools = new RobloxStudioTools(new BridgeService());

    await expect(tools.selection('set', { paths: [''] }, 'instance:test'))
      .rejects.toThrow('non-empty instance paths');
    await expect(tools.selection('view', { path: '' }, 'instance:test'))
      .rejects.toThrow('non-empty instance path');
    await expect(tools.selection('view', { path: 'game.Workspace.Subject', padding: 0 }, 'instance:test'))
      .rejects.toThrow('greater than 0');
    await expect(tools.selection('view', { path: 'game.Workspace.Subject', angleY: 90 }, 'instance:test'))
      .rejects.toThrow('between -89 and 89');
    await expect(tools.selection('unknown', {}, 'instance:test'))
      .rejects.toThrow('action=get|set|view');
  });
});

class ViewVector {
  constructor(readonly X: number, readonly Y: number, readonly Z: number) {}
  get Magnitude(): number { return Math.hypot(this.X, this.Y, this.Z); }
  get Unit(): ViewVector { return this.mul(1 / this.Magnitude); }
  mul(scale: number): ViewVector { return new ViewVector(this.X * scale, this.Y * scale, this.Z * scale); }
  add(other: ViewVector): ViewVector { return new ViewVector(this.X + other.X, this.Y + other.Y, this.Z + other.Z); }
  sub(other: ViewVector): ViewVector { return this.add(other.mul(-1)); }
}

class ViewFrame {
  constructor(readonly Position: ViewVector, readonly LookVector = new ViewVector(0, 0, -1)) {}
  static lookAt(position: ViewVector, target: ViewVector): ViewFrame {
    return new ViewFrame(position, target.sub(position).Unit);
  }
}

interface ViewInstance {
  path: string;
  ClassName: string;
  IsA(className: string): boolean;
  CFrame: ViewFrame;
  Size: ViewVector;
  GetBoundingBox(): [ViewFrame, ViewVector];
}

function viewInstance(className: string, name = 'Subject'): ViewInstance {
  return {
    path: `game.Workspace.${name}`,
    ClassName: className,
    IsA: (query) => query === className || (className === 'Part' && query === 'BasePart'),
    CFrame: new ViewFrame(new ViewVector(10, 20, 30)),
    Size: new ViewVector(4, 6, 8),
    GetBoundingBox() { return [this.CFrame, this.Size]; },
  };
}

interface ViewHandlers {
  focusViewport(request: Record<string, unknown>): {
    success?: boolean;
    path?: string;
    error?: string;
    cameraPosition?: { X: number; Y: number; Z: number };
  };
}

describe('Studio selection framing', () => {
  let handlerSource: string;

  beforeAll(async () => {
    const result = await esbuildBuild({
      entryPoints: [path.resolve(process.cwd(), '../../studio-plugin/src/modules/handlers/MetadataHandlers.ts')],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      logLevel: 'silent',
      external: ['../Utils', '../LuauExec'],
    });
    handlerSource = result.outputFiles[0].text;
  });

  function loadView(selection: ViewInstance[], originalType = 'Fixed', failFraming = false) {
    const camera = {
      CameraType: originalType,
      CFrame: new ViewFrame(new ViewVector(0, 0, 100)),
      Focus: new ViewFrame(new ViewVector(0, 0, 0)),
      ZoomToExtents(bounds: ViewFrame, size: ViewVector) {
        if (failFraming) throw new Error('framing unavailable');
        this.CFrame = ViewFrame.lookAt(bounds.Position.add(new ViewVector(0, 0, size.Magnitude)), bounds.Position);
      },
    };
    const commonJsModule = { exports: {} as unknown };
    const context = vm.createContext({
      module: commonJsModule,
      exports: commonJsModule.exports,
      require: (name: string) => {
        if (name === '../Utils') {
          return {
            getInstancePath: (instance: ViewInstance) => instance.path,
            getInstanceByPath: (instancePath: string) => selection.find(instance => instance.path === instancePath),
          };
        }
        if (name === '../LuauExec') return {};
        throw new Error(`Unexpected dependency: ${name}`);
      },
      game: {
        GetService: (name: string) => {
          if (name === 'Workspace') return { CurrentCamera: camera };
          if (name === 'Selection') return { Get: () => Object.assign([...selection], { size: () => selection.length }) };
          throw new Error(`Unexpected service: ${name}`);
        },
      },
      Vector3: ViewVector,
      CFrame: ViewFrame,
      Enum: { CameraType: { Scriptable: 'Scriptable' } },
      math: { max: Math.max, sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, rad: (degrees: number) => degrees * Math.PI / 180 },
      tonumber: (value: unknown) => value === undefined ? undefined : Number(value),
      tostring: String,
      typeIs: (value: unknown, expected: string) => typeof value === expected,
      error: (message: string) => { throw new Error(message); },
      pcall: (callback: () => unknown) => {
        try { return [true, callback()]; } catch (error) { return [false, error]; }
      },
    });
    vm.runInContext(handlerSource, context);
    const loaded = commonJsModule.exports as ViewHandlers & { default?: ViewHandlers };
    return { handlers: loaded.default ?? loaded, camera };
  }

  test.each(['Part', 'Model'])('frames the selected %s when path is omitted', (className) => {
    const subject = viewInstance(className);
    const { handlers, camera } = loadView([subject]);

    const result = handlers.focusViewport({});

    expect(result).toMatchObject({ success: true, path: subject.path });
    expect(camera.Focus.Position).toEqual(subject.CFrame.Position);
    expect(result.cameraPosition).toEqual({ X: 10, Y: 20, Z: 30 + subject.Size.Magnitude });
    expect(camera.CameraType).toBe('Fixed');
  });

  test('explicit path overrides an ambiguous selection and preserves Scriptable', () => {
    const subject = viewInstance('Part');
    const { handlers, camera } = loadView([viewInstance('Folder', 'Other'), subject], 'Scriptable');

    expect(handlers.focusViewport({ path: subject.path })).toMatchObject({ success: true, path: subject.path });
    expect(camera.CameraType).toBe('Scriptable');
  });

  test('restores the original camera type when framing throws after taking camera control', () => {
    const subject = viewInstance('Part');
    const { handlers, camera } = loadView([subject], 'Custom', true);

    expect(handlers.focusViewport({ path: subject.path }).error).toContain('framing unavailable');
    expect(camera.CameraType).toBe('Custom');
  });

  test.each([
    { selection: [], reason: /no objects selected/i },
    { selection: [viewInstance('Part'), viewInstance('Model', 'Other')], reason: /exactly one/i },
    { selection: [viewInstance('Folder')], reason: /no 3D bounding box/i },
  ])('rejects unusable selection without changing the camera', ({ selection, reason }) => {
    const { handlers, camera } = loadView(selection);
    const originalFrame = camera.CFrame;

    expect(handlers.focusViewport({}).error).toMatch(reason);
    expect(camera.CameraType).toBe('Fixed');
    expect(camera.CFrame).toBe(originalFrame);
  });

  test('does not fall back to selection for an invalid explicit path', () => {
    const { handlers, camera } = loadView([viewInstance('Part')]);

    expect(handlers.focusViewport({ path: 'game.Workspace.Missing' }).error).toContain('Instance not found');
    expect(handlers.focusViewport({ path: '' }).error).toContain('non-empty instance path');
    expect(camera.CameraType).toBe('Fixed');
  });
});
