import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { build as esbuildBuild } from 'esbuild';

interface TransportUpdate {
  state: 'connecting' | 'open' | 'retrying' | 'waiting-duplicate';
  attempt: number;
  retryDelay: number;
  detail?: string;
}

interface Connection {
  isActive: boolean;
  lastHttpOk: boolean;
  lastMcpOk: boolean;
}

interface DiagnosticState {
  getActiveConnection(): Connection;
  applyTransportUpdate(update: TransportUpdate, now: number): void;
  clearTransportDiagnostics(): void;
  getTransportDiagnostics(now: number): { status: string; detail: string };
}

let bundledModule: Promise<string> | undefined;
async function createState(): Promise<DiagnosticState> {
  const cwd = process.cwd();
  const root = fs.existsSync(path.join(cwd, 'studio-plugin')) ? cwd : path.resolve(cwd, '../..');
  bundledModule ??= esbuildBuild({
    entryPoints: [path.join(root, 'studio-plugin/src/modules/State.ts')],
    bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent',
  }).then((result) => result.outputFiles[0].text);
  const commonJsModule = { exports: {} };
  const luaPatterns: Record<string, RegExp> = {
    '%w+://%S+': /[a-zA-Z0-9]+:\/\/\S+/g,
    '<[^>]*>': /<[^>]*>/g,
    '%s+': /\s+/g,
  };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    math: Math,
    string: {
      lower: (value: string) => value.toLowerCase(),
      find: (value: string, needle: string) => {
        const index = value.indexOf(needle);
        return index < 0 ? [undefined] : [index + 1];
      },
      sub: (value: string, start: number, end: number) => value.slice(start - 1, end),
      gsub: (value: string, pattern: string, replacement: string) => {
        if (pattern === '%c') {
          return [Array.from(value, (character) => {
            const code = character.charCodeAt(0);
            return code < 32 || code === 127 ? replacement : character;
          }).join('')];
        }
        const regex = luaPatterns[pattern];
        if (!regex) throw new Error(`Unsupported Lua pattern: ${pattern}`);
        return [value.replace(regex, replacement)];
      },
    },
  });
  vm.runInContext('String.prototype.size = function() { return this.length; };', context);
  vm.runInContext(await bundledModule, context);
  // The bundled local module is our trusted test subject, not an external payload.
  const loaded = commonJsModule.exports as DiagnosticState & { default?: DiagnosticState };
  const state = loaded.default ?? loaded;
  state.getActiveConnection().isActive = true;
  return state;
}

describe('Studio connection diagnostics', () => {
  it('retains the failed registration while showing the next attempt stage and countdown', async () => {
    const state = await createState();
    state.applyTransportUpdate({ state: 'retrying', attempt: 1, retryDelay: 2, detail: '/ready registration timed out after 20s' }, 10);
    expect(state.getTransportDiagnostics(10)).toEqual({
      status: 'Listener disconnected',
      detail: 'Retry attempt 2 in 2s\n/ready registration timed out after 20s',
    });
    expect(state.getTransportDiagnostics(11.5).detail).toContain('in 0.5s');
    expect(state.getTransportDiagnostics(13).detail).toContain('in 0s');

    state.applyTransportUpdate({ state: 'connecting', attempt: 1, retryDelay: 0, detail: 'Registering /ready (20s deadline)' }, 12);
    expect(state.getTransportDiagnostics(12)).toEqual({
      status: 'Connecting (attempt 2)',
      detail: 'Registering /ready (20s deadline)\nLast failure: /ready registration timed out after 20s',
    });
    state.applyTransportUpdate({ state: 'connecting', attempt: 1, retryDelay: 0, detail: 'Opening WebSocket (20s deadline)' }, 13);
    state.applyTransportUpdate({ state: 'connecting', attempt: 1, retryDelay: 0 }, 13);
    expect(state.getTransportDiagnostics(13).detail).toContain('Opening WebSocket (20s deadline)');
    expect(state.getTransportDiagnostics(13).detail).toContain('Last failure: /ready registration timed out');
  });

  it('clears failures on recovery and distinguishes a live listener without an MCP client', async () => {
    const state = await createState();
    state.applyTransportUpdate({ state: 'retrying', attempt: 9, retryDelay: 5, detail: 'WebSocket closed' }, 10);
    state.applyTransportUpdate({ state: 'open', attempt: 0, retryDelay: 0 }, 15);
    expect(state.getTransportDiagnostics(15)).toEqual({
      status: 'Waiting for MCP client', detail: 'Listener: connected  MCP client: not connected',
    });
    state.getActiveConnection().lastMcpOk = true;
    expect(state.getTransportDiagnostics(16).status).toBe('Connected');
    state.applyTransportUpdate({ state: 'connecting', attempt: 0, retryDelay: 0, detail: 'Registering /ready' }, 20);
    expect(state.getTransportDiagnostics(20).detail).toBe('Registering /ready');
  });

  it('retains duplicate-owner waiting across renders and clears diagnostics for manual restart', async () => {
    const state = await createState();
    state.applyTransportUpdate({ state: 'waiting-duplicate', attempt: 1, retryDelay: 1, detail: 'Previous instance still owns the listener' }, 10);
    expect(state.getTransportDiagnostics(10).status).toBe('Waiting for previous instance');
    expect(state.getTransportDiagnostics(10.5).status).toBe('Waiting for previous instance');
    state.getActiveConnection().isActive = false;
    state.clearTransportDiagnostics();
    expect(state.getTransportDiagnostics(11)).toEqual({ status: 'Disconnected', detail: '' });
    state.getActiveConnection().isActive = true;
    state.clearTransportDiagnostics();
    expect(state.getTransportDiagnostics(12).detail).not.toContain('Previous instance');
    expect(state.getTransportDiagnostics(12).status).toContain('attempt 1');
  });

  it('renders untrusted diagnostics as bounded plain text without credential-bearing URLs or tokens', async () => {
    const state = await createState();
    state.applyTransportUpdate({ state: 'retrying', attempt: 1, retryDelay: 1, detail: 'HTTP failure at https://user:private@example.test/path?key=private\n<b>Unavailable</b>\u0000' + 'x'.repeat(250) }, 0);
    const plain = state.getTransportDiagnostics(0).detail;
    expect(plain).toContain('Unavailable');
    expect(plain).not.toMatch(/private|https:|<b>/);
    expect(plain).not.toContain(String.fromCharCode(0));
    expect(plain.length).toBeLessThan(220);
    state.applyTransportUpdate({ state: 'retrying', attempt: 2, retryDelay: 2, detail: 'Authorization: Bearer do-not-display' }, 1);
    const redacted = state.getTransportDiagnostics(1).detail;
    expect(redacted).toContain('sensitive details hidden');
    expect(redacted).not.toContain('do-not-display');
  });
});
