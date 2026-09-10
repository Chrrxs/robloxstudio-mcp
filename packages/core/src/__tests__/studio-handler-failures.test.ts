import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { BridgeService } from '../bridge-service.js';
import { createToolServer } from '../mcp-runtime.js';
import { TOOL_HANDLERS } from '../http-server.js';
import { RobloxStudioTools } from '../tools/index.js';
import { TOOL_DEFINITIONS } from '../tools/definitions.js';

// Execute the actual handler with only Roblox services/globals replaced. This
// verifies its aggregate status without requiring a running Studio instance.
function propertyHandlerResult(properties: Record<string, unknown>) {
  const instance = {
    Name: 'Part',
    IsA: () => false,
    set Invalid(_value: unknown) { throw new Error('Invalid property'); },
  };
  const finishRecording = jest.fn();
  const source = readFileSync(resolve(__dirname, '../../../../studio-plugin/src/modules/handlers/PropertyHandlers.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  runInNewContext(compiled.outputText, {
    module,
    exports: module.exports,
    require: (name: string) => {
      if (name === '../Utils') return { default: {
        getInstanceByPath: () => instance,
        convertPropertyValue: (_instance: unknown, _property: string, value: unknown) => value,
      } };
      if (name === '../Recording') return { default: {
        beginRecording: () => 'recording', finishRecording,
      } };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    pairs: Object.entries,
    typeIs: (value: unknown, kind: string) => kind === 'table' ? typeof value === 'object' : typeof value === kind,
    tostring: String,
    pcall: (callback: () => void) => {
      try { callback(); return [true]; } catch (error) { return [false, String(error)]; }
    },
  });
  const handler = module.exports;
  if (!('setProperties' in handler) || typeof handler.setProperties !== 'function') {
    throw new Error('Property handler did not export setProperties');
  }
  const result: unknown = handler.setProperties({ instancePath: 'game.Workspace.Part', properties });
  expect(finishRecording).toHaveBeenCalledWith('recording', true);
  return result;
}

describe.each(['modern', 'legacy'] as const)('Studio handler failures over %s MCP', (era) => {
  test.each([
    { properties: { Name: 'Renamed' }, failed: 0, succeeded: 1 },
    { properties: { Invalid: true }, failed: 1, succeeded: 0 },
    { properties: { Name: 'Renamed', Invalid: true }, failed: 1, succeeded: 1 },
  ])('preserves property write outcomes: %j', async ({ properties, failed, succeeded }) => {
    const payload = propertyHandlerResult(properties);
    expect(payload).toMatchObject({
      success: failed === 0,
      summary: { total: failed + succeeded, failed, succeeded },
    });
    const bridge = new BridgeService();
    bridge.registerPeer({ peerId: 'edit', transportPeerId: 'edit', instanceId: 'instance:test', role: 'edit' });
    const sendRequest = jest.spyOn(bridge, 'sendRequest').mockResolvedValue(payload);
    const tools = new RobloxStudioTools(bridge);
    const definition = TOOL_DEFINITIONS.find(tool => tool.name === 'set_properties')!;
    const server = createToolServer({
      config: { name: 'handler-test', version: '1.0.0', tools: [definition] },
      getTools: () => tools,
      era,
      invoke: (target, name, args, context) => TOOL_HANDLERS[name](target, args, context),
    });
    const client = new Client({ name: 'handler-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: 'set_properties', arguments: { instancePath: 'game.Workspace.Part', properties },
      });
      expect(sendRequest).toHaveBeenCalled();
      expect(result.isError === true).toBe(failed > 0);
      expect(result.structuredContent).toEqual(payload);
      if (era === 'legacy') {
        expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(payload) }]);
      }
    } finally {
      await client.close();
      await server.close();
      sendRequest.mockRestore();
    }
  });
});
