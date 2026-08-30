import { BridgeService, toPublic } from './bridge-service.js';
import type { PluginInstance, PublicPluginInstance } from './bridge-service.js';
import { randomUUID } from 'crypto';

const PROXY_RESPONSE_GRACE_MS = 5_000;

export class ProxyBridgeService extends BridgeService {
  private primaryBaseUrl: string;
  private authToken?: string;
  readonly proxyInstanceId: string;
  private proxyRequestTimeout = 30000;
  private cachedInstances: PluginInstance[] = [];
  private readonly initialRefresh: Promise<void>;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private static REFRESH_INTERVAL_MS = 1000;

  constructor(primaryBaseUrl: string, authToken?: string) {
    super();
    this.primaryBaseUrl = primaryBaseUrl;
    this.authToken = authToken;
    this.proxyInstanceId = randomUUID();
    // Mirror the primary's peer list locally so getInstances() / resolveTarget
    // see real data. Without this, anything that enumerates peers from a
    // proxy-mode subprocess (target=all fanout, get_connected_instances)
    // sees the proxy's own empty instances Map and returns nothing.
    this.initialRefresh = this.refreshInstances();
    this.refreshTimer = setInterval(
      () => this.refreshInstances(),
      ProxyBridgeService.REFRESH_INTERVAL_MS,
    );
  }

  waitForInitialRefresh(): Promise<void> {
    return this.initialRefresh;
  }

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.authToken) headers['X-MCP-Auth'] = this.authToken;
    return headers;
  }

  private async refreshInstances(): Promise<void> {
    try {
      const res = await fetch(`${this.primaryBaseUrl}/instances`, {
        headers: this.authHeaders(),
      });
      if (!res.ok) return;
      const body = (await res.json()) as { instances?: PluginInstance[] };
      if (Array.isArray(body.instances)) {
        const previousKeys = new Set(this.cachedInstances.map((instance) =>
          `${instance.pluginSessionId}\0${instance.instanceId}\0${instance.role}\0${instance.connectedAt}`,
        ));
        this.cachedInstances = body.instances;
        for (const instance of body.instances) {
          const key = `${instance.pluginSessionId}\0${instance.instanceId}\0${instance.role}\0${instance.connectedAt}`;
          if (!previousKeys.has(key)) this.notifyInstanceRegistered(toPublic(instance));
        }
      }
    } catch {
      // Primary unreachable — keep the last-known list rather than
      // silently reporting empty.
    }
  }

  override getInstances(): PluginInstance[] {
    return this.cachedInstances;
  }

  override async unregisterInstanceIdEverywhere(instanceId: string): Promise<PublicPluginInstance[]> {
    const response = await fetch(`${this.primaryBaseUrl}/unregister-instance-id`, {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ instanceId }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Proxy unregister failed (${response.status}): ${body || response.statusText}`);
    }

    const result = await response.json() as { removed?: PublicPluginInstance[] };
    const removed = Array.isArray(result.removed) ? result.removed : [];
    const removedKeys = new Set(removed.map((inst) => `${inst.instanceId}\0${inst.role}`));
    if (removedKeys.size > 0) {
      this.cachedInstances = this.cachedInstances.filter((inst) => !removedKeys.has(`${inst.instanceId}\0${inst.role}`));
    }
    return removed;
  }

  /** Called when this proxy is being discarded (e.g. promotion to primary
      replaced it). Stops the background refresh so it doesn't leak. */
  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  override async sendRequest(
    endpoint: string,
    data: unknown,
    targetInstanceId: string,
    targetRole: string,
    timeoutMs = this.proxyRequestTimeout,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) throw new Error('Request aborted');
    const controller = new AbortController();
    const effectiveTimeoutMs = Math.max(1, timeoutMs);
    let timedOut = false;
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener('abort', abortFromCaller, { once: true });
    if (signal?.aborted) controller.abort();
    // The primary starts its request timer after this fetch begins. Leave room
    // for its terminal response to travel back before aborting the proxy hop.
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, effectiveTimeoutMs + PROXY_RESPONSE_GRACE_MS);

    try {
      const response = await fetch(`${this.primaryBaseUrl}/proxy`, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          endpoint,
          data,
          targetInstanceId,
          targetRole,
          proxyInstanceId: this.proxyInstanceId,
          timeoutMs: effectiveTimeoutMs,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Proxy request failed (${response.status}): ${body}`);
      }

      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new Error('Proxy returned an invalid response');
      }
      if ('error' in result && typeof result.error === 'string' && result.error.length > 0) {
        throw new Error(result.error);
      }
      return 'response' in result ? result.response : undefined;
    } catch (error) {
      const isAbortError = error instanceof Error
        ? error.name === 'AbortError'
        : !!error && typeof error === 'object' && 'name' in error && error.name === 'AbortError';
      if (isAbortError) {
        if (!timedOut && signal?.aborted) throw new Error('Request aborted');
        throw new Error('Proxy request timeout');
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  override cleanupOldRequests(): void {
    // No-op: primary bridge owns the pending request state
  }

  override clearAllPendingRequests(): void {
    // No-op: primary bridge owns the pending request state
  }
}
