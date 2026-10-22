import { diffState, frameStrip, snapshot, uiLayout } from '../fork/evidence.js';
import { composeGrid, gridShape, tileMaxPx } from '../fork/frame-grid.js';
import { imageSize } from '../fork/image-budget.js';
import { layoutIssues, layoutReport, type LayoutNode } from '../fork/layout-checks.js';
import { readForkLimits, setForkLimits } from '../fork/limits.js';
import { diffStates, SnapshotStore, type InstanceState } from '../fork/state-diff.js';
import { rgbaToPng } from '../png-encoder.js';
import type { RobloxStudioTools } from '../tools/index.js';

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
const textOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content[0].text!;

function node(path: string, parent: number, x: number, y: number, w: number, h: number, extra: Partial<LayoutNode> = {}): LayoutNode {
  return { path, className: 'Frame', parent, x, y, w, h, z: 1, ...extra };
}

describe('ui_layout checks', () => {
  const nodes: LayoutNode[] = [
    { path: 'Main', className: 'ScreenGui', parent: -1, x: 0, y: 0, w: 0, h: 0, z: 0 },
    node('Shop', 0, 100, 100, 400, 300, { clips: true }),
    node('Shop.Background', 1, 100, 100, 400, 300),
    node('Shop.Buy', 1, 120, 350, 120, 40),
    node('Shop.Close', 1, 200, 360, 80, 40),
    node('Shop.Overflow', 1, 450, 120, 80, 40),
    node('Shop.Title', 1, 120, 110, 200, 30, { className: 'TextLabel', textFits: false, truncates: true }),
    node('Shop.Hint', 1, 120, 150, 200, 30, { className: 'TextLabel', textFits: false }),
    node('Shop.Hidden', 1, 0, 0, 900, 900, { hidden: true }),
  ];

  test('partial overlaps, overflow and clipped text are reported; containment and hidden elements are not', () => {
    const issues = layoutIssues(nodes);
    expect(issues).toEqual(expect.arrayContaining([
      '! Shop.Title text truncated',
      '! Shop.Hint text clipped',
      '! Shop.Overflow outside Shop by 30px (clipped)',
      '! Shop.Buy overlaps Shop.Close by 40x30',
    ]));
    expect(issues.join('\n')).not.toMatch(/Background|Hidden/);
  });

  test('a 40-element report stays under 3 KB and says when it is capped', () => {
    const many: LayoutNode[] = [{ path: 'Main', className: 'ScreenGui', parent: -1, x: 0, y: 0, w: 0, h: 0, z: 0 }];
    for (let i = 0; i < 60; i++) many.push(node(`Inventory.Grid.Slot${i}`, 0, (i % 8) * 60, Math.floor(i / 8) * 60, 56, 56));
    const report = layoutReport(many, 61, 40);
    expect(report[0]).toBe('no layout issues');
    expect(report.at(-1)).toBe('… 40 of 61 elements; raise limit or narrow gui_path');
    expect(report).toContain('Inventory.Grid.Slot9 Frame 60,60 56x56 z1');
    expect(bytes(report.join('\n'))).toBeLessThanOrEqual(3072);
  });
});

describe('snapshot and diff_state', () => {
  test('diffs report changed values, attribute changes and missing instances only', () => {
    const before: InstanceState[] = [
      { path: 'Workspace.Door', found: true, values: { Transparency: '0', CFrame: '0,5,0@0,0,0' }, attributes: { Open: 'false', Locked: 'true' } },
      { path: 'Workspace.Key', found: true, values: {}, attributes: {} },
      { path: 'Workspace.Later', found: false },
    ];
    const after: InstanceState[] = [
      { path: 'Workspace.Door', found: true, values: { Transparency: '0.8', CFrame: '0,5,0@0,0,0' }, attributes: { Open: 'true', Colour: '#ff0000' } },
      { path: 'Workspace.Key', found: false },
      { path: 'Workspace.Later', found: true, values: {}, attributes: {} },
    ];
    const lines = diffStates(before, after);
    expect(lines).toEqual([
      'Workspace.Door.Transparency: 0 → 0.8',
      'Workspace.Door@Open: false → true',
      '-Workspace.Door@Locked',
      '+Workspace.Door@Colour=#ff0000',
      '! missing Workspace.Key',
      '+ Workspace.Later appeared',
    ]);
    expect(diffStates(before, before)).toEqual(['no changes']);
    expect(bytes(lines.join('\n'))).toBeLessThanOrEqual(1024);
  });

  test('the store keeps the newest 20 snapshots', () => {
    const store = new SnapshotStore();
    for (let i = 0; i < 25; i++) store.add({ role: 'server', paths: [], fields: [], state: [] });
    expect(store.get('s1')).toBeUndefined();
    expect(store.get('s25')?.id).toBe('s25');
    expect(store.get('s6')).toBeDefined();
  });

  test('diff_state reads the same peer the snapshot came from', async () => {
    const reads: Array<{ role: unknown; data: unknown }> = [];
    let transparency = '0';
    const tools = {
      forkBridge: () => ({
        refreshTopology: () => undefined,
        hasRole: (_id: unknown, role: string) => role === 'server',
        callSingle: async (_endpoint: string, data: unknown, role: unknown) => {
          reads.push({ role, data });
          return { instances: [{ path: 'Workspace.Door', found: true, values: { Transparency: transparency }, attributes: { Open: 'false' } }] };
        },
      }),
    } as unknown as RobloxStudioTools;
    const saved = textOf(await snapshot(tools, { paths: ['Workspace.Door'], fields: ['Transparency'] }));
    const id = /^snapshot (s\d+): 2 values, 1 instance$/.exec(saved)![1];
    transparency = '1';
    expect(textOf(await diffState(tools, { snapshot_id: id }))).toBe('Workspace.Door.Transparency: 0 → 1');
    expect(reads.map((read) => read.role)).toEqual(['server', 'server']);
    expect(reads[1].data).toEqual({ paths: ['Workspace.Door'], fields: ['Transparency'] });
    expect(textOf(await diffState(tools, { snapshot_id: 's999' }))).toMatch(/^ERROR no snapshot "s999"/);
    expect(textOf(await snapshot(tools, { paths: [] }))).toMatch(/^ERROR paths must be/);
  });
});

describe('ui_layout tool', () => {
  test('defaults to client-1 during a playtest', async () => {
    const calls: Array<{ choice: { fallback: string } }> = [];
    const tools = {
      forkBridge: () => ({
        refreshTopology: () => undefined,
        hasRole: () => true,
        callSingle: async (_endpoint: string, _data: unknown, choice: { fallback: string }) => {
          calls.push({ choice });
          return { nodes: [node('Main', -1, 0, 0, 100, 100)], total: 1 };
        },
      }),
    } as unknown as RobloxStudioTools;
    expect(textOf(await uiLayout(tools, { gui_path: 'PlayerGui.Main' }))).toBe('no layout issues\nMain Frame 0,0 100x100 z1');
    expect(calls[0].choice.fallback).toBe('client-1');
    expect(textOf(await uiLayout(tools, { gui_path: 'x', target: 'everyone' }))).toMatch(/^ERROR target/);
  });
});

describe('frame_strip', () => {
  afterEach(() => setForkLimits());

  test('grid shape and tile size keep the whole grid within max px', () => {
    expect(gridShape(4)).toEqual({ cols: 2, rows: 2 });
    expect(gridShape(5)).toEqual({ cols: 3, rows: 2 });
    expect(gridShape(12)).toEqual({ cols: 4, rows: 3 });
    expect(tileMaxPx(4, 512)).toBe(255);
    const grid = composeGrid([
      { rgba: Buffer.alloc(4 * 4 * 4, 255), width: 4, height: 4 },
      { rgba: Buffer.alloc(4 * 4 * 4, 0), width: 4, height: 4 },
      { rgba: Buffer.alloc(4 * 4 * 4, 255), width: 4, height: 4 },
    ]);
    expect([grid.width, grid.height]).toEqual([10, 10]);
    // Second tile starts after a 2 px gap.
    expect([...grid.rgba.subarray((0 * 10 + 6) * 4, (0 * 10 + 6) * 4 + 4)]).toEqual([0, 0, 0, 0]);
  });

  test('frames are captured on schedule and returned as one capped JPEG', async () => {
    setForkLimits(readForkLimits([], {}));
    const budgets: Array<{ maxPx: number }> = [];
    const tools = {
      forkBridge: () => ({
        refreshTopology: () => undefined,
        resolveRuntime: () => ({ instanceId: 'inst', clientRole: 'client-1' }),
        callSingle: async () => ({}),
        captureViewportImage: async (_id: string, role: string, format: string, _q: unknown, _m: unknown, budget: { maxPx: number }) => {
          budgets.push(budget);
          expect([role, format]).toEqual(['client-1', 'png']);
          const w = budget.maxPx;
          const h = Math.round(w * 9 / 16);
          const rgba = Buffer.alloc(w * h * 4);
          for (let i = 0; i < rgba.length; i += 4) rgba.set([(i / 4) % 256, 80, 160, 255], i);
          return { success: true, data: rgbaToPng(rgba, w, h).toString('base64'), width: w, height: h };
        },
      }),
    } as unknown as RobloxStudioTools;
    const result = await frameStrip(tools, { frames: 4, interval: 0 });
    expect(budgets).toHaveLength(4);
    expect(budgets[0].maxPx).toBe(255);
    const line = textOf(result);
    expect(line).toMatch(/^frame_strip 4 frames, 2x2 grid 512x\d+px, tile 255x143, left to right then down; t=0\.\d\d,0\.\d\d,0\.\d\d,0\.\d\ds$/);
    const image = Buffer.from((result.content[1] as { data: string }).data, 'base64');
    const size = imageSize(image)!;
    expect(Math.max(size.w, size.h)).toBeLessThanOrEqual(512);
    expect(image.length).toBeLessThanOrEqual(60 * 1024);
  });

  test('bad arguments fail with one line', async () => {
    const tools = {} as RobloxStudioTools;
    expect(textOf(await frameStrip(tools, { frames: 1 }))).toMatch(/frames must be/);
    expect(textOf(await frameStrip(tools, { interval: 5 }))).toMatch(/interval must be/);
    expect(textOf(await frameStrip(tools, { target: 'server' }))).toMatch(/server renders nothing/);
  });
});
