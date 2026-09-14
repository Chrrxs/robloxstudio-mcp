// Run with: REPRO_PID=<controlled SIGTERM-ignoring fixture PID> node --import tsx tests/repro-close-live-process.mjs
// Uses the real manager/tool with a POSIX stop adapter; does not launch Roblox Studio.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BridgeService } from '../packages/core/src/bridge-service.ts';
import { StudioInstanceManager } from '../packages/core/src/studio-instance-manager.ts';
import { RobloxStudioTools } from '../packages/core/src/tools/index.ts';

const pid = Number(process.env.REPRO_PID);
assert(Number.isSafeInteger(pid) && pid > 1, 'REPRO_PID must identify the controlled fixture');
assert(readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('ISSUE86_READY'), 'Refusing to signal a non-fixture process');
const registryDir = mkdtempSync(path.join(tmpdir(), 'issue86-repro-'));
let launched = false;
let signalsSent = 0;
const isAlive = () => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const manager = new StudioInstanceManager({
  registryDir,
  closeTimeoutMs: 1000,
  processAdapter: {
    currentBootId: () => 'issue86-fixture-boot',
    resolveStudioExe: () => 'controlled-studio-fixture',
    spawnStudio: () => {
      launched = true;
      return { pid, nativePid: pid, unref() {} };
    },
    listStudioProcesses: () => launched && isAlive()
      ? [{ Id: pid, Name: 'RobloxStudio', Path: 'controlled-studio-fixture', MainWindowTitle: 'Roblox Studio' }]
      : [],
    stopProcess: (targetPid) => {
      assert.equal(targetPid, pid);
      signalsSent += 1;
      process.kill(targetPid, 'SIGTERM');
    },
  },
});
const tools = new RobloxStudioTools(new BridgeService());
Object.defineProperty(tools, 'instanceManager', { value: manager });
const call = async (request) => JSON.parse((await tools.manageInstance(request)).content[0].text);
try {
  const launch = await call({ action: 'launch', source: 'local_file', local_place_file: '/tmp/issue86-fixture.rbxl', wait_for_connection: false });
  const before = await call({ action: 'status', launch_id: launch.launch_id });
  assert.equal(before.process_running, true);
  const closed = await call({ action: 'close', launch_id: launch.launch_id }).catch((error) => error);
  const after = await call({ action: 'status', launch_id: launch.launch_id });
  const again = await call({ action: 'close', launch_id: launch.launch_id }).catch((error) => error);
  const alive = isAlive();
  console.log(JSON.stringify({ pid, signalsSent, before: { state: before.state, connected: before.connected, process_running: before.process_running }, closeError: closed.message, statusAfterClose: { state: after.state, process_running: after.process_running }, secondCloseError: again.message, actualPidAlive: alive }, null, 2));
  assert(closed instanceof Error && /still running/.test(closed.message), 'close must reject when the actual PID survives');
  assert(again instanceof Error && /still running/.test(again.message), 'a second close must retry, not report already_closed');
  assert.equal(signalsSent, 2);
  assert.equal(alive, true);
  assert.notEqual(after.state, 'exited');
  assert.equal(after.process_running, true);
} finally {
  rmSync(registryDir, { recursive: true, force: true });
}
