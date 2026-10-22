// Response cap: keeps every tool result under a byte budget. Structured results
// lose the tail of their largest arrays and strings (so they stay valid JSON);
// text results are cut at a line boundary. Either way one line says what was
// dropped and which arguments narrow the output.
import type { CallToolResult } from '@modelcontextprotocol/server';

export interface CapOutcome {
  result: CallToolResult;
  /** Text and structured bytes before capping (images excluded). */
  originalBytes: number;
  /** Text and structured bytes after capping. */
  bytes: number;
  truncated: boolean;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type TextBlock = { type: 'text'; text: string };

const utf8 = (text: string) => Buffer.byteLength(text, 'utf8');
const MIN_STRING_CHARS = 32;
const MAX_SHRINK_PASSES = 64;

export function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function isText(block: unknown): block is TextBlock {
  return !!block && typeof block === 'object' && (block as TextBlock).type === 'text' && typeof (block as TextBlock).text === 'string';
}

/** In the legacy era the first text block repeats structuredContent; it is a projection, not extra payload. */
function hasLegacyProjection(result: CallToolResult, era: string): boolean {
  return era !== 'modern' && result.structuredContent !== undefined && isText(result.content[0]);
}

function textBlocks(result: CallToolResult, era: string): TextBlock[] {
  const skip = hasLegacyProjection(result, era) ? 1 : 0;
  return result.content.slice(skip).filter(isText);
}

export function measureResult(result: CallToolResult, era: string): number {
  const text = textBlocks(result, era).reduce((sum, block) => sum + utf8(block.text), 0);
  return text + (result.structuredContent === undefined ? 0 : utf8(JSON.stringify(result.structuredContent)));
}

interface Candidate {
  parent: Json[] | { [key: string]: Json };
  key: number | string;
  size: number;
}

interface Cut {
  path: string;
  kept: number;
  total: number;
}

/** Serialized size of `value`, recording the largest shrinkable array or string. */
function sizeOf(value: Json, parent: Candidate['parent'] | undefined, key: number | string, best: { candidate?: Candidate }): number {
  let size: number;
  if (Array.isArray(value)) {
    size = 2 + Math.max(0, value.length - 1);
    value.forEach((child, index) => { size += sizeOf(child, value, index, best); });
    // A one-element array is shrunk through its element instead.
    if (parent && value.length > 1 && size > (best.candidate?.size ?? 0)) best.candidate = { parent, key, size };
    return size;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    size = 2 + Math.max(0, entries.length - 1);
    for (const [childKey, child] of entries) size += utf8(JSON.stringify(childKey)) + 1 + sizeOf(child, value, childKey, best);
    return size;
  }
  size = utf8(JSON.stringify(value) ?? 'null');
  if (parent && typeof value === 'string' && value.length > MIN_STRING_CHARS && size > (best.candidate?.size ?? 0)) {
    best.candidate = { parent, key, size };
  }
  return size;
}

function pathOf(root: Json, target: Candidate['parent'], key: number | string): string | undefined {
  const walk = (node: Json, path: string): string | undefined => {
    if (node === target) return typeof key === 'number' ? `${path}[${key}]` : `${path}${path ? '.' : ''}${key}`;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const found = walk(node[i], `${path}[${i}]`);
        if (found) return found;
      }
    } else if (node && typeof node === 'object') {
      for (const [childKey, child] of Object.entries(node)) {
        const found = walk(child, `${path}${path ? '.' : ''}${childKey}`);
        if (found) return found;
      }
    }
    return undefined;
  };
  return walk(root, '');
}

/** Shrinks `root` in place until it serializes within `targetBytes` or nothing is left to cut. */
export function shrinkJson(root: { [key: string]: Json }, targetBytes: number): Cut[] {
  const cuts: Cut[] = [];
  for (let pass = 0; pass < MAX_SHRINK_PASSES; pass++) {
    const best: { candidate?: Candidate } = {};
    const total = sizeOf(root, undefined, '', best);
    if (total <= targetBytes || !best.candidate) break;
    const { parent, key, size } = best.candidate;
    const keepRatio = Math.max(0, (size - (total - targetBytes)) / size);
    const node = (parent as Record<string | number, Json>)[key];
    if (Array.isArray(node)) {
      const keep = Math.max(1, Math.min(node.length - 1, Math.floor(node.length * keepRatio)));
      const path = pathOf(root, parent, key) ?? String(key);
      const previous = cuts.find((cut) => cut.path === path);
      if (previous) previous.kept = keep;
      else cuts.push({ path, kept: keep, total: node.length });
      node.length = keep;
    } else if (typeof node === 'string') {
      const keep = Math.max(MIN_STRING_CHARS, Math.floor(node.length * keepRatio) - 1);
      (parent as Record<string | number, Json>)[key] = `${node.slice(0, keep)}…`;
    }
  }
  return cuts;
}

/** Cuts text at the last line break inside the budget (or hard, when no line break is close). */
function cutText(text: string, maxBytes: number): string {
  if (utf8(text) <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && utf8(text.slice(0, end)) > maxBytes) end = Math.floor(end * 0.9);
  const lineEnd = text.lastIndexOf('\n', end);
  return text.slice(0, lineEnd > end / 2 ? lineEnd : end);
}

function noteLine(originalBytes: number, droppedBytes: number, hint: string, cuts: Cut[]): string {
  const where = cuts.slice(0, 2).map((cut) => `${cut.path}: ${cut.kept} of ${cut.total}`).join(', ');
  return `[truncated ${formatBytes(droppedBytes)} of ${formatBytes(originalBytes)}${where ? ` (${where})` : ''}; narrow with ${hint}]`;
}

/** Applies a byte cap to a normalized tool result; cap 0 leaves it untouched. */
export function capResult(result: CallToolResult, era: string, cap: number, hint: string): CapOutcome {
  const originalBytes = measureResult(result, era);
  if (cap <= 0 || originalBytes <= cap) return { result, originalBytes, bytes: originalBytes, truncated: false };

  // Room for the note line itself.
  const reserve = 160 + utf8(hint);
  const budget = Math.max(0, cap - reserve);
  const legacy = hasLegacyProjection(result, era);
  let structured = result.structuredContent as { [key: string]: Json } | undefined;
  let cuts: Cut[] = [];

  const texts = textBlocks(result, era);
  const textBytes = texts.reduce((sum, block) => sum + utf8(block.text), 0);
  if (structured) {
    structured = structuredClone(structured);
    cuts = shrinkJson(structured, Math.max(budget - textBytes, Math.floor(budget / 2)));
  }

  let remaining = budget - (structured ? utf8(JSON.stringify(structured)) : 0);
  const kept = new Set<TextBlock>();
  const cutBlocks = new Map<TextBlock, TextBlock>();
  for (const block of texts) {
    if (remaining <= 0) break;
    const bytes = utf8(block.text);
    if (bytes <= remaining) {
      kept.add(block);
      remaining -= bytes;
    } else {
      cutBlocks.set(block, { ...block, text: cutText(block.text, remaining) });
      remaining = 0;
    }
  }

  const draft: CallToolResult = { ...result, content: [] };
  if (structured) draft.structuredContent = structured;
  for (const [index, block] of result.content.entries()) {
    if (legacy && index === 0) continue;
    if (!isText(block)) draft.content.push(block);
    else if (kept.has(block)) draft.content.push(block);
    else if (cutBlocks.has(block)) draft.content.push(cutBlocks.get(block)!);
  }

  const bytesBeforeNote = measureResult(draft, 'modern');
  const note = noteLine(originalBytes, originalBytes - bytesBeforeNote, hint, cuts);
  if (structured) {
    structured.truncated = note;
  } else {
    let last: TextBlock | undefined;
    for (const block of draft.content) if (isText(block)) last = block;
    if (last) {
      const index = draft.content.indexOf(last);
      draft.content[index] = { ...last, text: `${last.text}${last.text.endsWith('\n') ? '' : '\n'}${note}` };
    } else {
      draft.content.push({ type: 'text', text: note });
    }
  }
  if (legacy) draft.content.unshift({ type: 'text', text: JSON.stringify(structured) });
  return { result: draft, originalBytes, bytes: measureResult(draft, era), truncated: true };
}
