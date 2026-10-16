import * as path from 'path';
import * as vm from 'vm';
import { build as esbuildBuild } from 'esbuild';

// Plain model of a DataModel subtree. `classes` lists every class the node IsA.
interface TestNode {
  name: string;
  className: string;
  classes: string[];
  children: TestNode[];
  parent?: TestNode;
  service?: boolean;
  props?: Record<string, string>;
}

interface PathAmbiguity {
  segment: string;
  parentPath: string;
  matchCount: number;
}

interface PathResolution {
  instance?: TestNode;
  ambiguity?: PathAmbiguity;
}

interface PathTree {
  root: TestNode;
  getParent: (node: TestNode) => TestNode | undefined;
  getChildren: (node: TestNode) => TestNode[];
  getName: (node: TestNode) => string;
  getService: (segment: string) => TestNode | undefined;
  isRootService: (node: TestNode) => boolean;
  getPath: (node: TestNode) => string;
}

interface PathAmbiguityModule {
  resolvePath(tree: PathTree, parts: string[]): PathResolution;
  createAmbiguityChecker(tree: PathTree): (node: TestNode) => boolean;
}

interface InstanceSearchModule {
  createInstanceSearch(corpus: Record<string, unknown>): {
    search(request: Record<string, unknown>, control: { checkpoint(): void }): Record<string, unknown>;
  };
}

interface PathGuardModule {
  createPathGuard(findAmbiguity: (path: string) => PathAmbiguity | undefined): {
    run(endpoint: string, data: Record<string, unknown>, handle: () => unknown): unknown;
  };
}

interface FindCall {
  pattern: string;
  plain: unknown;
}

async function loadPluginModule<T>(relativePath: string, findCalls: FindCall[] = []): Promise<T> {
  const result = await esbuildBuild({
    entryPoints: [path.resolve(process.cwd(), '../../studio-plugin/src/modules', relativePath)],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
  });
  const commonJsModule = { exports: {} as unknown };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    typeIs: (value: unknown, expected: string) => expected === 'table'
      ? value !== null && typeof value === 'object'
      : typeof value === expected,
    math: { floor: Math.floor },
    string: {
      find: (value: string, pattern: string, start = 1, plain?: unknown) => {
        findCalls.push({ pattern, plain });
        const index = value.indexOf(pattern, Math.max(0, start - 1));
        return index < 0 ? [undefined, undefined] : [index + 1, index + pattern.length];
      },
    },
  });
  vm.runInContext(`
    String.prototype.lower = function() { return String(this).toLowerCase(); };
    Array.prototype.size = function() { return this.length; };
  `, context);
  vm.runInContext(result.outputFiles[0].text, context);
  const loaded = commonJsModule.exports as T & { default?: T };
  return loaded.default ?? loaded;
}

function node(name: string, classes: string[], children: TestNode[] = [], extra: Partial<TestNode> = {}): TestNode {
  const created: TestNode = { name, className: classes[0], classes: [...classes, 'Instance'], children, ...extra };
  for (const child of children) child.parent = created;
  return created;
}

type PlaceNode =
  | 'game' | 'workspace' | 'replicated' | 'map' | 'doorA' | 'doorB' | 'lamp'
  | 'bulb' | 'spawn' | 'fire' | 'firstDup' | 'secondDup' | 'shadowed';
type Place = Record<PlaceNode, TestNode>;

function buildPlace(): Place {
  const doorA = node('Door', ['Part', 'BasePart'], [], { props: { Material: 'Enum.Material.Wood' } });
  const doorB = node('Door', ['Part', 'BasePart'], [], { props: { Material: 'Enum.Material.Metal' } });
  const bulb = node('Bulb', ['PointLight', 'Light']);
  const lamp = node('Lamp', ['Model', 'PVInstance'], [bulb]);
  const map = node('Map', ['Folder'], [doorA, doorB, lamp]);
  const spawn = node('Spawn', ['SpawnLocation', 'Part', 'BasePart']);
  const workspace = node('Workspace', ['Workspace', 'WorldRoot', 'Model'], [map, spawn], { service: true });
  const fire = node('Fire', ['RemoteEvent']);
  const replicated = node('ReplicatedStorage', ['ReplicatedStorage'], [node('Remotes', ['Folder'], [fire])], { service: true });
  const firstDup = node('Dup', ['Folder'], [node('Inner', ['Folder'])]);
  const secondDup = node('Dup', ['Folder'], [node('Inner', ['Folder'])]);
  // A plain folder whose name is a service class: game.Workspace never reaches it.
  const shadowed = node('Workspace', ['Folder']);
  const game = node('Game', ['DataModel'], [workspace, replicated, firstDup, secondDup, shadowed]);
  return { game, workspace, replicated, map, doorA, doorB, lamp, bulb, spawn, fire, firstDup, secondDup, shadowed };
}

function createTree(place: Place): PathTree {
  const isRootService = (candidate: TestNode) => candidate.parent === place.game && candidate.service === true;
  const getPath = (target: TestNode): string => {
    const segments: string[] = [];
    let current: TestNode | undefined = target;
    while (current && current !== place.game) {
      segments.unshift(isRootService(current) ? current.className : current.name);
      current = current.parent;
    }
    return ['game', ...segments].join('.');
  };
  return {
    root: place.game,
    getParent: (target) => target.parent,
    getChildren: (target) => target.children,
    getName: (target) => target.name,
    getService: (segment) => place.game.children.find((child) => child.service && child.className === segment),
    isRootService,
    getPath,
  };
}

function createCorpus(place: Place, ambiguity: PathAmbiguityModule) {
  const tree = createTree(place);
  return {
    resolveRoot: (rootPath: string) => ambiguity.resolvePath(
      tree,
      rootPath === '' || rootPath === 'game' ? [] : rootPath.replace(/^game\./, '').split('.'),
    ).instance,
    getChildren: tree.getChildren,
    getName: tree.getName,
    getClassName: (target: TestNode) => target.className,
    isA: (target: TestNode, className: string) => target.classes.includes(className),
    readPropertyText: (target: TestNode, propertyName: string) => target.props?.[propertyName],
    getPath: tree.getPath,
    createAmbiguityChecker: () => ambiguity.createAmbiguityChecker(tree),
  };
}

function plain(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value));
}

const noYield = { checkpoint: () => undefined };

// Fixture arrays are created in this realm, not the vm realm, so they need the
// roblox-ts array size() too. Installed non-enumerably for the suite only.
beforeAll(() => {
  Object.defineProperty(Array.prototype, 'size', {
    configurable: true,
    value(this: unknown[]) { return this.length; },
  });
});

afterAll(() => {
  delete (Array.prototype as { size?: unknown }).size;
});

describe('Studio path ambiguity', () => {
  test('resolvePath returns the first duplicate and reports the ambiguous segment', async () => {
    const ambiguity = await loadPluginModule<PathAmbiguityModule>('PathAmbiguity.ts');
    const place = buildPlace();
    const tree = createTree(place);

    const resolved = ambiguity.resolvePath(tree, ['Workspace', 'Map', 'Door']);
    expect(resolved.instance).toBe(place.doorA);
    expect(plain(resolved.ambiguity)).toEqual({ segment: 'Door', parentPath: 'game.Workspace.Map', matchCount: 2 });

    const nested = ambiguity.resolvePath(tree, ['Dup', 'Inner']);
    expect(nested.instance).toBe(place.firstDup.children[0]);
    expect(plain(nested.ambiguity)).toEqual({ segment: 'Dup', parentPath: 'game', matchCount: 2 });
  });

  test('resolvePath leaves unique paths and service roots unflagged', async () => {
    const ambiguity = await loadPluginModule<PathAmbiguityModule>('PathAmbiguity.ts');
    const place = buildPlace();
    const tree = createTree(place);

    const lamp = ambiguity.resolvePath(tree, ['Workspace', 'Map', 'Lamp', 'Bulb']);
    expect(lamp.instance).toBe(place.bulb);
    expect(lamp.ambiguity).toBeUndefined();

    // The plain folder named Workspace does not make the service segment ambiguous.
    const service = ambiguity.resolvePath(tree, ['Workspace']);
    expect(service.instance).toBe(place.workspace);
    expect(service.ambiguity).toBeUndefined();

    const missing = ambiguity.resolvePath(tree, ['Workspace', 'Nope', 'Deeper']);
    expect(missing.instance).toBeUndefined();
    expect(missing.ambiguity).toBeUndefined();
  });

  test('checker flags duplicates, their descendants, and root children shadowed by services', async () => {
    const ambiguity = await loadPluginModule<PathAmbiguityModule>('PathAmbiguity.ts');
    const place = buildPlace();
    const isAmbiguous = ambiguity.createAmbiguityChecker(createTree(place));

    expect(isAmbiguous(place.doorA)).toBe(true);
    expect(isAmbiguous(place.doorB)).toBe(true);
    expect(isAmbiguous(place.secondDup.children[0])).toBe(true);
    expect(isAmbiguous(place.shadowed)).toBe(true);

    expect(isAmbiguous(place.game)).toBe(false);
    expect(isAmbiguous(place.workspace)).toBe(false);
    expect(isAmbiguous(place.map)).toBe(false);
    expect(isAmbiguous(place.bulb)).toBe(false);
    // Cached verdicts stay correct on repeated lookups.
    expect(isAmbiguous(place.bulb)).toBe(false);
    expect(isAmbiguous(place.secondDup.children[0])).toBe(true);
  });
});

describe('Studio instance search', () => {
  async function loadSearch(findCalls: FindCall[] = []) {
    const ambiguity = await loadPluginModule<PathAmbiguityModule>('PathAmbiguity.ts');
    const module = await loadPluginModule<InstanceSearchModule>('InstanceSearch.ts', findCalls);
    const place = buildPlace();
    return { place, search: module.createInstanceSearch(createCorpus(place, ambiguity)) };
  }

  test('scopes to a subtree, filters by IsA without a query, and marks ambiguous paths', async () => {
    const { search } = await loadSearch();

    const result = plain(search.search({ path: 'game.Workspace', className: 'BasePart' }, noYield));

    expect(result).toEqual({
      results: [
        { name: 'Door', className: 'Part', path: 'game.Workspace.Map.Door', ambiguous: true },
        { name: 'Door', className: 'Part', path: 'game.Workspace.Map.Door', ambiguous: true },
        { name: 'Spawn', className: 'SpawnLocation', path: 'game.Workspace.Spawn' },
      ],
      query: '',
      searchType: 'name',
      count: 3,
      truncated: false,
      maxResults: 100,
      path: 'game.Workspace',
      className: 'BasePart',
    });
  });

  test('stops at maxResults and reports truncation only when more matched', async () => {
    const { search } = await loadSearch();

    const truncated = plain(search.search({ className: 'BasePart', maxResults: 2 }, noYield));
    expect(truncated).toMatchObject({ count: 2, truncated: true, maxResults: 2 });

    const exact = plain(search.search({ className: 'BasePart', maxResults: 3 }, noYield));
    expect(exact).toMatchObject({ count: 3, truncated: false });
  });

  test('combines a case-insensitive plain-text query with the class filter', async () => {
    const findCalls: FindCall[] = [];
    const { search } = await loadSearch(findCalls);

    const result = plain(search.search({ query: 'DOOR', className: 'Part' }, noYield));
    expect((result.results as unknown[]).length).toBe(2);
    expect(findCalls.length).toBeGreaterThan(0);
    expect(findCalls.every((call) => call.plain === true)).toBe(true);

    const classSearch = plain(search.search({ query: 'remote', searchType: 'class', path: 'game.ReplicatedStorage' }, noYield));
    expect(classSearch.results).toEqual([
      { name: 'Fire', className: 'RemoteEvent', path: 'game.ReplicatedStorage.Remotes.Fire' },
    ]);
  });

  test('searches property text and skips instances without the property', async () => {
    const { search } = await loadSearch();

    const result = plain(search.search({ query: 'metal', searchType: 'property', propertyName: 'Material' }, noYield));
    expect(result).toMatchObject({ count: 1, propertyName: 'Material' });
    expect(result.results).toEqual([
      { name: 'Door', className: 'Part', path: 'game.Workspace.Map.Door', ambiguous: true },
    ]);
  });

  test('searches the first match of an ambiguous root and leaves the notice to the path guard', async () => {
    const { search } = await loadSearch();

    const result = plain(search.search({ path: 'game.Dup', query: 'inner' }, noYield));
    expect(result.count).toBe(1);
    expect(result.ambiguousPaths).toBeUndefined();
  });

  test('rejects invalid requests before walking', async () => {
    let checkpoints = 0;
    const counting = { checkpoint: () => { checkpoints++; } };
    const { search } = await loadSearch();

    expect(plain(search.search({}, counting))).toEqual({ error: 'query is required unless className is set' });
    expect(plain(search.search({ query: 'x', maxResults: 0 }, counting)).error).toBe('invalid_request');
    expect(plain(search.search({ query: 'x', maxResults: 1.5 }, counting)).error).toBe('invalid_request');
    expect(plain(search.search({ query: 'x', searchType: 'tag' }, counting)).error).toBe('invalid_request');
    expect(plain(search.search({ query: 'x', searchType: 'property' }, counting)).error).toBe('invalid_request');
    expect(plain(search.search({ className: '' }, counting)).error).toBe('invalid_request');
    expect(plain(search.search({ query: 'x', path: 'game.Workspace.Missing' }, counting)))
      .toEqual({ error: 'Path not found: game.Workspace.Missing' });
    expect(checkpoints).toBe(0);
  });

  test('checkpoints once per visited instance so long scans can yield', async () => {
    let checkpoints = 0;
    const { search } = await loadSearch();

    search.search({ path: 'game.Workspace', query: 'zzz' }, { checkpoint: () => { checkpoints++; } });
    // Workspace, Map, Door, Door, Lamp, Bulb, Spawn
    expect(checkpoints).toBe(7);
  });
});

describe('Studio path guard', () => {
  const twin: PathAmbiguity = { segment: 'Twin', parentPath: 'game.Workspace', matchCount: 2 };

  async function loadGuard() {
    const module = await loadPluginModule<PathGuardModule>('PathGuard.ts');
    const lookups: string[] = [];
    const guard = module.createPathGuard((path) => {
      lookups.push(path);
      return path.includes('Twin') ? twin : undefined;
    });
    return { guard, lookups };
  }

  test('runs handlers untouched when no declared path is ambiguous', async () => {
    const { guard, lookups } = await loadGuard();
    const handled = { ok: true };

    expect(guard.run('/api/instance-properties', { instancePath: 'game.Workspace.Part' }, () => handled)).toBe(handled);
    expect(plain(handled)).toEqual({ ok: true });
    expect(lookups).toEqual(['game.Workspace.Part']);

    // Endpoints without declared paths are never inspected.
    guard.run('/api/execute-luau', { instancePath: 'game.Workspace.Twin' }, () => ({}));
    expect(lookups).toEqual(['game.Workspace.Part']);
  });

  test('annotates read responses, including handler errors, and still runs the handler', async () => {
    const { guard } = await loadGuard();
    const handler = jest.fn(() => ({ error: 'Instance not found: game.Workspace.Twin.Child' }));

    const result = plain(guard.run('/api/get-script-source', { instancePath: 'game.Workspace.Twin.Child' }, handler));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      error: 'Instance not found: game.Workspace.Twin.Child',
      ambiguousPaths: [{
        field: 'instancePath', path: 'game.Workspace.Twin.Child', access: 'read',
        segment: 'Twin', parentPath: 'game.Workspace', matchCount: 2,
      }],
    });
    expect(String(result.pathWarning)).toContain('the first match was used');
  });

  test('reports every ambiguous entry of a path list', async () => {
    const { guard } = await loadGuard();

    const result = plain(guard.run('/api/set-selection', {
      paths: ['game.Workspace.Part', 'game.Workspace.Twin', 'game.Workspace.Twin.Inner'],
    }, () => ({ success: true })));

    expect((result.ambiguousPaths as { field: string }[]).map((report) => report.field)).toEqual(['paths[1]', 'paths[2]']);
    expect(result.success).toBe(true);
  });

  test.each([
    ['/api/set-properties', { instancePath: 'game.Workspace.Twin', properties: { Name: 'X' } }, 'instancePath'],
    ['/api/set-properties', { instancePath: 'game.Workspace.Part', properties: { Parent: 'game.Workspace.Twin' } }, 'properties.Parent'],
    ['/api/set-properties', { instancePath: 'game.Workspace.Part', properties: { PrimaryPart: 'game.Workspace.Twin' } }, 'properties.PrimaryPart'],
    ['/api/set-script-source', { instancePath: 'game.Workspace.Twin', source: '' }, 'instancePath'],
    ['/api/edit-script-lines', { instancePath: 'game.Workspace.Twin' }, 'instancePath'],
    ['/api/insert-script-lines', { instancePath: 'game.Workspace.Twin' }, 'instancePath'],
    ['/api/delete-script-lines', { instancePath: 'game.Workspace.Twin' }, 'instancePath'],
    ['/api/find-and-replace-in-scripts', { path: 'game.Workspace.Twin' }, 'path'],
    ['/api/insert-asset', { parentPath: 'game.Workspace.Twin' }, 'parentPath'],
    ['/api/import-rbxm', { parent_path: 'game.Workspace.Twin' }, 'parent_path'],
  ])('refuses %s via an ambiguous write path without running the handler (case %#)', async (endpoint, data, field) => {
    const { guard } = await loadGuard();
    const handler = jest.fn(() => ({ success: true }));

    const result = plain(guard.run(endpoint, data, handler));

    expect(handler).not.toHaveBeenCalled();
    expect(String(result.error)).toContain('Refusing to modify an arbitrary match');
    expect(result.ambiguousPaths).toEqual([expect.objectContaining({ field, access: 'write', segment: 'Twin' })]);
  });

  test('treats find-and-replace dry runs as reads', async () => {
    const { guard } = await loadGuard();
    const handler = jest.fn(() => ({ dryRun: true, changes: [] }));

    const result = plain(guard.run('/api/find-and-replace-in-scripts', { path: 'game.Workspace.Twin', dryRun: true }, handler));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.ambiguousPaths).toEqual([expect.objectContaining({ field: 'path', access: 'read' })]);
  });

  test('ignores empty and non-string path values', async () => {
    const { guard, lookups } = await loadGuard();

    guard.run('/api/project-structure', { path: '' }, () => ({}));
    guard.run('/api/set-properties', { instancePath: 'game.Workspace.Part', properties: { Parent: '' } }, () => ({}));
    guard.run('/api/export-rbxm', { instance_paths: [42, ''] }, () => ({}));

    expect(lookups).toEqual(['game.Workspace.Part']);
  });
});
