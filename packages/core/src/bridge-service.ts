import { v4 as uuidv4 } from 'uuid';

export interface PluginInstance {
  // Internal: per-plugin GUID, regenerated on every plugin load.
  // Used as the /poll URL parameter so the server can identify which plugin
  // process is asking for work. Not user-facing — MCP tools and the LLM
  // operate on `instanceId` (the place identifier) plus `role`.
  pluginSessionId: string;
  // User-facing routing key: identifies the place file.
  // Format: "place:${PlaceId}" for published places, "anon:${uuid}" for
  // unpublished places (where the UUID lives on ServerStorage's
  // __MCPPlaceId attribute and travels with the .rbxl).
  instanceId: string;
  role: string;
  placeId: number;
  placeName: string;
  dataModelName: string;
  isRunning: boolean;
  pluginVersion: string;
  pluginVariant: string;
  serverVersion: string;
  versionMismatch: boolean;
  lastActivity: number;
  connectedAt: number;
}

interface PendingRequest {
  id: string;
  endpoint: string;
  data: any;
  targetInstanceId: string;
  targetRole: string;
  timestamp: number;
  inFlight: boolean;
  resolve: (value: any) => void;
  reject: (error: any) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  timeoutMs: number;
}

export type RoutingErrorCode =
  | 'multiple_instances_connected'
  | 'ambiguous_target'
  | 'target_role_required'
  | 'target_role_not_present_on_instance'
  | 'unrecognized_instance_id';

export interface RoutingError {
  code: RoutingErrorCode;
  message: string;
  data: { instances: PublicPluginInstance[]; count: number };
}

// Thrown by tools when resolveTarget returns an error. Caught at the MCP
// transport layer and surfaced as a structured tool-call error so the LLM
// can recover (e.g. pick an instance_id from data.instances) without an
// extra get_connected_instances round-trip.
export class RoutingFailure extends Error {
  readonly routingError: RoutingError;
  constructor(routingError: RoutingError) {
    super(routingError.message);
    this.name = 'RoutingFailure';
    this.routingError = routingError;
  }
}

// Shape exposed to MCP tool callers — strips the internal pluginSessionId.
export interface PublicPluginInstance {
  instanceId: string;
  role: string;
  placeId: number;
  placeName: string;
  dataModelName: string;
  isRunning: boolean;
  pluginVersion: string;
  pluginVariant: string;
  serverVersion: string;
  versionMismatch: boolean;
  lastActivity: number;
  connectedAt: number;
}

export type InstanceRegisteredListener = (instance: PublicPluginInstance) => void;

export interface ResolveTargetInput {
  instance_id?: string;
  target?: string;
}

export type ResolveTargetResult =
  | { ok: true; mode: 'single'; targetInstanceId: string; targetRole: string }
  | { ok: true; mode: 'fanout'; targets: { targetInstanceId: string; targetRole: string }[] }
  | { ok: false; error: RoutingError };

export interface RegisterInstanceInput {
  pluginSessionId: string;
  instanceId: string;
  role: string;
  placeId?: number;
  placeName?: string;
  dataModelName?: string;
  isRunning?: boolean;
  pluginVersion?: string;
  pluginVariant?: string;
  serverVersion?: string;
}

export type RegisterInstanceResult =
  | { ok: true; assignedRole: string; instanceId: string }
  | { ok: false; error: { code: 'duplicate_instance_role'; message: string; existing: PublicPluginInstance } };

export function toPublic(inst: PluginInstance): PublicPluginInstance {
  return {
    instanceId: inst.instanceId,
    role: inst.role,
    placeId: inst.placeId,
    placeName: inst.placeName,
    dataModelName: inst.dataModelName,
    isRunning: inst.isRunning,
    pluginVersion: inst.pluginVersion,
    pluginVariant: inst.pluginVariant,
    serverVersion: inst.serverVersion,
    versionMismatch: inst.versionMismatch,
    lastActivity: inst.lastActivity,
    connectedAt: inst.connectedAt,
  };
}

const STALE_INSTANCE_MS = 30000;
// A healthy plugin polls twice per second. If a duplicate tuple has not polled
// for this long, it is no longer routable and a new plugin load may take over.
// This is deliberately much shorter than general stale cleanup so a Studio
// close/relaunch does not strand the replacement plugin for 30-35 seconds.
const DUPLICATE_TAKEOVER_MS = 3000;
const INSTANCE_ALIAS_TTL_MS = 5 * 60 * 1000;

interface InstanceAlias {
  targetInstanceId: string;
  lastSeen: number;
}

function publishedInstanceId(placeId: number | undefined): string | undefined {
  if (placeId === undefined || !Number.isFinite(placeId) || placeId <= 0) return undefined;
  return `place:${Math.trunc(placeId)}`;
}

export class BridgeService {
  private pendingRequests: Map<string, PendingRequest> = new Map();
  // Keyed by pluginSessionId (the per-plugin GUID).
  private instances: Map<string, PluginInstance> = new Map();
  private instanceAliases: Map<string, InstanceAlias> = new Map();
  private instanceRegisteredListeners: Set<InstanceRegisteredListener> = new Set();
  private requestTimeout = 30000;

  onInstanceRegistered(listener: InstanceRegisteredListener): () => void {
    this.instanceRegisteredListeners.add(listener);
    // A proxy may already have populated its peer cache before its tools
    // subscribe. Replay the current view so lifecycle correlation cannot miss
    // a connection solely because discovery won the subscription race.
    for (const instance of this.getPublicInstances()) {
      try {
        listener(instance);
      } catch {
        // Observers must not disrupt bridge setup.
      }
    }
    return () => this.instanceRegisteredListeners.delete(listener);
  }

  protected notifyInstanceRegistered(instance: PublicPluginInstance): void {
    for (const listener of this.instanceRegisteredListeners) {
      try {
        listener(instance);
      } catch {
        // Registration is the transport boundary. A lifecycle observer must
        // not reject an otherwise valid plugin connection.
      }
    }
  }

  private canonicalInstanceId(instanceId: string, placeId?: number): string {
    return publishedInstanceId(placeId) ?? instanceId;
  }

  private rememberInstanceAlias(aliasInstanceId: string, targetInstanceId: string) {
    if (aliasInstanceId === targetInstanceId) return;
    this.instanceAliases.set(aliasInstanceId, {
      targetInstanceId,
      lastSeen: Date.now(),
    });
  }

  private resolveInstanceAlias(instanceId: string): string {
    const alias = this.instanceAliases.get(instanceId);
    if (!alias) return instanceId;
    alias.lastSeen = Date.now();
    return alias.targetInstanceId;
  }

  private migratePendingRequests(fromInstanceId: string, toInstanceId: string) {
    if (fromInstanceId === toInstanceId) return;
    for (const request of this.pendingRequests.values()) {
      if (request.targetInstanceId === fromInstanceId) {
        request.targetInstanceId = toInstanceId;
      }
    }
  }

  private cleanupStaleAliases(now = Date.now()) {
    for (const [alias, entry] of this.instanceAliases.entries()) {
      const targetIsLive = this.getInstances().some((inst) => inst.instanceId === entry.targetInstanceId);
      if (!targetIsLive && now - entry.lastSeen > INSTANCE_ALIAS_TTL_MS) {
        this.instanceAliases.delete(alias);
      }
    }
  }

  private routingKeyForInstance(inst: PluginInstance): string {
    return publishedInstanceId(inst.placeId) ?? this.resolveInstanceAlias(inst.instanceId);
  }

  private matchingInstancesForInstanceId(instanceId: string): PluginInstance[] {
    const resolvedInstanceId = this.resolveInstanceAlias(instanceId);
    const ids = new Set<string>([instanceId, resolvedInstanceId]);
    const placeIds = new Set<number>();
    const addPlaceId = (placeId: number | undefined) => {
      const published = publishedInstanceId(placeId);
      if (!published || placeId === undefined) return;
      ids.add(published);
      placeIds.add(Math.trunc(placeId));
    };

    const placeMatch = resolvedInstanceId.match(/^place:(\d+)$/) ?? instanceId.match(/^place:(\d+)$/);
    if (placeMatch) addPlaceId(Number(placeMatch[1]));

    for (const inst of this.getInstances()) {
      if (ids.has(inst.instanceId)) addPlaceId(inst.placeId);
    }

    return this.getInstances().filter(
      (inst) => ids.has(inst.instanceId) || (inst.placeId > 0 && placeIds.has(Math.trunc(inst.placeId))),
    );
  }

  resolveInstanceId(instanceId: string): string {
    return this.resolveInstanceAlias(instanceId);
  }

  registerInstance(input: RegisterInstanceInput): RegisterInstanceResult {
    const { pluginSessionId, role } = input;
    const rawInstanceId = input.instanceId;
    const instanceId = this.canonicalInstanceId(rawInstanceId, input.placeId);
    const prior = this.instances.get(pluginSessionId);
    let assignedRole = role;
    const pluginVersion = input.pluginVersion ?? '';
    const pluginVariant = input.pluginVariant ?? 'unknown';
    const serverVersion = input.serverVersion ?? '';
    const versionMismatch = pluginVersion !== '' && serverVersion !== '' && pluginVersion !== serverVersion;

    this.rememberInstanceAlias(rawInstanceId, instanceId);
    if (prior && prior.instanceId !== instanceId) {
      this.rememberInstanceAlias(prior.instanceId, instanceId);
      this.migratePendingRequests(prior.instanceId, instanceId);
    }

    // Client roles get lowest-unused-N, scoped per place. That keeps
    // target=client-1 intuitive when several Studio places are connected:
    // client-1 always means the first client for the selected instance_id.
    if (role === 'client') {
      if (prior && prior.role.match(/^client-\d+$/)) {
        assignedRole = prior.role;
      } else {
        const used = new Set<number>();
        for (const inst of this.instances.values()) {
          if (inst.instanceId !== instanceId || inst.pluginSessionId === pluginSessionId) continue;
          const match = inst.role.match(/^client-(\d+)$/);
          if (match) used.add(Number(match[1]));
        }
        let idx = 1;
        while (used.has(idx)) idx++;
        assignedRole = `client-${idx}`;
      }
    }

    // Reject duplicate (instanceId, role) tuples. This should not be
    // reachable through normal Studio + Team Create usage, but defense in
    // depth: surface it loudly rather than silently misrouting.
    const existing = Array.from(this.instances.values()).find(
      (i) => i.instanceId === instanceId && i.role === assignedRole && i.pluginSessionId !== pluginSessionId,
    );
    if (existing) {
      if (Date.now() - existing.lastActivity > DUPLICATE_TAKEOVER_MS) {
        // Reject requests owned by the unresponsive process instead of
        // redelivering a potentially mutating in-flight call to the new load.
        this.unregisterInstance(existing.pluginSessionId);
      } else {
        return {
          ok: false,
          error: {
            code: 'duplicate_instance_role',
            message: `Another plugin is already registered as (${instanceId}, ${assignedRole}).`,
            existing: toPublic(existing),
          },
        };
      }
    }

    const registered: PluginInstance = {
      pluginSessionId,
      instanceId,
      role: assignedRole,
      placeId: input.placeId ?? 0,
      placeName: input.placeName ?? '',
      dataModelName: input.dataModelName ?? '',
      isRunning: input.isRunning ?? false,
      pluginVersion,
      pluginVariant,
      serverVersion,
      versionMismatch,
      lastActivity: Date.now(),
      connectedAt: prior?.connectedAt ?? Date.now(),
    };
    this.instances.set(pluginSessionId, registered);

    this.notifyInstanceRegistered(toPublic(registered));

    return { ok: true, assignedRole, instanceId };
  }

  unregisterInstance(pluginSessionId: string) {
    const removed = this.instances.get(pluginSessionId);
    this.instances.delete(pluginSessionId);

    if (!removed) return;

    // Reject any pending requests targeted at this (instanceId, role) tuple
    // if no other plugin handles it.
    for (const [id, req] of this.pendingRequests.entries()) {
      const stillHasHandler = Array.from(this.instances.values()).some(
        (i) => i.instanceId === req.targetInstanceId && i.role === req.targetRole,
      );
      if (!stillHasHandler) {
        clearTimeout(req.timeoutId);
        this.pendingRequests.delete(id);
        req.reject(new Error(`Target (${req.targetInstanceId}, ${req.targetRole}) disconnected`));
      }
    }
  }

  unregisterInstanceId(instanceId: string): PublicPluginInstance[] {
    const matching = this.matchingInstancesForInstanceId(instanceId);
    const removed = matching.map(toPublic);
    for (const inst of matching) {
      this.unregisterInstance(inst.pluginSessionId);
    }
    return removed;
  }

  async unregisterInstanceIdEverywhere(instanceId: string): Promise<PublicPluginInstance[]> {
    return this.unregisterInstanceId(instanceId);
  }

  getInstances(): PluginInstance[] {
    return Array.from(this.instances.values());
  }

  getPublicInstances(): PublicPluginInstance[] {
    return this.getInstances().map(toPublic);
  }

  getInstanceBySessionId(pluginSessionId: string): PluginInstance | undefined {
    return this.instances.get(pluginSessionId);
  }

  getPendingRequestCount(): number {
    return this.pendingRequests.size;
  }

  updateInstanceActivity(pluginSessionId: string) {
    const inst = this.instances.get(pluginSessionId);
    if (inst) {
      inst.lastActivity = Date.now();
    }
  }

  updateInstanceMetadata(pluginSessionId: string, metadata: Partial<Pick<PluginInstance, 'placeId' | 'placeName' | 'dataModelName' | 'isRunning'>>) {
    const inst = this.instances.get(pluginSessionId);
    if (!inst) return;
    const priorInstanceId = inst.instanceId;
    if (metadata.placeId !== undefined) inst.placeId = metadata.placeId;
    if (metadata.placeName !== undefined) inst.placeName = metadata.placeName;
    if (metadata.dataModelName !== undefined) inst.dataModelName = metadata.dataModelName;
    if (metadata.isRunning !== undefined) inst.isRunning = metadata.isRunning;
    const canonicalInstanceId = this.canonicalInstanceId(inst.instanceId, inst.placeId);
    if (canonicalInstanceId !== inst.instanceId) {
      const duplicate = Array.from(this.instances.values()).find(
        (other) =>
          other.pluginSessionId !== pluginSessionId &&
          other.instanceId === canonicalInstanceId &&
          other.role === inst.role,
      );
      if (!duplicate) {
        this.rememberInstanceAlias(priorInstanceId, canonicalInstanceId);
        this.migratePendingRequests(priorInstanceId, canonicalInstanceId);
        inst.instanceId = canonicalInstanceId;
      }
    }
  }

  cleanupStaleInstances() {
    const now = Date.now();
    for (const [id, inst] of this.instances.entries()) {
      if (now - inst.lastActivity > STALE_INSTANCE_MS) {
        this.unregisterInstance(id);
      }
    }
    this.cleanupStaleAliases(now);
  }

  getEquivalentInstanceIds(instanceId: string): string[] {
    const resolvedInstanceId = this.resolveInstanceAlias(instanceId);
    const ids = new Set<string>([instanceId, resolvedInstanceId]);
    const placeIds = new Set<number>();

    const addPlaceId = (placeId: number | undefined) => {
      const published = publishedInstanceId(placeId);
      if (!published || placeId === undefined) return;
      ids.add(published);
      placeIds.add(Math.trunc(placeId));
    };

    const placeMatch = resolvedInstanceId.match(/^place:(\d+)$/) ?? instanceId.match(/^place:(\d+)$/);
    if (placeMatch) addPlaceId(Number(placeMatch[1]));

    for (const inst of this.getInstances()) {
      if (ids.has(inst.instanceId)) {
        addPlaceId(inst.placeId);
      }
    }

    for (const inst of this.getInstances()) {
      if (inst.placeId > 0 && placeIds.has(Math.trunc(inst.placeId))) {
        ids.add(inst.instanceId);
      }
    }

    for (const [alias, entry] of this.instanceAliases.entries()) {
      if (ids.has(entry.targetInstanceId)) ids.add(alias);
    }

    return Array.from(ids);
  }

  // Resolves (instance_id, target-role) MCP arguments to a concrete
  // routing decision: either a single (instanceId, role) tuple or a fanout
  // list. Returns an error result with the full instance list embedded so
  // the caller (tool layer) can surface it without a second round-trip.
  resolveTarget(input: ResolveTargetInput): ResolveTargetResult {
    const instances = this.getInstances();
    const publicList = instances.map(toPublic);
    const errorData = { instances: publicList, count: publicList.length };

    const { instance_id, target } = input;
    const isFanout = target === 'all';
    const role = target && target !== 'all' ? target : undefined;

    // Case 1: instance_id provided
    if (instance_id !== undefined) {
      const matchingInstances = this.matchingInstancesForInstanceId(instance_id);
      if (matchingInstances.length === 0) {
        return {
          ok: false,
          error: {
            code: 'unrecognized_instance_id',
            message: `instance_id "${instance_id}" is not connected. Pass one from data.instances.`,
            data: errorData,
          },
        };
      }

      if (isFanout) {
        // Fan out across all roles of that instance (e.g. edit + server + client-N).
        return {
          ok: true,
          mode: 'fanout',
          targets: matchingInstances.map((i) => ({
            targetInstanceId: i.instanceId,
            targetRole: i.role,
          })),
        };
      }

      if (role) {
        const exact = matchingInstances.find((i) => i.role === role);
        if (!exact) {
          return {
            ok: false,
            error: {
              code: 'target_role_not_present_on_instance',
              message: `instance "${instance_id}" has no role "${role}". Available roles: ${matchingInstances.map((i) => i.role).join(', ')}.`,
              data: errorData,
            },
          };
        }
        return { ok: true, mode: 'single', targetInstanceId: exact.instanceId, targetRole: role };
      }

      // role omitted, instance_id provided
      if (matchingInstances.length === 1) {
        return {
          ok: true,
          mode: 'single',
          targetInstanceId: matchingInstances[0].instanceId,
          targetRole: matchingInstances[0].role,
        };
      }
      // Multiple roles for that instance — prefer edit if present.
      const edit = matchingInstances.find((i) => i.role === 'edit');
      if (edit) {
        return { ok: true, mode: 'single', targetInstanceId: edit.instanceId, targetRole: 'edit' };
      }
      return {
        ok: false,
        error: {
          code: 'target_role_required',
          message: `instance "${instance_id}" has multiple roles connected: ${matchingInstances.map((i) => i.role).join(', ')}. Pass target=<role>.`,
          data: errorData,
        },
      };
    }

    // Case 2: instance_id omitted — distinct instanceIds across connected plugins
    const distinctInstanceIds = new Set(instances.map((i) => this.routingKeyForInstance(i)));
    if (distinctInstanceIds.size === 0) {
      // No connected instances at all. Caller will hit a separate timeout/
      // not-connected error; return a clear routing error here too.
      return {
        ok: false,
        error: {
          code: 'unrecognized_instance_id',
          message: 'No Studio plugin is connected.',
          data: errorData,
        },
      };
    }
    if (distinctInstanceIds.size > 1) {
      const errorCode: RoutingErrorCode = role ? 'ambiguous_target' : 'multiple_instances_connected';
      const msg = role
        ? `target=${role} is ambiguous because multiple Studio places are connected. Pass instance_id to choose a place.`
        : 'Multiple Studio places are connected. Pass instance_id to disambiguate.';
      return { ok: false, error: { code: errorCode, message: msg, data: errorData } };
    }

    // Exactly one distinct instance_id connected. Apply role resolution
    // identically to the instance_id-provided path.
    const onlyInstanceId = distinctInstanceIds.values().next().value;
    return this.resolveTarget({ instance_id: onlyInstanceId, target });
  }

  async sendRequest(
    endpoint: string,
    data: any,
    targetInstanceId: string,
    targetRole: string,
    timeoutMs = this.requestTimeout,
  ): Promise<any> {
    const requestId = uuidv4();
    const effectiveTimeoutMs = Math.max(1, timeoutMs);

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error('Request timeout'));
        }
      }, effectiveTimeoutMs);

      const request: PendingRequest = {
        id: requestId,
        endpoint,
        data,
        targetInstanceId,
        targetRole,
        timestamp: Date.now(),
        inFlight: false,
        resolve,
        reject,
        timeoutId,
        timeoutMs: effectiveTimeoutMs,
      };

      this.pendingRequests.set(requestId, request);
    });
  }

  getPendingRequest(
    callerInstanceId: string,
    callerRole: string,
  ): { requestId: string; request: { endpoint: string; data: any } } | null {
    let oldestRequest: PendingRequest | null = null;

    for (const request of this.pendingRequests.values()) {
      if (request.targetInstanceId !== callerInstanceId) continue;
      if (request.targetRole !== callerRole) continue;
      if (request.inFlight) continue;
      if (!oldestRequest || request.timestamp < oldestRequest.timestamp) {
        oldestRequest = request;
      }
    }

    if (oldestRequest) {
      oldestRequest.inFlight = true;
      return {
        requestId: oldestRequest.id,
        request: {
          endpoint: oldestRequest.endpoint,
          data: oldestRequest.data,
        },
      };
    }

    return null;
  }

  resolveRequest(requestId: string, response: any) {
    const request = this.pendingRequests.get(requestId);
    if (request) {
      clearTimeout(request.timeoutId);
      this.pendingRequests.delete(requestId);
      request.resolve(response);
    }
  }

  rejectRequest(requestId: string, error: any) {
    const request = this.pendingRequests.get(requestId);
    if (request) {
      clearTimeout(request.timeoutId);
      this.pendingRequests.delete(requestId);
      request.reject(error);
    }
  }

  cleanupOldRequests() {
    const now = Date.now();
    for (const [id, request] of this.pendingRequests.entries()) {
      if (now - request.timestamp > request.timeoutMs) {
        clearTimeout(request.timeoutId);
        this.pendingRequests.delete(id);
        request.reject(new Error('Request timeout'));
      }
    }
  }

  clearAllPendingRequests() {
    for (const [, request] of this.pendingRequests.entries()) {
      clearTimeout(request.timeoutId);
      request.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();
  }
}
