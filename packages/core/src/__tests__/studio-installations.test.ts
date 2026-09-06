import * as path from 'path';
import {
  RML_LAUNCHER_DIRECTORY,
  STUDIO_EXECUTABLE_NAME,
  discoverStudioInstallations,
  parseStudioInstallationSource,
  parseStudioSearchRoots,
  readRmlDefaultInstallation,
  selectStudioInstallation,
  type StudioInstallationFs,
} from '../studio-installations.js';

const LOCAL_APP_DATA = path.join('C:', 'Users', 'dev', 'AppData', 'Local');
const ROAMING_APP_DATA = path.join('C:', 'Users', 'dev', 'AppData', 'Roaming');
const OFFICIAL_ROOT = path.join(LOCAL_APP_DATA, 'Roblox', 'Versions');
const RML_STUDIO = path.join(ROAMING_APP_DATA, RML_LAUNCHER_DIRECTORY, 'studio');
const RML_ROOT = path.join(RML_STUDIO, 'versions');

interface FakeTree {
  /** Executable path -> mtime in ms. */
  files: Record<string, number>;
  /** File path -> contents. */
  texts?: Record<string, string>;
}

function fakeFs(tree: FakeTree): StudioInstallationFs {
  const texts = tree.texts ?? {};
  const directories = new Set<string>();
  for (const file of [...Object.keys(tree.files), ...Object.keys(texts)]) {
    for (let parent = path.dirname(file); parent !== path.dirname(parent); parent = path.dirname(parent)) {
      directories.add(parent);
    }
  }

  return {
    existsSync: (target) =>
      target in tree.files || target in texts || directories.has(target),
    readdirSync: (target) => {
      if (!directories.has(target)) throw new Error(`ENOENT: ${target}`);
      const children = new Set<string>();
      for (const file of [...Object.keys(tree.files), ...Object.keys(texts)]) {
        if (path.dirname(file) === target) children.add(path.basename(file));
        else if (file.startsWith(`${target}${path.sep}`)) {
          children.add(file.slice(target.length + 1).split(path.sep)[0]);
        }
      }
      return [...children];
    },
    statSync: (target) => {
      const mtimeMs = tree.files[target];
      if (mtimeMs === undefined) throw new Error(`ENOENT: ${target}`);
      return { mtimeMs };
    },
    readFileSync: (target) => {
      const contents = texts[target];
      if (contents === undefined) throw new Error(`ENOENT: ${target}`);
      return contents;
    },
  };
}

function studioExe(root: string, versionFolder: string): string {
  return path.join(root, versionFolder, STUDIO_EXECUTABLE_NAME);
}

describe('studio installation discovery', () => {
  const previousSource = process.env.ROBLOX_STUDIO_SOURCE;

  afterEach(() => {
    if (previousSource === undefined) delete process.env.ROBLOX_STUDIO_SOURCE;
    else process.env.ROBLOX_STUDIO_SOURCE = previousSource;
  });

  test('official install alone resolves the most recently modified build', () => {
    const fs = fakeFs({
      files: {
        [studioExe(OFFICIAL_ROOT, 'version-aaa')]: 1_000,
        [studioExe(OFFICIAL_ROOT, 'version-bbb')]: 5_000,
      },
    });

    const installations = discoverStudioInstallations({ localAppData: LOCAL_APP_DATA }, fs);

    expect(installations.map((entry) => entry.versionFolder)).toEqual(['version-bbb', 'version-aaa']);
    expect(selectStudioInstallation(installations)?.executable).toBe(studioExe(OFFICIAL_ROOT, 'version-bbb'));
  });

  test('a mod loader install is discovered even though it lives outside LOCALAPPDATA', () => {
    const fs = fakeFs({
      files: { [studioExe(RML_ROOT, 'version-ccc')]: 4_000 },
    });

    const installations = discoverStudioInstallations(
      { localAppData: LOCAL_APP_DATA, roamingAppData: ROAMING_APP_DATA },
      fs,
    );

    expect(installations).toHaveLength(1);
    expect(installations[0]).toMatchObject({
      executable: studioExe(RML_ROOT, 'version-ccc'),
      source: 'rml',
      launcherDefault: false,
    });
  });

  test('the launcher-declared default outranks a newer official build', () => {
    const fs = fakeFs({
      files: {
        [studioExe(OFFICIAL_ROOT, 'version-aaa')]: 9_000,
        [studioExe(RML_ROOT, 'version-ccc')]: 1_000,
        [studioExe(RML_ROOT, 'version-ddd')]: 2_000,
      },
      texts: {
        [path.join(RML_STUDIO, 'settings.json')]: '{"defaultInstallationId":"managed:version-ccc"}',
      },
    });

    const selected = selectStudioInstallation(
      discoverStudioInstallations({ localAppData: LOCAL_APP_DATA, roamingAppData: ROAMING_APP_DATA }, fs),
    );

    expect(selected?.executable).toBe(studioExe(RML_ROOT, 'version-ccc'));
    expect(selected?.launcherDefault).toBe(true);
  });

  test('a launcher default pointing at the official tree selects the official build', () => {
    const fs = fakeFs({
      files: {
        [studioExe(OFFICIAL_ROOT, 'version-aaa')]: 1_000,
        [studioExe(RML_ROOT, 'version-ccc')]: 9_000,
      },
      texts: {
        [path.join(RML_STUDIO, 'settings.json')]: '{"defaultInstallationId":"roblox-official:version-aaa"}',
      },
    });

    const selected = selectStudioInstallation(
      discoverStudioInstallations({ localAppData: LOCAL_APP_DATA, roamingAppData: ROAMING_APP_DATA }, fs),
    );

    expect(selected).toMatchObject({
      executable: studioExe(OFFICIAL_ROOT, 'version-aaa'),
      source: 'official',
      launcherDefault: true,
    });
  });

  test('a source preference restores single-tree selection', () => {
    const fs = fakeFs({
      files: {
        [studioExe(OFFICIAL_ROOT, 'version-aaa')]: 9_000,
        [studioExe(RML_ROOT, 'version-ccc')]: 1_000,
      },
      texts: {
        [path.join(RML_STUDIO, 'settings.json')]: '{"defaultInstallationId":"managed:version-ccc"}',
      },
    });
    const installations = discoverStudioInstallations(
      { localAppData: LOCAL_APP_DATA, roamingAppData: ROAMING_APP_DATA },
      fs,
    );

    expect(selectStudioInstallation(installations, 'official')?.executable)
      .toBe(studioExe(OFFICIAL_ROOT, 'version-aaa'));
    expect(selectStudioInstallation(installations, 'custom')).toBeUndefined();
  });

  test('extra roots contribute both versioned and flat layouts', () => {
    const extraRoot = path.join('D:', 'Studios');
    const fs = fakeFs({
      files: {
        [path.join(extraRoot, STUDIO_EXECUTABLE_NAME)]: 3_000,
        [studioExe(extraRoot, 'version-eee')]: 7_000,
      },
    });

    const installations = discoverStudioInstallations({ extraRoots: [extraRoot] }, fs);

    expect(installations.map((entry) => entry.executable)).toEqual([
      studioExe(extraRoot, 'version-eee'),
      path.join(extraRoot, STUDIO_EXECUTABLE_NAME),
    ]);
    expect(installations.every((entry) => entry.source === 'custom')).toBe(true);
  });

  test('missing and unreadable install roots are skipped instead of throwing', () => {
    const fs = fakeFs({ files: {} });

    expect(
      discoverStudioInstallations({ localAppData: LOCAL_APP_DATA, roamingAppData: ROAMING_APP_DATA }, fs),
    ).toEqual([]);
  });
});

describe('mod loader default installation parsing', () => {
  test('splits the source slug from the version folder', () => {
    const fs = fakeFs({
      files: {},
      texts: { [path.join(RML_STUDIO, 'settings.json')]: '{"defaultInstallationId":"managed:version-268c7d94"}' },
    });

    expect(readRmlDefaultInstallation(RML_STUDIO, fs)).toEqual({
      slug: 'managed',
      versionFolder: 'version-268c7d94',
    });
  });

  test('rejects malformed json, missing keys, and non-version ids', () => {
    const cases = ['{not json', '{}', '{"defaultInstallationId":42}', '{"defaultInstallationId":"managed:../evil"}'];
    for (const contents of cases) {
      const fs = fakeFs({ files: {}, texts: { [path.join(RML_STUDIO, 'settings.json')]: contents } });
      expect(readRmlDefaultInstallation(RML_STUDIO, fs)).toBeUndefined();
    }
  });
});

describe('studio source and search root parsing', () => {
  test('auto and empty values mean no preference', () => {
    expect(parseStudioInstallationSource(undefined)).toBeUndefined();
    expect(parseStudioInstallationSource('auto')).toBeUndefined();
    expect(parseStudioInstallationSource('  ')).toBeUndefined();
  });

  test('aliases map onto sources and unknown values fail loudly', () => {
    expect(parseStudioInstallationSource('Official')).toBe('official');
    expect(parseStudioInstallationSource('modloader')).toBe('rml');
    expect(() => parseStudioInstallationSource('bloxstrap')).toThrow(/Unsupported ROBLOX_STUDIO_SOURCE/);
  });

  test('search roots split on semicolons and drop blanks', () => {
    expect(parseStudioSearchRoots('C:\\A; ;D:\\B ')).toEqual(['C:\\A', 'D:\\B']);
    expect(parseStudioSearchRoots(undefined)).toEqual([]);
  });
});
