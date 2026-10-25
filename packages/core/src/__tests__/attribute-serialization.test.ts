import * as path from 'path';
import * as vm from 'vm';
import { build as esbuildBuild } from 'esbuild';

// Minimal stand-ins for the Roblox datatypes the attribute serializer reads.
class FakeVector3 {
  readonly __type = 'Vector3';
  constructor(readonly X: number, readonly Y: number, readonly Z: number) {}
}

class FakeCFrame {
  readonly __type = 'CFrame';
  readonly Position: FakeVector3;
  private readonly components: number[];
  constructor(...components: number[]) {
    this.components = components;
    this.Position = new FakeVector3(components[0], components[1], components[2]);
  }
  GetComponents(): number[] {
    return [...this.components];
  }
}

class FakeColor3 {
  readonly __type = 'Color3';
  constructor(readonly R: number, readonly G: number, readonly B: number) {}
}

interface SerializedAttribute {
  value: unknown;
  type: string;
}

interface AttributeHandlers {
  getAttributes(request: Record<string, unknown>): {
    count?: number;
    attributes?: Record<string, SerializedAttribute>;
    error?: string;
  };
}

function typeOf(value: unknown): string {
  if (value instanceof FakeVector3 || value instanceof FakeCFrame || value instanceof FakeColor3) return value.__type;
  return typeof value;
}

// GetComponents order, which CFrame.new accepts unchanged:
// x, y, z, R00, R01, R02, R10, R11, R12, R20, R21, R22.
const QUARTER_TURN_ABOUT_Y = [1, 2, 3, 0, 0, 1, 0, 1, 0, -1, 0, 0];
const HALF_TURN_ABOUT_Y = [1, 2, 3, -1, 0, 0, 0, 1, 0, 0, 0, -1];

describe('get_attributes serialization', () => {
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

  function readAttributes(attributes: Record<string, unknown>) {
    const instance = { GetAttributes: () => attributes };
    const commonJsModule = { exports: {} as unknown };
    const context = vm.createContext({
      module: commonJsModule,
      exports: commonJsModule.exports,
      require: (name: string) => {
        if (name === '../Utils') return { getInstanceByPath: () => instance };
        if (name === '../LuauExec') return {};
        throw new Error(`Unexpected dependency: ${name}`);
      },
      game: { GetService: () => ({}) },
      pairs: Object.entries,
      typeOf,
      tostring: String,
      pcall: (callback: () => unknown) => {
        try { return [true, callback()]; } catch (error) { return [false, error]; }
      },
    });
    vm.runInContext(handlerSource, context);
    const loaded = commonJsModule.exports as AttributeHandlers & { default?: AttributeHandlers };
    const result = (loaded.default ?? loaded).getAttributes({ instancePath: 'game.Workspace.Part' });
    if (result.error) throw new Error(result.error);
    return result.attributes ?? {};
  }

  test('a rotated CFrame keeps its position and every rotation component', () => {
    const { Turned } = readAttributes({ Turned: new FakeCFrame(...QUARTER_TURN_ABOUT_Y) });

    expect(Turned).toEqual({
      type: 'CFrame',
      value: {
        _type: 'CFrame',
        Position: { X: 1, Y: 2, Z: 3 },
        Components: QUARTER_TURN_ABOUT_Y,
      },
    });
  });

  test('CFrames with one position and different orientations stay distinguishable', () => {
    const attributes = readAttributes({
      Quarter: new FakeCFrame(...QUARTER_TURN_ABOUT_Y),
      Half: new FakeCFrame(...HALF_TURN_ABOUT_Y),
    });

    expect(attributes.Quarter.value).not.toEqual(attributes.Half.value);
  });

  test('identity and translated CFrames encode the identity rotation', () => {
    const attributes = readAttributes({
      Identity: new FakeCFrame(0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1),
      Moved: new FakeCFrame(4, -5, 6, 1, 0, 0, 0, 1, 0, 0, 0, 1),
    });

    expect(attributes.Identity.value).toEqual({
      _type: 'CFrame', Position: { X: 0, Y: 0, Z: 0 }, Components: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
    });
    expect(attributes.Moved.value).toEqual({
      _type: 'CFrame', Position: { X: 4, Y: -5, Z: 6 }, Components: [4, -5, 6, 1, 0, 0, 0, 1, 0, 0, 0, 1],
    });
  });

  test('other attribute types keep their encoding', () => {
    const attributes = readAttributes({
      Offset: new FakeVector3(1, 2, 3),
      Tint: new FakeColor3(0.25, 0.5, 1),
      Label: 'crate',
      Count: 7,
      Enabled: true,
    });

    expect(attributes).toEqual({
      Offset: { type: 'Vector3', value: { X: 1, Y: 2, Z: 3, _type: 'Vector3' } },
      Tint: { type: 'Color3', value: { R: 0.25, G: 0.5, B: 1, _type: 'Color3' } },
      Label: { type: 'string', value: 'crate' },
      Count: { type: 'number', value: 7 },
      Enabled: { type: 'boolean', value: true },
    });
  });
});
