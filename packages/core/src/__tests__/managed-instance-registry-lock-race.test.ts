import type * as FsPromises from 'fs/promises';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ManagedInstanceRegistry } from '../managed-instance-registry.js';

type FsOperation = 'appendFile' | 'mkdir' | 'readFile' | 'writeFile';
// before: pause, then perform the call. after: perform the call, then pause before
// returning its (now possibly stale) result. eexist: no pause; report a call that
// failed with EEXIST.
type GateMode = 'before' | 'after' | 'eexist';

interface Gate {
  operation: FsOperation;
  matches: (target: string) => boolean;
  mode: GateMode;
  used: boolean;
  reached: PromiseWithResolvers<void>;
  release: PromiseWithResolvers<void>;
}

const mockGates: Gate[] = [];

function isEexist(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

// Each armed gate applies to the first matching call made after it was armed.
async function mockGatedCall<T>(operation: FsOperation, target: unknown, run: () => Promise<T>): Promise<T> {
  const gate = mockGates.find((candidate) =>
    !candidate.used && candidate.operation === operation && candidate.matches(String(target)));
  if (!gate) return run();
  if (gate.mode === 'eexist') {
    try {
      return await run();
    } catch (error) {
      if (isEexist(error)) {
        gate.used = true;
        gate.reached.resolve();
      }
      throw error;
    }
  }
  gate.used = true;
  if (gate.mode === 'before') {
    gate.reached.resolve();
    await gate.release.promise;
    return run();
  }
  const result = await run();
  gate.reached.resolve();
  await gate.release.promise;
  return result;
}

function mockGate<F extends (...args: never[]) => Promise<unknown>>(operation: FsOperation, original: F): F {
  // The wrapper forwards the original arguments and result unchanged.
  const gated = (...args: Parameters<F>) => mockGatedCall(operation, args[0], () => original(...args));
  return gated as unknown as F;
}

jest.mock('fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('fs/promises');
  return {
    ...actual,
    appendFile: mockGate('appendFile', actual.appendFile),
    mkdir: mockGate('mkdir', actual.mkdir),
    readFile: mockGate('readFile', actual.readFile),
    writeFile: mockGate('writeFile', actual.writeFile),
  };
});

function arm(operation: FsOperation, matches: (target: string) => boolean, mode: GateMode) {
  const gate: Gate = {
    operation,
    matches,
    mode,
    used: false,
    reached: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  };
  mockGates.push(gate);
  return { reached: gate.reached.promise, release: () => gate.release.resolve() };
}

const isOwnerFile = (target: string) => target.endsWith(path.join('.lock', 'owner.json'));
const isLockDir = (target: string) => target.endsWith(`${path.sep}.lock`);
const isEventLog = (target: string) => path.basename(target).startsWith('events-');

describe('ManagedInstanceRegistry lock handoff', () => {
  let registryDir: string;

  beforeEach(async () => {
    registryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'robloxstudio-mcp-lock-race-'));
  });

  afterEach(async () => {
    for (const gate of mockGates.splice(0)) gate.release.resolve();
    await fs.rm(registryDir, { recursive: true, force: true });
  });

  test('a waiter that saw a released owner leaves the next holder lock alone', async () => {
    const registry = new ManagedInstanceRegistry(registryDir);

    // The first operation holds the lock inside its critical section.
    const holding = arm('appendFile', isEventLog, 'before');
    const first = registry.logEvent({ event: 'first' });
    await holding.reached;

    // A second operation inspects the lock and reads the first owner.
    const staleOwner = arm('readFile', isOwnerFile, 'after');
    const second = registry.logEvent({ event: 'second' });
    await staleOwner.reached;

    // The first owner releases; a third operation takes the free lock and is
    // about to record itself as the owner.
    holding.release();
    await first;
    const ownerWrite = arm('writeFile', isOwnerFile, 'before');
    const third = registry.logEvent({ event: 'third' });
    await ownerWrite.reached;

    // The second operation now acts on the owner it saw. It either finishes or
    // goes back to waiting for the third operation's lock.
    const waitingAgain = arm('mkdir', isLockDir, 'eexist');
    staleOwner.release();
    await Promise.race([second.catch(() => undefined), waitingAgain.reached]);
    ownerWrite.release();

    const outcomes = await Promise.allSettled([second, third]);
    expect(outcomes.map((outcome) => outcome.status === 'rejected' ? String(outcome.reason) : outcome.status))
      .toEqual(['fulfilled', 'fulfilled']);
    const events = (await fs.readdir(registryDir)).filter((name) => isEventLog(name));
    const logged = (await Promise.all(events.map((name) => fs.readFile(path.join(registryDir, name), 'utf8'))))
      .join('')
      .trim()
      .split('\n')
      .map((line) => String(JSON.parse(line).event))
      .sort();
    expect(logged).toEqual(['first', 'second', 'third']);
  });
});
