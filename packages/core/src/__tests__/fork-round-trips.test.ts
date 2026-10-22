import { formatLogLines, MAX_LOG_LINES, tagRole, type LogEntry } from '../fork/log-lines.js';
import { formatLogsSince, logsSince, queryTree, waitFor } from '../fork/round-trips.js';
import type { RobloxStudioTools } from '../tools/index.js';

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
const textOf = (result: { content: Array<{ text: string }> }) => result.content[0].text;
const T0 = Date.UTC(2026, 9, 22, 12, 3, 4, 500) / 1000;

function fakeBridge(response: unknown, roles: string[] = ['edit']) {
  const calls: Array<{ endpoint: string; data: unknown; choice: { requested?: string; fallback: string }; timeoutMs?: number }> = [];
  const tools = {
    forkBridge: () => ({
      refreshTopology: () => undefined,
      hasRole: (_id: string | undefined, role: string) => roles.includes(role),
      callSingle: async (endpoint: string, data: unknown, choice: { requested?: string; fallback: string }, _id: unknown, timeoutMs?: number) => {
        calls.push({ endpoint, data, choice, timeoutMs });
        return response;
      },
    }),
  } as unknown as RobloxStudioTools;
  return { tools, calls };
}

describe('logs_since formatting', () => {
  const entry = (role: string, level: string, message: string, offset = 0): LogEntry => ({ ts: T0 + offset, role, level, message });

  test('warnings and up by default, repeats collapsed in first-seen order', () => {
    const lines = formatLogLines([
      entry('server', 'OUT', 'hello'),
      entry('server', 'WARN', 'slow tick', 1),
      entry('client-1', 'ERR', 'nil index\nstack line 1', 2),
      entry('server', 'WARN', 'slow tick', 3),
      entry('server', 'WARN', 'slow tick', 4),
    ], { minLevel: 'warn' });
    expect(lines).toEqual([
      '12:03:05.5 server WARN slow tick (x3)',
      '12:03:06.5 client-1 ERR nil index | stack line 1',
    ]);
  });

  test('min_level and target narrow further', () => {
    const entries = [entry('server', 'OUT', 'a'), entry('client-1', 'INFO', 'b'), entry('client-1', 'ERR', 'c')];
    expect(formatLogLines(entries, { minLevel: 'out', role: 'client-1' })).toHaveLength(2);
    expect(formatLogLines(entries, { minLevel: 'error' })).toEqual(['12:03:04.5 client-1 ERR c']);
  });

  test('only the newest lines are kept', () => {
    const entries = Array.from({ length: 80 }, (_, i) => entry('server', 'WARN', `w${i}`, i));
    const lines = formatLogLines(entries, { minLevel: 'warn' });
    expect(lines).toHaveLength(MAX_LOG_LINES + 1);
    expect(lines[0]).toBe('… 30 earlier lines omitted');
    expect(lines.at(-1)).toContain('w79');
  });

  test('200 noisy entries stay under 2 KB', () => {
    const entries = Array.from({ length: 200 }, (_, i) =>
      entry(i % 2 ? 'server' : 'client-1', i % 3 ? 'WARN' : 'ERR', `Remote ${i % 7} rejected: rate limit exceeded`, i / 10));
    const output = formatLogsSince({ instanceId: 'x', entries, nextCursor: 'abc' }, 'warn').join('\n');
    expect(bytes(output)).toBeLessThanOrEqual(2048);
    expect(output).toMatch(/\(x\d+\)/);
  });

  test('tagRole adds the peer role to object entries only', () => {
    expect(tagRole({ ts: 1, message: 'm' }, 'server')).toEqual({ ts: 1, message: 'm', role: 'server' });
    expect(tagRole('raw', 'server')).toBe('raw');
  });

  test('cursors round-trip for one Instance and for a multiplayer group', async () => {
    const calls: unknown[][] = [];
    let response: Record<string, unknown> = { instanceId: 'a', entries: [entry('server', 'WARN', 'x')], nextCursor: 'CUR1' };
    const tools = {
      getRuntimeLogs: async (...args: unknown[]) => {
        calls.push(args);
        return { content: [{ type: 'text', text: JSON.stringify(response) }] };
      },
    } as unknown as RobloxStudioTools;

    const first = textOf(await logsSince(tools, { pattern: 'x' }));
    expect(first.split('\n').at(-1)).toBe('cursor=i.CUR1');
    await logsSince(tools, { cursor: 'i.CUR1' });
    expect(calls[0][5]).toBe('x');
    expect(calls[0][7]).toBe(true);
    expect(calls[1][2]).toBe('CUR1');

    response = {
      multiplayerGroupId: 'g',
      instances: [{ instanceId: 'a', entries: [], nextCursor: 'A1' }, { instanceId: 'b', error: 'gone', nextCursor: 'B1', peerErrors: [] }],
      nextCursorByInstance: { a: 'A1', b: 'B1' },
    };
    const group = textOf(await logsSince(tools, {}));
    expect(group).toContain('! b: gone');
    const cursor = group.split('\n').at(-1)!.slice('cursor='.length);
    await logsSince(tools, { cursor });
    expect(calls.at(-1)![3]).toEqual({ a: 'A1', b: 'B1' });

    await expect(logsSince(tools, { cursor: 'nope' })).rejects.toThrow(/cursor is invalid/);
    expect(textOf(await logsSince(tools, { min_level: 'loud' }))).toMatch(/^ERROR min_level/);
  });
});

describe('wait_for', () => {
  test('defaults to the server peer during a playtest and waits past the timeout', async () => {
    const { tools, calls } = fakeBridge({ ok: true, elapsed: 1.4213, polls: 15, value: 'true' }, ['edit', 'server', 'client-1']);
    const result = await waitFor(tools, { expr: 'workspace.Door.Open.Value', timeout: 10 });
    expect(textOf(result)).toBe('ok 1.42s polls=15 value=true');
    expect(calls[0]).toMatchObject({ endpoint: '/api/fork/wait-for', data: { expr: 'workspace.Door.Open.Value', timeout: 10 }, choice: { fallback: 'server' } });
    expect(calls[0].timeoutMs).toBeGreaterThan(10_000);
    expect(bytes(textOf(result))).toBeLessThanOrEqual(256);
  });

  test('edit is the default outside a playtest; an explicit target wins', async () => {
    const { tools, calls } = fakeBridge({ ok: false, elapsed: 5.01, polls: 50, value: 'nil' });
    const result = await waitFor(tools, { expr: 'x', target: 'client-2' });
    expect(textOf(result)).toBe('TIMEOUT 5.01s polls=50 last=nil');
    expect(result.isError).toBeUndefined();
    expect(calls[0].choice).toMatchObject({ requested: 'client-2', fallback: 'edit' });
  });

  test('errors are one line', async () => {
    const { tools } = fakeBridge({ error: 'Unknown endpoint: /api/fork/wait-for' });
    const old = await waitFor(tools, { expr: 'x' });
    expect(old.isError).toBe(true);
    expect(textOf(old)).toMatch(/^ERROR wait_for needs the fork's Studio plugin/);
    expect(textOf(await waitFor(tools, { expr: ' ' }))).toBe('ERROR expr is required.');
    expect(textOf(await waitFor(tools, { expr: 'x', timeout: 500 }))).toMatch(/timeout must be 0-120/);
  });
});

describe('query_tree', () => {
  test('passes bounded arguments and reports the total when capped', async () => {
    const lines = Array.from({ length: 25 }, (_, i) => `Door${i} Part Anchored=true Size=4,8,1`);
    const { tools, calls } = fakeBridge({ lines, total: 312 }, ['edit', 'server']);
    const result = await queryTree(tools, { path: 'Workspace', class: 'BasePart', fields: ['Anchored', 'Size'] });
    expect(calls[0]).toMatchObject({
      endpoint: '/api/fork/query-tree',
      data: { path: 'Workspace', class: 'BasePart', fields: ['Anchored', 'Size'], depth: 1, limit: 25 },
      choice: { fallback: 'server' },
    });
    const output = textOf(result);
    expect(output.split('\n').at(-1)).toBe('… 25 of 312; raise limit or narrow class/path');
    expect(bytes(output)).toBeLessThanOrEqual(2048);
  });

  test('no matches and bad arguments', async () => {
    const { tools } = fakeBridge({ lines: [], total: 0 });
    expect(textOf(await queryTree(tools, { path: 'Workspace.Empty' }))).toBe('no matches under Workspace.Empty');
    expect(textOf(await queryTree(tools, { path: '' }))).toBe('ERROR path is required.');
    expect(textOf(await queryTree(tools, { path: 'Workspace', depth: 11 }))).toMatch(/depth must be a whole number from 0 to 10/);
    expect(textOf(await queryTree(tools, { path: 'Workspace', limit: 0 }))).toMatch(/limit must be/);
    expect(textOf(await queryTree(tools, { path: 'Workspace', fields: 'Size' }))).toMatch(/fields must be a list/);
  });
});
