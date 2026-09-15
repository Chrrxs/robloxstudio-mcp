// Field report #6 + #15: RuntimeLogBuffer merges MessageError + "Stack Begin"/"Script '…', Line N"/"Stack End"
// into one entry (script/line/stack), dedupes identical entries (count/firstTs/lastTs), and filters by level/sinceTs/exclude.
import * as path from 'path';
import * as vm from 'vm';
import { build as esbuildBuild } from 'esbuild';

type LogLevel = 'OUT' | 'WARN' | 'ERR' | 'INFO';

interface RuntimeLogEntry {
  seq: number;
  ts: number;
  level: LogLevel;
  message: string;
  data?: Record<string, unknown>;
  script?: string;
  line?: number;
  stack?: string[];
  count?: number;
  firstTs?: number;
  lastTs?: number;
}

interface QueryOptions {
  since?: number;
  tail?: number;
  filter?: string;
  level?: LogLevel;
  sinceTs?: number;
  exclude?: string;
  dedupe?: boolean;
}

interface QueryResult {
  entries: RuntimeLogEntry[];
  totalDropped: number;
  nextSince: number;
}

interface RuntimeLogBufferModule {
  install(): void;
  query(opts: QueryOptions): QueryResult;
}

type MessageType = { name: string };

interface LoadedBuffer {
  buffer: RuntimeLogBufferModule;
  emit: (message: string, type: MessageType, context?: Record<string, unknown>) => void;
  types: Record<'MessageOutput' | 'MessageInfo' | 'MessageWarning' | 'MessageError', MessageType>;
  clock: { nowMs: number };
}

function luaPatternToRegExp(pattern: string): RegExp {
  let anchoredStart = false;
  let body = pattern;
  if (body.startsWith('^')) {
    anchoredStart = true;
    body = body.slice(1);
  }
  let out = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '%') {
      const next = body[index + 1];
      index += 1;
      if (next === 'd') out += '\\d';
      else if (next === 's') out += '\\s';
      else if (next === 'a') out += '[A-Za-z]';
      else if (next === 'w') out += '[A-Za-z0-9]';
      else out += `\\${next}`;
      continue;
    }
    if (char === '-' && body[index - 1] === '.') {
      out += '*?';
      continue;
    }
    if (char === '-') {
      out += '\\-';
      continue;
    }
    out += char;
  }
  return new RegExp(`${anchoredStart ? '^' : ''}${out}`);
}

async function loadRuntimeLogBuffer(): Promise<LoadedBuffer> {
  const result = await esbuildBuild({
    entryPoints: [path.resolve(process.cwd(), '../../studio-plugin/src/modules/RuntimeLogBuffer.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
    external: ['@rbxts/services'],
  });

  const types = {
    MessageOutput: { name: 'MessageOutput' },
    MessageInfo: { name: 'MessageInfo' },
    MessageWarning: { name: 'MessageWarning' },
    MessageError: { name: 'MessageError' },
  };
  const clock = { nowMs: 1_700_000_000_000 };
  let listener: ((message: string, type: MessageType, context?: Record<string, unknown>) => void) | undefined;
  const services = {
    LogService: {
      GetLogHistory: () => [],
      MessageOut: {
        Connect: (callback: typeof listener) => {
          listener = callback;
          return { Disconnect: () => undefined };
        },
      },
    },
    RunService: {
      IsStudio: () => true,
      IsEdit: () => false,
      IsServer: () => false,
    },
  };

  const commonJsModule = { exports: {} as unknown };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    require: (name: string) => {
      if (name === '@rbxts/services') return services;
      throw new Error(`unexpected require ${name}`);
    },
    typeIs: (value: unknown, expected: string) => typeof value === expected,
    tostring: (value: unknown) => String(value),
    tonumber: (value: unknown) => {
      const parsed = Number(value);
      return Number.isNaN(parsed) ? undefined : parsed;
    },
    pcall: (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => {
      try {
        return [true, fn(...args)];
      } catch (error) {
        return [false, error];
      }
    },
    math: { floor: Math.floor, max: Math.max, min: Math.min },
    os: { clock: () => 0 },
    DateTime: { now: () => ({ UnixTimestampMillis: clock.nowMs }) },
    Enum: { MessageType: types },
    utf8: { len: (value: string) => [value.length] },
    string: {
      find: (value: string, pattern: string, start = 1, plain = false) => {
        if (!plain) throw new Error(`string.find pattern mode is not stubbed: ${pattern}`);
        const index = value.indexOf(pattern, Math.max(0, start - 1));
        return index < 0 ? [undefined, undefined] : [index + 1, index + pattern.length];
      },
      match: (value: string, pattern: string) => {
        const match = luaPatternToRegExp(pattern).exec(value);
        if (!match) return [undefined];
        return match.length > 1 ? match.slice(1) : [match[0]];
      },
      sub: (value: string, start: number, finish?: number) => {
        const from = start > 0 ? start - 1 : value.length + start;
        const to = finish === undefined ? value.length : (finish > 0 ? finish : value.length + finish + 1);
        return value.slice(from, to);
      },
      byte: (value: string, index: number) => [value.charCodeAt(index - 1)],
      format: (format: string, ...args: unknown[]) => format.replace(/%02X/g, () => Number(args.shift()).toString(16).toUpperCase().padStart(2, '0')),
    },
  });
  vm.runInContext(`
    String.prototype.lower = function() { return String(this).toLowerCase(); };
    String.prototype.size = function() { return this.length; };
    Array.prototype.size = function() { return this.length; };
  `, context);
  vm.runInContext(result.outputFiles[0].text, context);
  const loaded = commonJsModule.exports as RuntimeLogBufferModule & { default?: RuntimeLogBufferModule };
  const buffer = loaded.default ?? loaded;
  buffer.install();
  if (!listener) throw new Error('RuntimeLogBuffer did not connect LogService.MessageOut');
  const connected = listener;
  return {
    buffer,
    types,
    clock,
    emit: (message, type, context) => connected(message, type, context),
  };
}

const SCRIPT_PATH = 'Players.Player1.PlayerGui.Field6Gui.Field6Once';

function emitError(loaded: LoadedBuffer, message: string, scriptPath: string, line: number): void {
  loaded.emit(`${scriptPath}:${line}: ${message}`, loaded.types.MessageError);
  loaded.emit('Stack Begin', loaded.types.MessageInfo);
  loaded.emit(`Script '${scriptPath}', Line ${line}`, loaded.types.MessageInfo);
  loaded.emit('Stack End', loaded.types.MessageInfo);
}

describe('field #6 runtime log merge', () => {
  test('one runtime error becomes one entry with script, line, and stack', async () => {
    const loaded = await loadRuntimeLogBuffer();
    loaded.emit('before', loaded.types.MessageOutput);
    emitError(loaded, 'Field6 boom', SCRIPT_PATH, 5);
    loaded.emit('after', loaded.types.MessageOutput);

    const { entries } = loaded.buffer.query({});
    expect(entries.map((entry) => entry.message)).toEqual([
      'before',
      `${SCRIPT_PATH}:5: Field6 boom`,
      'after',
    ]);
    expect(entries[1]).toMatchObject({
      level: 'ERR',
      script: SCRIPT_PATH,
      line: 5,
      stack: [`Script '${SCRIPT_PATH}', Line 5`],
    });
    expect(entries[0]).not.toHaveProperty('stack');
  });

  test('multi-frame stacks keep every frame and take script/line from the first frame', async () => {
    const loaded = await loadRuntimeLogBuffer();
    loaded.emit(`${SCRIPT_PATH}:9: Field6 nested`, loaded.types.MessageError);
    loaded.emit('Stack Begin', loaded.types.MessageInfo);
    loaded.emit(`Script '${SCRIPT_PATH}', Line 9 - function inner`, loaded.types.MessageInfo);
    loaded.emit(`Script '${SCRIPT_PATH}', Line 14`, loaded.types.MessageInfo);
    loaded.emit('Stack End', loaded.types.MessageInfo);

    const { entries } = loaded.buffer.query({ level: 'ERR' });
    expect(entries).toHaveLength(1);
    expect(entries[0].script).toBe(SCRIPT_PATH);
    expect(entries[0].line).toBe(9);
    expect(entries[0].stack).toHaveLength(2);
  });

  test('an unterminated stack or a stack without an error stays as plain INFO entries', async () => {
    const loaded = await loadRuntimeLogBuffer();
    loaded.emit('Stack Begin', loaded.types.MessageInfo);
    loaded.emit(`Script '${SCRIPT_PATH}', Line 1`, loaded.types.MessageInfo);
    loaded.emit('Stack End', loaded.types.MessageInfo);
    loaded.emit('lonely error', loaded.types.MessageError);
    loaded.emit('Stack Begin', loaded.types.MessageInfo);
    loaded.emit('unrelated output', loaded.types.MessageOutput);

    const { entries } = loaded.buffer.query({});
    expect(entries).toHaveLength(6);
    expect(entries.every((entry) => entry.stack === undefined)).toBe(true);
  });

  test('level filters merged entries and the stack INFO lines are not returned separately', async () => {
    const loaded = await loadRuntimeLogBuffer();
    emitError(loaded, 'Field6 boom', SCRIPT_PATH, 5);
    loaded.emit('warned', loaded.types.MessageWarning);

    expect(loaded.buffer.query({ level: 'INFO' }).entries).toEqual([]);
    expect(loaded.buffer.query({ level: 'WARN' }).entries.map((entry) => entry.message)).toEqual(['warned']);
    expect(loaded.buffer.query({ level: 'ERR' }).entries).toHaveLength(1);
  });

  test('dedupe collapses identical level+message+script+line into count with firstTs/lastTs', async () => {
    const loaded = await loadRuntimeLogBuffer();
    for (let repeat = 0; repeat < 5; repeat += 1) {
      loaded.clock.nowMs += 100;
      emitError(loaded, 'Field6 boom', SCRIPT_PATH, 5);
    }
    loaded.clock.nowMs += 100;
    emitError(loaded, 'Field6 boom', SCRIPT_PATH, 6);
    loaded.emit('User is not authorized to access Asset', loaded.types.MessageError);
    loaded.emit('User is not authorized to access Asset', loaded.types.MessageError);

    const plain = loaded.buffer.query({ level: 'ERR' });
    expect(plain.entries).toHaveLength(8);

    const { entries } = loaded.buffer.query({ level: 'ERR', dedupe: true });
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ line: 5, count: 5 });
    expect(entries[0].firstTs).toBe(1_700_000_000.1);
    expect(entries[0].lastTs).toBe(1_700_000_000.5);
    expect(entries[1]).toMatchObject({ line: 6, count: 1 });
    expect(entries[1]).not.toHaveProperty('lastTs');
    expect(entries[2]).toMatchObject({ message: 'User is not authorized to access Asset', count: 2 });
  });

  test('sinceTs accepts Unix seconds or milliseconds and exclude drops substrings', async () => {
    const loaded = await loadRuntimeLogBuffer();
    loaded.emit('old', loaded.types.MessageOutput);
    loaded.clock.nowMs += 5_000;
    loaded.emit('new spam', loaded.types.MessageOutput);
    loaded.emit('new keep', loaded.types.MessageOutput);

    const sinceSeconds = loaded.buffer.query({ sinceTs: 1_700_000_002 });
    expect(sinceSeconds.entries.map((entry) => entry.message)).toEqual(['new spam', 'new keep']);
    const sinceMillis = loaded.buffer.query({ sinceTs: 1_700_000_002_000 });
    expect(sinceMillis.entries.map((entry) => entry.message)).toEqual(['new spam', 'new keep']);
    const excluded = loaded.buffer.query({ exclude: 'spam' });
    expect(excluded.entries.map((entry) => entry.message)).toEqual(['old', 'new keep']);
    const combined = loaded.buffer.query({ filter: 'new', exclude: 'spam', tail: 5 });
    expect(combined.entries.map((entry) => entry.message)).toEqual(['new keep']);
  });

  test('tail applies after merge and filters', async () => {
    const loaded = await loadRuntimeLogBuffer();
    loaded.emit('first', loaded.types.MessageOutput);
    emitError(loaded, 'Field6 boom', SCRIPT_PATH, 5);
    loaded.emit('last', loaded.types.MessageOutput);

    const { entries, nextSince } = loaded.buffer.query({ tail: 2 });
    expect(entries.map((entry) => entry.message)).toEqual([`${SCRIPT_PATH}:5: Field6 boom`, 'last']);
    expect(nextSince).toBe(6);
  });
});
