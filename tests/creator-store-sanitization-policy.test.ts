import {
  sanitizeLoadedAsset,
  scanForbiddenImportedInstances,
  type AssetSanitizationOperations,
  type ImportedAssetInstance,
} from '../studio-plugin/src/modules/AssetSanitizationPolicy.js';

class FakeImportedInstance implements ImportedAssetInstance {
  readonly children: FakeImportedInstance[] = [];
  parent?: FakeImportedInstance;
  destroyed = false;

  constructor(
    readonly name: string,
    private readonly classes: string[] = [],
  ) {}

  addChild(child: FakeImportedInstance): FakeImportedInstance {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  IsA(className: string): boolean {
    return this.classes.includes(className);
  }

  GetDescendants(): ImportedAssetInstance[] {
    const descendants: FakeImportedInstance[] = [];
    const pending = [...this.children];
    while (pending.length > 0) {
      const next = pending.pop()!;
      descendants.push(next);
      pending.push(...next.children);
    }
    return descendants;
  }

  Destroy(): void {
    this.destroyed = true;
    if (this.parent) {
      const index = this.parent.children.indexOf(this);
      if (index >= 0) this.parent.children.splice(index, 1);
    }
    this.parent = undefined;
  }
}

function fakeSanitizationOperations(
  refuseToDestroy?: FakeImportedInstance,
): AssetSanitizationOperations {
  return {
    forceUnparent: (root) => {
      (root as FakeImportedInstance).parent = undefined;
      return true;
    },
    destroy: (instance) => {
      const fake = instance as FakeImportedInstance;
      if (fake === refuseToDestroy) return false;
      fake.Destroy();
      return true;
    },
  };
}

describe('Creator Store sanitizer behavior', () => {
  test('removes deeply nested scripts and PackageLinks while preserving visual instances', () => {
    const wrapper = new FakeImportedInstance('Wrapper');
    let cursor = wrapper;
    for (let depth = 0; depth < 2048; depth += 1) {
      cursor = cursor.addChild(new FakeImportedInstance(
        depth === 2047 ? '安全なフォルダ\u200B' : `Folder-${depth}`,
      ));
    }
    const script = cursor.addChild(new FakeImportedInstance(
      '粒子Еffесt\u200D',
      ['LuaSourceContainer'],
    ));
    const packageLink = cursor.addChild(new FakeImportedInstance(
      'HarmlessVisualPackage',
      ['PackageLink'],
    ));
    const particle = cursor.addChild(new FakeImportedInstance('ParticleEmitter', ['ParticleEmitter']));
    const beam = cursor.addChild(new FakeImportedInstance('光束', ['Beam']));

    const result = sanitizeLoadedAsset(wrapper, fakeSanitizationOperations());

    expect(result).toMatchObject({
      success: true,
      removedScriptCount: 1,
      removedPackageLinkCount: 1,
      remainingScriptCount: 0,
      remainingPackageLinkCount: 0,
    });
    expect(script.destroyed).toBe(true);
    expect(packageLink.destroyed).toBe(true);
    expect(particle.destroyed).toBe(false);
    expect(beam.destroyed).toBe(false);
    expect(wrapper.destroyed).toBe(false);
    expect(scanForbiddenImportedInstances(wrapper)).toEqual({
      scripts: [],
      packageLinks: [],
    });
  });

  test('destroys the complete asset when the verification scan finds a surviving script', () => {
    const wrapper = new FakeImportedInstance('Wrapper');
    const script = wrapper.addChild(new FakeImportedInstance('Folder', ['LuaSourceContainer']));

    const result = sanitizeLoadedAsset(wrapper, fakeSanitizationOperations(script));

    expect(result).toMatchObject({
      success: false,
      removedScriptCount: 0,
      remainingScriptCount: 1,
    });
    expect(wrapper.destroyed).toBe(true);
  });

  test('destroys the complete asset when a PackageLink survives removal', () => {
    const wrapper = new FakeImportedInstance('Wrapper');
    const packageLink = wrapper.addChild(new FakeImportedInstance('Visuals', ['PackageLink']));

    const result = sanitizeLoadedAsset(wrapper, fakeSanitizationOperations(packageLink));

    expect(result).toMatchObject({
      success: false,
      removedPackageLinkCount: 0,
      remainingPackageLinkCount: 1,
    });
    expect(wrapper.destroyed).toBe(true);
  });

  test('rejects a forbidden imported root', () => {
    const scriptRoot = new FakeImportedInstance('Model', ['LuaSourceContainer']);

    const result = sanitizeLoadedAsset(scriptRoot, fakeSanitizationOperations());

    expect(result.success).toBe(false);
    expect(scriptRoot.destroyed).toBe(true);
  });
});
