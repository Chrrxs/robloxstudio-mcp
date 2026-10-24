import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { build as esbuildBuild, type Plugin } from 'esbuild';

// Runs a studio-plugin TypeScript module in a VM with the subset of Luau
// globals the plugin uses. Strings are indexed by code unit, so tests keep
// text ASCII or pass UTF-8 bytes as Latin-1 code units.

export function repositoryRoot(): string {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, 'studio-plugin')) ? cwd : path.resolve(cwd, '../..');
}

function luaRange(length: number, index: number): number {
  return index < 0 ? length + index + 1 : index;
}

const LUA_CLASSES: Record<string, string> = {
  a: '[A-Za-z]', d: '[0-9]', l: '[a-z]', u: '[A-Z]', s: '\\s', w: '[A-Za-z0-9]', p: '[!-/:-@[-`{-~]',
};

// The Lua pattern subset the tests use: classes, captures, anchors, and the
// quantifiers + * ? -. Anything JavaScript cannot compile is "malformed".
function luaPatternToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '%') {
      const next = pattern[++index];
      if (next === undefined) throw new Error('malformed pattern (ends with \'%\')');
      source += LUA_CLASSES[next] ?? `\\${next}`;
    } else if (char === '.') {
      source += '[\\s\\S]';
    } else if (char === '-') {
      source += '*?';
    } else if ('()+*?^$[]'.includes(char)) {
      source += char;
    } else {
      source += char.replace(/[\\{}|/]/g, '\\$&');
    }
  }
  try {
    return new RegExp(source, 'g');
  } catch {
    throw new Error(`malformed pattern: ${pattern}`);
  }
}

function expandReplacement(replacement: string, match: string, captures: string[]): string {
  return replacement.replace(/%(.)/g, (_all, symbol: string) => {
    if (symbol === '%') return '%';
    if (symbol === '0') return match;
    if (/[1-9]/.test(symbol)) {
      const capture = captures.length === 0 && symbol === '1' ? match : captures[Number(symbol) - 1];
      if (capture === undefined) throw new Error(`invalid capture index %${symbol}`);
      return capture;
    }
    throw new Error("invalid use of '%' in replacement string");
  });
}

export const luaString = {
  sub(text: string, i: number, j = -1): string {
    const start = Math.max(1, luaRange(text.length, i));
    const finish = Math.min(text.length, luaRange(text.length, j));
    return start > finish ? '' : text.slice(start - 1, finish);
  },
  find(text: string, pattern: string, init = 1, plain?: boolean): [number?, number?] {
    if (plain !== true) throw new Error('test shim only supports plain find');
    const start = Math.max(1, luaRange(text.length, init));
    if (start > text.length + 1) return [undefined];
    const found = text.indexOf(pattern, start - 1);
    return found < 0 ? [undefined] : [found + 1, found + pattern.length];
  },
  byte(text: string, i = 1, j = i): number[] {
    const bytes: number[] = [];
    for (let index = i; index <= j && index <= text.length; index++) bytes.push(text.charCodeAt(index - 1));
    return bytes;
  },
  gsub(text: string, pattern: string, replacement: string): [string, number] {
    let count = 0;
    const result = text.replace(luaPatternToRegExp(pattern), (match: string, ...rest: unknown[]) => {
      count++;
      const captures = rest.slice(0, -2).map((capture) => String(capture ?? ''));
      return expandReplacement(replacement, match, captures);
    });
    return [result, count];
  },
};

function robloxPcall(callback: (...args: unknown[]) => unknown, ...args: unknown[]): [boolean, unknown] {
  try {
    return [true, callback(...args)];
  } catch (error) {
    return [false, error instanceof Error ? error.message : error];
  }
}

export const luauGlobals = {
  string: luaString,
  math: Math,
  bit32: {
    bxor: (a: number, b: number) => (a ^ b) >>> 0,
    lshift: (value: number, bits: number) => (value << bits) >>> 0,
  },
  typeIs: (value: unknown, expected: string) => expected === 'table'
    ? value !== null && typeof value === 'object'
    : typeof value === expected,
  pcall: robloxPcall,
  tostring: (value: unknown) => String(value),
  pairs: (table: object) => Object.entries(table),
  error: (message: unknown) => {
    throw new Error(String(message));
  },
};

/** Gives an array built outside the VM the Array#size the plugin calls. */
export function luauArray<T>(items: T[]): T[] {
  return Object.defineProperty(items, 'size', { value() { return this.length; } });
}

export async function loadPluginModule<T>(
  relativePath: string,
  globals: Record<string, unknown> = {},
  plugins: Plugin[] = [],
): Promise<T> {
  const buildResult = await esbuildBuild({
    entryPoints: [path.join(repositoryRoot(), relativePath)],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
    plugins,
  });
  const commonJsModule = { exports: {} as unknown };
  const context = vm.createContext({ module: commonJsModule, exports: commonJsModule.exports, console, ...luauGlobals, ...globals });
  vm.runInContext(`
    String.prototype.size = function() { return String(this).length; };
    String.prototype.lower = function() { return String(this).toLowerCase(); };
    Array.prototype.size = function() { return this.length; };
  `, context);
  vm.runInContext(buildResult.outputFiles[0].text, context);
  const loaded = commonJsModule.exports as { default?: T } & T;
  return loaded.default ?? loaded;
}
