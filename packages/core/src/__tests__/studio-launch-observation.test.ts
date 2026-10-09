import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';
import { StudioInstanceManager } from '../studio-instance-manager.js';
import type { StudioProcessAdapter, StudioProcessInfo } from '../studio-instance-manager.js';

const STUDIO: StudioProcessInfo = {
  Id: 7700,
  Name: 'RobloxStudioBeta',
  Path: 'C:\\Roblox\\RobloxStudioBeta.exe',
  MainWindowTitle: '',
  StartTimeUtcFileTime: '133700123457',
};

function parseToolText(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

// The broker refreshes owned records from a process snapshot taken before it
// walks them, so a launch registered while that snapshot was in flight is
// observed against a process table from before it existed.
describe('managed Studio launch observation', () => {
  let registryDir: string;
  let processes: StudioProcessInfo[];
  let manager: StudioInstanceManager;
  let tools: RobloxStudioTools;

  beforeEach(() => {
    registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-launch-observation-'));
    processes = [];
    const adapter: StudioProcessAdapter = {
      currentBootId: () => 'launch-observation-boot',
      resolveStudioExe: () => STUDIO.Path!,
      spawnStudio: () => {
        processes = [STUDIO];
        return {
          pid: STUDIO.Id,
          nativePid: STUDIO.Id,
          nativeStartedAt: STUDIO.StartTimeUtcFileTime,
          unref() {},
          authorize() {},
          release() {},
          abort() { processes = []; },
        };
      },
      listStudioProcesses: () => processes,
      stopProcess: () => { processes = []; },
    };
    manager = new StudioInstanceManager({ registryDir, processAdapter: adapter });
    tools = new RobloxStudioTools(new BridgeService());
    Object.defineProperty(tools, 'instanceManager', { value: manager });
  });

  afterEach(() => {
    fs.rmSync(registryDir, { recursive: true, force: true });
  });

  test.each([
    { label: 'did not list the new process yet', earlierProcesses: [] },
    {
      label: 'listed an earlier process that held the same PID',
      earlierProcesses: [{ ...STUDIO, StartTimeUtcFileTime: '133700000001' }],
    },
  ])('a snapshot taken before the launch that $label leaves the launch running and authorizable', async ({ earlierProcesses }) => {
    const launched = parseToolText(await tools.manageInstance({
      action: 'launch',
      source: 'local_file',
      local_place_file: path.join(registryDir, 'launch-observation.rbxl'),
      require_process_identity: true,
    }));
    const launchId = launched.launch_id;
    if (typeof launchId !== 'string') throw new Error('launch_id was not returned');
    const record = manager.peekByLaunchId(launchId)!;

    await manager.refresh(record, { status: 'ok', observedAt: record.launchedAt - 1, processes: earlierProcesses });

    expect(record).toMatchObject({ state: 'launching', processObservationStatus: 'running', consecutiveConfirmedMisses: 0 });
    expect(record.closedAt).toBeUndefined();
    const authorized = parseToolText(await tools.manageInstance({ action: 'authorize', launch_id: launchId }));
    expect(authorized).toMatchObject({
      launch_id: launchId,
      state: 'launching',
      pid: STUDIO.Id,
      process_started_at_file_time: STUDIO.StartTimeUtcFileTime,
      process_authorized: true,
      process_running: true,
    });
    await manager.close(record);
  });
});
