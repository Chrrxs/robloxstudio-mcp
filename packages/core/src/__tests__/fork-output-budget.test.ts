import type { CallToolResult } from '@modelcontextprotocol/server';
import { ToolsetError } from '../fork/cli.js';
import { capFor, readForkLimits } from '../fork/limits.js';
import { capResult, measureResult } from '../fork/output-budget.js';

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function structuredResult(structured: Record<string, unknown>): CallToolResult {
  return { content: [], structuredContent: structured };
}

const logLines = (count: number) => Array.from({ length: count }, (_, i) => `12:00:${String(i % 60).padStart(2, '0')} server WARN line ${i} ${'x'.repeat(40)}`).join('\n');

describe('response cap', () => {
  test('results under the cap, and cap 0, pass through untouched', () => {
    const small = textResult('ok');
    expect(capResult(small, 'modern', 4096, 'limit').result).toBe(small);
    const big = textResult(logLines(500));
    const off = capResult(big, 'modern', 0, 'limit');
    expect(off.result).toBe(big);
    expect(off.truncated).toBe(false);
  });

  test('text is cut at a line boundary and ends with one note line', () => {
    const original = logLines(500);
    const outcome = capResult(textResult(original), 'modern', 4096, 'tail or filter');
    const text = (outcome.result.content[0] as { text: string }).text;
    const lines = text.split('\n');
    const note = lines.pop()!;
    expect(outcome.truncated).toBe(true);
    expect(bytes(text)).toBeLessThanOrEqual(4096);
    expect(note).toMatch(/^\[truncated [\d.]+ KB of [\d.]+ KB; narrow with tail or filter\]$/);
    // Every kept line is a whole original line.
    for (const line of lines) expect(original.split('\n')).toContain(line);
  });

  test('structured results shrink their largest array and stay valid JSON', () => {
    const results = Array.from({ length: 300 }, (_, i) => ({ path: `Workspace.Part${i}`, className: 'Part' }));
    const outcome = capResult(structuredResult({ success: true, total: 300, results }), 'modern', 4096, 'maxResults or path');
    const structured = outcome.result.structuredContent as { results: unknown[]; total: number; truncated: string };
    expect(outcome.truncated).toBe(true);
    expect(bytes(JSON.stringify(structured))).toBeLessThanOrEqual(4096);
    expect(structured.total).toBe(300);
    expect(structured.results.length).toBeGreaterThan(10);
    expect(structured.results[0]).toEqual(results[0]);
    expect(structured.truncated).toContain(`results: ${structured.results.length} of 300`);
    expect(structured.truncated).toContain('narrow with maxResults or path');
  });

  test('a single huge string is shortened, not dropped', () => {
    const outcome = capResult(structuredResult({ source: 'a'.repeat(50_000) }), 'modern', 2048, 'line_range');
    const structured = outcome.result.structuredContent as { source: string; truncated: string };
    expect(structured.source.length).toBeGreaterThan(500);
    expect(structured.source.endsWith('…')).toBe(true);
    expect(measureResult(outcome.result, 'modern')).toBeLessThanOrEqual(2048);
  });

  test('legacy clients get a regenerated JSON projection that matches structuredContent', () => {
    const structured = { items: Array.from({ length: 400 }, (_, i) => `item-${i}`) };
    const legacy: CallToolResult = {
      content: [{ type: 'text', text: JSON.stringify(structured) }, { type: 'text', text: 'note' }],
      structuredContent: structured,
    };
    const outcome = capResult(legacy, 'legacy', 2048, 'limit');
    const projection = JSON.parse((outcome.result.content[0] as { text: string }).text);
    expect(projection).toEqual(outcome.result.structuredContent);
    expect(projection.truncated).toContain('items:');
    expect((outcome.result.content[1] as { text: string }).text).toBe('note');
    // The caller's object is never mutated.
    expect(structured.items).toHaveLength(400);
  });

  test('image blocks are kept and do not count toward the text cap', () => {
    const result: CallToolResult = {
      content: [{ type: 'text', text: 'short' }, { type: 'image', data: 'A'.repeat(100_000), mimeType: 'image/png' }],
    };
    expect(capResult(result, 'modern', 1024, 'x').result).toBe(result);
  });
});

describe('limits', () => {
  test('defaults: 4 KB cap, built-in overrides, 512 px images at q70', () => {
    const limits = readForkLimits([], {});
    expect(limits.responseCap).toBe(4096);
    expect(capFor(limits, 'get_script_source')).toBe(16384);
    expect(capFor(limits, 'execute_luau')).toBe(8192);
    expect(capFor(limits, 'grep_scripts')).toBe(4096);
    expect(limits.imageMaxPx).toBe(512);
    expect(limits.imageQuality).toBe(70);
    expect(limits.metricsFile).toBeUndefined();
    expect(limits.profile).toBe('full');
  });

  test('flag beats env, env overrides merge over built-ins', () => {
    const limits = readForkLimits(['--response-cap', '2048', '--profile', 'playtest'], {
      MCP_RESPONSE_CAP: '9999',
      MCP_RESPONSE_CAP_OVERRIDES: 'grep_scripts=8192, get_script_source=0',
      MCP_IMAGE_MAX_PX: '768',
      MCP_IMAGE_QUALITY: '55',
      MCP_METRICS_FILE: '/tmp/m.jsonl',
    });
    expect(limits.responseCap).toBe(2048);
    expect(capFor(limits, 'grep_scripts')).toBe(8192);
    expect(capFor(limits, 'get_script_source')).toBe(0);
    expect(capFor(limits, 'execute_luau')).toBe(8192);
    expect(limits.imageMaxPx).toBe(768);
    expect(limits.imageQuality).toBe(55);
    expect(limits.metricsFile).toBe('/tmp/m.jsonl');
    expect(limits.profile).toBe('playtest');
  });

  test('bad values fail with one clear message', () => {
    expect(() => readForkLimits(['--response-cap', '4k'], {})).toThrow(ToolsetError);
    expect(() => readForkLimits(['--response-cap'], {})).toThrow(/needs a byte count/);
    expect(() => readForkLimits([], { MCP_RESPONSE_CAP_OVERRIDES: 'grep_scripts' })).toThrow(/tool=bytes/);
    expect(() => readForkLimits([], { MCP_IMAGE_QUALITY: '0' })).toThrow(/1-100/);
    expect(() => readForkLimits([], { MCP_IMAGE_QUALITY: '101' })).toThrow(/at most 100/);
  });
});
