import * as fs from 'fs';
import * as path from 'path';
import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';

const RUNTIME_LOG_TEST_CLAIM_OWNER = 'runtime-log-context-test';

function repositoryRoot(): string {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, 'studio-plugin')) ? cwd : path.resolve(cwd, '../..');
}

async function nextPendingRequest(bridge: BridgeService) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const queued = bridge.claimNextRequestForPhysical(
      'edit-session',
      RUNTIME_LOG_TEST_CLAIM_OWNER,
    );
    if (queued) {
      return {
        requestId: queued.requestId,
        request: {
          endpoint: queued.endpoint,
          data: queued.data as Record<string, unknown>,
        },
      };
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('timed out waiting for the plugin request');
}

describe('runtime log structured context', () => {
  test('the Studio MessageOut callback stores structured context as optional entry data', () => {
    const source = fs.readFileSync(
      path.join(repositoryRoot(), 'studio-plugin/src/modules/RuntimeLogBuffer.ts'),
      'utf8',
    );

    expect(source).toContain('data?: Record<string, unknown>;');
    expect(source).toMatch(/MessageOut\.Connect\(\(msg, t, context\??:/);
    expect(source).toContain('pushEntry(msg, t, undefined, context);');
    expect(source).toMatch(/entries\.push\(\{[\s\S]*message: safeMessage,\s+data,[\s\S]*\}\);/);
  });

  test('the MCP response preserves optional structured entry data', async () => {
    const bridge = new BridgeService();
    bridge.registerInstance({
      pluginSessionId: 'edit-session',
      physicalSessionId: 'edit-session',
      instanceId: 'place:test',
      role: 'edit',
    });
    const tools = new RobloxStudioTools(bridge);

    const resultPromise = tools.getRuntimeLogs('edit', undefined, 10, undefined, 'place:test');
    resultPromise.catch(() => {});

    const stateRequest = await nextPendingRequest(bridge);
    expect(stateRequest?.request.endpoint).toBe('/api/multiplayer-test-state');
    bridge.resolveRequest(stateRequest.requestId, { session: { phase: 'idle' } });

    const logsRequest = await nextPendingRequest(bridge);
    expect(logsRequest?.request.endpoint).toBe('/api/get-runtime-logs');
    bridge.resolveRequest(logsRequest.requestId, {
      capturedBy: 'edit',
      entries: [{
        seq: 1,
        ts: 1_721_000_000,
        level: 'INFO',
        message: '[Init] required MenuController',
        data: {
          durationMilliseconds: 0.0037,
          moduleName: 'MenuController',
          rank: 13,
        },
      }],
      totalDropped: 0,
      nextSince: 1,
    });

    const result = await resultPromise;
    const first = result.content[0];
    if (first.type !== 'text') throw new Error('expected a text response');
    const response = JSON.parse(first.text);
    expect(response.entries[0].data).toEqual({
      durationMilliseconds: 0.0037,
      moduleName: 'MenuController',
      rank: 13,
    });
  });
});
