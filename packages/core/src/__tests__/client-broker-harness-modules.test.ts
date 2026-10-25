import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The live broker regressions load ClientBroker's compiled source inside
// Studio with a stub module table. A ClientBroker import the table lacks fails
// those suites in Studio only, so check the tables against the imports here.
const REPO = resolve(__dirname, '../../../..');
const HARNESSES = ['tests/client-broker-liveness.mjs', 'tests/client-profiler-broker-deadline.mjs'];

function brokerModuleImports(): string[] {
  const source = readFileSync(resolve(REPO, 'studio-plugin/src/modules/ClientBroker.ts'), 'utf8');
  return [...source.matchAll(/^import (\w+) from "\.\/(?:handlers\/)?\w+";$/gmu)].map((match) => match[1]);
}

test('ClientBroker imports modules', () => {
  expect(brokerModuleImports()).toEqual(expect.arrayContaining(['RuntimeLogBuffer', 'SimulationHandlers', 'PeerRole']));
});

test.each(HARNESSES)('%s provides every ClientBroker module', (harness) => {
  const source = readFileSync(resolve(REPO, harness), 'utf8');
  const missing = brokerModuleImports().filter((name) =>
    !new RegExp(`'${name}'|\\b${name}\\s*=|modules\\.${name}\\b`, 'u').test(source));
  expect(missing).toEqual([]);
});
