import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function loadPluginModule(file: string, globals: Record<string, unknown> = {}) {
  const source = readFileSync(resolve(__dirname, '../../../../studio-plugin/src/modules', file), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(compiled.outputText, {
    module, exports: module.exports,
    game: { GetService: () => ({}) },
    pairs: Object.entries, tostring: String, typeOf: (value: unknown) => typeof value,
    typeIs: (value: unknown, kind: string) => kind === 'table' ? typeof value === 'object' : typeof value === kind,
    error: (message: string) => { throw new Error(message); },
    pcall: (callback: () => unknown) => {
      try { return [true, callback()]; } catch (error) { return [false, String(error)]; }
    },
    ...globals,
  });
  return module.exports;
}

const utils = loadPluginModule('Utils.ts') as {
  convertPropertyValue(instance: object, name: string, value: unknown): unknown;
};

test.each(['true', 'false'])('preserves string property %s while converting booleans', value => {
  expect(utils.convertPropertyValue({ Value: '' }, 'Value', value)).toBe(value);
  expect(utils.convertPropertyValue({ Text: '' }, 'Text', value)).toBe(value);
  expect(utils.convertPropertyValue({ Anchored: false }, 'Anchored', value)).toBe(value === 'true');
});

function fixture() {
  const reference = { Name: 'Reference' };
  const instance = { Name: 'Script', Parent: reference, PrimaryPart: reference, Source: 'old', IsA: () => true };
  const applyScriptSource = jest.fn().mockReturnValue({ success: true });
  const handler = loadPluginModule('handlers/PropertyHandlers.ts', {
    require: (name: string) => {
      if (name === '../Utils') return { default: {
        ...utils, applyScriptSource,
        getInstanceByPath: (path: string) => path === 'script' ? instance : path === 'reference' ? reference : undefined,
      } };
      if (name === '../Recording') return { default: { beginRecording: () => 'record', finishRecording: jest.fn() } };
      throw new Error(`Unexpected import ${name}`);
    },
  }) as { setProperties(request: object): unknown };
  return { instance, reference, applyScriptSource, set: (properties: object) => handler.setProperties({ instancePath: 'script', properties }) };
}

test.each(['Parent', 'PrimaryPart'])('%s resolves paths, clears empty paths, and rejects invalid values', property => {
  const f = fixture();
  expect(f.set({ [property]: '' })).toMatchObject({ success: true });
  expect(f.instance[property as 'Parent']).toBeUndefined();
  expect(f.set({ [property]: 'reference' })).toMatchObject({ success: true });
  expect(f.instance[property as 'Parent']).toBe(f.reference);
  for (const value of [false, 42, {}, 'missing']) {
    expect(f.set({ [property]: value })).toMatchObject({ success: false, summary: { failed: 1 } });
    expect(f.instance[property as 'Parent']).toBe(f.reference);
  }
});

test('Source uses the verified editor-aware writer and propagates failures', () => {
  const f = fixture();
  expect(f.set({ Source: 'new' })).toMatchObject({ success: true });
  expect(f.applyScriptSource).toHaveBeenCalledWith(f.instance, 'new');
  expect(f.instance.Source).toBe('old');
  f.applyScriptSource.mockReturnValue({ success: false, error: 'editor rejected write' });
  expect(f.set({ Source: 'failed' })).toMatchObject({ success: false, summary: { failed: 1 } });
  expect(f.set({ Source: 123 })).toMatchObject({ success: false });
  expect(f.applyScriptSource).toHaveBeenCalledTimes(2);
});
