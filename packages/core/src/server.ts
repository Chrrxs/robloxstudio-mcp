import { serveStdio } from '@modelcontextprotocol/server/stdio';
import http from 'http';
import { createHttpServer, listenWithRetry, TOOL_HANDLERS } from './http-server.js';
import type { HttpSecurityOptions, RobloxStudioHttpApp } from './http-server.js';
import { resolveAuthToken } from './auth.js';
import { RobloxStudioTools } from './tools/index.js';
import { BridgeService } from './bridge-service.js';
import { ProxyBridgeService } from './proxy-bridge-service.js';
import type { ToolDefinition } from './tools/definitions.js';
import { createToolServer } from './mcp-runtime.js';

export interface ServerConfig {
  name: string;
  version: string;
  tools: ToolDefinition[];
}

export class RobloxStudioMCPServer {
  private tools: RobloxStudioTools;
  private bridge: BridgeService;
  private allowedToolNames: Set<string>;
  private config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;
    this.allowedToolNames = new Set(config.tools.map(t => t.name));

    this.bridge = new BridgeService();
    this.tools = new RobloxStudioTools(this.bridge);
  }

  async run() {
    const basePort = process.env.ROBLOX_STUDIO_PORT ? parseInt(process.env.ROBLOX_STUDIO_PORT) : 58741;
    // Bind loopback-only by default. Exposing the bridge on other interfaces
    // (e.g. 0.0.0.0) is an explicit opt-in via ROBLOX_STUDIO_HOST.
    const host = process.env.ROBLOX_STUDIO_HOST?.trim() || '127.0.0.1';
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      console.error(
        `WARNING: ROBLOX_STUDIO_HOST=${host} exposes the MCP bridge beyond this machine. ` +
        'Anyone who can reach the port and knows the auth token can control Roblox Studio.',
      );
    }

    const auth = resolveAuthToken();
    const security: HttpSecurityOptions = {
      authToken: auth.token,
      authTokenHint: auth.source === 'env'
        ? 'The token comes from ROBLOX_STUDIO_AUTH_TOKEN.'
        : auth.filePath
          ? `The token is in ${auth.filePath}.`
          : undefined,
      allowedOrigins: (process.env.ROBLOX_STUDIO_ALLOWED_ORIGINS || '')
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o !== ''),
    };
    if (auth.source === 'disabled') {
      console.error('WARNING: ROBLOX_STUDIO_NO_AUTH is set - tool endpoints accept unauthenticated requests.');
    } else if (auth.filePath) {
      console.error(`Auth token loaded from ${auth.filePath} (HTTP clients must send X-MCP-Auth or Authorization: Bearer)`);
    }

    let bridgeMode: 'primary' | 'proxy' = 'primary';
    let httpHandle: http.Server | undefined;
    let primaryApp: RobloxStudioHttpApp | undefined;
    let boundPort = 0;
    let promotionInterval: ReturnType<typeof setInterval> | undefined;

    // Try to bind as primary on basePort only — secondary sessions must NOT
    // claim a different "primary" port, because the plugin only polls basePort.
    // A successful bind on basePort+1..+4 would create a fake primary whose
    // bridge queue nothing ever reads from, hanging tool calls until they time
    // out. The intended multi-session pattern is: first session = primary,
    // every subsequent session = proxy forwarding to basePort. This matches the
    // official Roblox Studio MCP (Roblox/studio-rust-mcp-server, main.rs:43).
    try {
      primaryApp = createHttpServer(this.tools, this.bridge, this.allowedToolNames, this.config, security);
      const result = await listenWithRetry(primaryApp, host, basePort, 1);
      httpHandle = result.server;
      boundPort = result.port;
      console.error(`HTTP server listening on ${host}:${boundPort} for Studio plugin (primary mode)`);
      console.error(`Streamable HTTP MCP endpoint: http://localhost:${boundPort}/mcp`);
    } catch (error) {
      if (process.env.ROBLOX_STUDIO_REQUIRE_PRIMARY === '1') {
        console.error(
          `Port ${basePort} is unavailable and ROBLOX_STUDIO_REQUIRE_PRIMARY=1; refusing proxy mode`,
        );
        throw error;
      }
      // basePort taken — another MCP subprocess owns the plugin connection.
      // Fall back to proxy mode and forward all bridge calls through it.
      bridgeMode = 'proxy';
      primaryApp = undefined;
      const proxyBridge = new ProxyBridgeService(`http://localhost:${basePort}`, auth.token);
      await proxyBridge.waitForInitialRefresh();
      this.bridge = proxyBridge;
      this.tools = new RobloxStudioTools(this.bridge);
      console.error(`Port ${basePort} in use - entering proxy mode (forwarding to localhost:${basePort})`);

      // Periodically try to promote to primary if the port frees up.
      // Single-attempt bind for the same reason as the initial bind above —
      // only basePort has a real plugin polling it, so promoting to basePort+1
      // would create another fake primary.
      //
      // Build the candidate primary infrastructure on local vars first; only
      // swap this.bridge / this.tools AFTER the bind succeeds. The previous
      // version swapped synchronously before the await, leaving a brief window
      // each interval where tool calls would land on a regular BridgeService
      // with no plugin polling it (queue with no consumer → 30s timeout).
      const promotionIntervalMs = parseInt(process.env.ROBLOX_STUDIO_PROXY_PROMOTION_INTERVAL_MS || '5000');
      promotionInterval = setInterval(async () => {
        const candidateBridge = new BridgeService();
        const candidateTools = new RobloxStudioTools(candidateBridge);
        const candidateApp = createHttpServer(candidateTools, candidateBridge, this.allowedToolNames, this.config, security);
        try {
          const result = await listenWithRetry(candidateApp, host, basePort, 1);
          // Bind succeeded — atomically swap to primary mode (synchronous from here).
          // Stop the proxy bridge's background refresh before dropping the reference
          // so its setInterval doesn't keep the object alive past the swap.
          const oldBridge = this.bridge;
          this.bridge = candidateBridge;
          this.tools = candidateTools;
          if (oldBridge instanceof ProxyBridgeService) {
            oldBridge.stop();
          }
          httpHandle = result.server;
          boundPort = result.port;
          primaryApp = candidateApp;
          bridgeMode = 'primary';
          primaryApp.setMCPServerActive(true);
          console.error(`Promoted from proxy to primary on port ${boundPort}`);
          if (promotionInterval) clearInterval(promotionInterval);
        } catch {
          // basePort still taken — discard the candidate, leave proxy bridge live.
        }
      }, promotionIntervalMs);
    }

    // Legacy port 3002 for old plugins
    const LEGACY_PORT = 3002;
    let legacyHandle: http.Server | undefined;
    let legacyApp: RobloxStudioHttpApp | undefined;
    if (boundPort !== LEGACY_PORT && bridgeMode === 'primary') {
      legacyApp = createHttpServer(this.tools, this.bridge, this.allowedToolNames, this.config, security);
      try {
        const result = await listenWithRetry(legacyApp, host, LEGACY_PORT, 1);
        legacyHandle = result.server;
        console.error(`Legacy HTTP server also listening on ${host}:${LEGACY_PORT} for old plugins`);
        legacyApp.setMCPServerActive(true);
      } catch {
        console.error(`Legacy port ${LEGACY_PORT} in use, skipping backward-compat listener`);
      }
    }

    // The v2 entry negotiates 2026-07-28 while retaining one factory-backed
    // compatibility path for 2025 clients.
    const stdioHandle = serveStdio(
      (context) => createToolServer({
        config: this.config,
        getTools: () => this.tools,
        allowedTools: this.allowedToolNames,
        era: context.era,
        invoke: async (tools, name, args) => {
          const handler = TOOL_HANDLERS[name];
          if (!handler) throw new Error(`Unknown tool: ${name}`);
          return handler(tools, args);
        },
      }),
      { onerror: (error) => console.error('[mcp:stdio]', error) },
    );
    console.error(`${this.config.name} v${this.config.version} running on stdio`);

    if (primaryApp) {
      primaryApp.setMCPServerActive(true);
    }

    console.error(bridgeMode === 'primary'
      ? 'MCP server marked as active (primary mode)'
      : 'MCP server active in proxy mode - forwarding requests to primary');

    console.error('Waiting for Studio plugin to connect...');

    const activityInterval = setInterval(() => {
      if (primaryApp) primaryApp.trackMCPActivity();
      if (legacyApp) legacyApp.trackMCPActivity();

      if (bridgeMode === 'primary' && primaryApp) {
        const pluginConnected = primaryApp.isPluginConnected();
        const mcpActive = primaryApp.isMCPServerActive();

        if (pluginConnected && mcpActive) {
          // All good
        } else if (pluginConnected && !mcpActive) {
          console.error('Studio plugin connected, but MCP server inactive');
        } else if (!pluginConnected && mcpActive) {
          console.error('MCP server active, waiting for Studio plugin...');
        } else {
          console.error('Waiting for connections...');
        }
      }
    }, 5000);

    const cleanupInterval = setInterval(() => {
      this.bridge.cleanupOldRequests();
      this.bridge.cleanupStaleInstances();
    }, 5000);

    const shutdown = async () => {
      console.error('Shutting down MCP server...');
      clearInterval(activityInterval);
      clearInterval(cleanupInterval);
      if (promotionInterval) clearInterval(promotionInterval);
      primaryApp?.setMCPServerActive(false);
      legacyApp?.setMCPServerActive(false);
      this.bridge.clearAllPendingRequests();
      if (this.bridge instanceof ProxyBridgeService) {
        this.bridge.stop();
      }
      await stdioHandle.close().catch(() => {});
      await Promise.all([
        primaryApp?.closeMcpHandler(),
        legacyApp?.closeMcpHandler(),
      ]).catch(() => {});
      if (httpHandle) httpHandle.close();
      if (legacyHandle) legacyHandle.close();
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    process.on('SIGHUP', shutdown);

    process.stdin.on('end', shutdown);
    process.stdin.on('close', shutdown);
  }
}
