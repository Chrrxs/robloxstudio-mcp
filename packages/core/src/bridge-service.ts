import { randomUUID } from 'crypto';
import type {
  StudioCancellationReason,
  StudioQueuedRequest,
  StudioRequestCancellation,
  StudioSession,
  StudioTransportQueue,
} from './studio-transport.js';

export interface PluginInstance {
  // Internal: per-plugin GUID, regenerated on every plugin load.
  // Identifies one logical registration in multiplexed SSE envelopes. MCP
  // tools route by the user-facing `instanceId` plus `role`.
  pluginSessionId: string;
  // Internal: the physical Studio peer that owns the downstream connection.
  // Logical play-client sessions point at their play-server session.
  physicalSessionId: string;
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
  lastActivity: number;
  connectedAt: number;
}

export type SettlementDisposition = 'accepted' | 'already_settled' | 'unknown';

interface PendingRequest {
  id: string;
  endpoint: string;
  data: unknown;
  targetInstanceId: string;
  targetRole: string;
  timestamp: number;
  claimOwner?: string;
  lastDeliveryPhysicalSessionId?: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
}

interface PendingCancellation extends StudioRequestCancellation {
  physicalSessionId: string;
  createdAt: number;
  claimOwner?: string;
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

// Shape exposed to MCP tool callers — strips internal transport session IDs.
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
  physicalSessionId: string;
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
    lastActivity: inst.lastActivity,
    connectedAt: inst.connectedAt,
  };
}

const STALE_INSTANCE_MS = 30000;
// Active downstream delivery protects a tuple from takeover. Once delivery
// closes, an inactive duplicate may take over after this shorter threshold so
// a Studio close/relaunch does not strand the replacement for stale cleanup.
const DUPLICATE_TAKEOVER_MS = 3000;
const INSTANCE_ALIAS_TTL_MS = 5 * 60 * 1000;
const ACCEPTED_REQUEST_TOMBSTONE_TTL_MS = 60_000;
const MAX_ACCEPTED_REQUEST_TOMBSTONES = 4096;
const CANCELLATION_TOMBSTONE_TTL_MS = 60_000;
const MAX_CANCELLATION_TOMBSTONES = 4096;

interface InstanceAlias {
  targetInstanceId: string;
  lastSeen: number;
}

function publishedInstanceId(placeId: number | undefined): string | undefined {
  if (placeId === undefined || !Number.isFinite(placeId) || placeId <= 0) return undefined;
  return `place:${Math.trunc(placeId)}`;
}

export class BridgeService implements StudioTransportQueue {
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private acceptedRequestIds: Map<string, number> = new Map();
  private pendingCancellations: Map<string, PendingCancellation> = new Map();
  // Keyed by pluginSessionId (the per-plugin GUID).
  private instances: Map<string, PluginInstance> = new Map();
  private instanceAliases: Map<string, InstanceAlias> = new Map();
  private instanceRegisteredListeners: Set<InstanceRegisteredListener> = new Set();
  private requestAvailableListeners = new Set<(physicalSessionId: string) => void>();
  private sessionClosedListeners = new Set<(session: StudioSession) => void>();
  private deliveryOwnersByPhysicalSession = new Map<string, Set<string>>();
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

  onRequestAvailable(listener: (physicalSessionId: string) => void): () => void {
    this.requestAvailableListeners.add(listener);
    return () => this.requestAvailableListeners.delete(listener);
  }

  onSessionClosed(listener: (session: StudioSession) => void): () => void {
    this.sessionClosedListeners.add(listener);
    return () => this.sessionClosedListeners.delete(listener);
  }

  setDeliveryActive(physicalSessionId: string, owner: string, active: boolean): void {
    let owners = this.deliveryOwnersByPhysicalSession.get(physicalSessionId);
    if (active) {
      if (!owners) {
        owners = new Set<string>();
        this.deliveryOwnersByPhysicalSession.set(physicalSessionId, owners);
      }
      owners.add(owner);
      return;
    }
    if (!owners) return;
    owners.delete(owner);
    if (owners.size === 0) this.deliveryOwnersByPhysicalSession.delete(physicalSessionId);
  }


  private notifyRequestAvailable(physicalSessionId: string): void {
    for (const listener of this.requestAvailableListeners) {
      try {
        listener(physicalSessionId);
      } catch {
        // Delivery observers cannot break request queue ownership.
      }
    }
  }

  private notifyRequestCancelled(request: PendingRequest, reason: StudioCancellationReason): void {
    const physicalSessionId = request.lastDeliveryPhysicalSessionId;
    if (!physicalSessionId || this.pendingCancellations.has(request.id)) return;
    const now = Date.now();
    this.prunePendingCancellations(now);
    this.pendingCancellations.set(request.id, {
      requestId: request.id,
      reason,
      physicalSessionId,
      createdAt: now,
    });
    this.prunePendingCancellations(now);
    this.notifyRequestAvailable(physicalSessionId);
  }


  private physicalSessionsForTarget(targetInstanceId: string, targetRole: string): string[] {
    const physicalSessionIds = new Set<string>();
    for (const instance of this.instances.values()) {
      if (instance.instanceId === targetInstanceId && instance.role === targetRole) {
        physicalSessionIds.add(instance.physicalSessionId);
      }
    }
    return Array.from(physicalSessionIds);
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
      const existingDeliveryActive =
        (this.deliveryOwnersByPhysicalSession.get(existing.physicalSessionId)?.size ?? 0) > 0;
      if (!existingDeliveryActive && Date.now() - existing.lastActivity > DUPLICATE_TAKEOVER_MS) {
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
      physicalSessionId: input.physicalSessionId,
      instanceId,
      role: assignedRole,
      placeId: input.placeId ?? 0,
      placeName: input.placeName ?? '',
      dataModelName: input.dataModelName ?? '',
      isRunning: input.isRunning ?? false,
      pluginVersion,
      pluginVariant,
      serverVersion,
      lastActivity: Date.now(),
      connectedAt: prior?.connectedAt ?? Date.now(),
    };
    this.instances.set(pluginSessionId, registered);

    this.notifyInstanceRegistered(toPublic(registered));
    this.notifyRequestAvailable(registered.physicalSessionId);

    return { ok: true, assignedRole, instanceId };
  }

  unregisterInstance(pluginSessionId: string) {
    const removed = this.instances.get(pluginSessionId);
    if (!removed) return;
    const logicalChildren = removed.physicalSessionId === pluginSessionId
      ? Array.from(this.instances.values()).filter(
          (instance) =>
            instance.pluginSessionId !== pluginSessionId &&
            instance.physicalSessionId === pluginSessionId,
        )
      : [];
    this.instances.delete(pluginSessionId);

    const session: StudioSession = {
      logicalSessionId: pluginSessionId,
      physicalSessionId: removed.physicalSessionId,
    };
    for (const listener of this.sessionClosedListeners) {
      try {
        listener(session);
      } catch {
        // Cleanup proceeds even if a downstream adapter fails.
      }
    }
    if (removed.physicalSessionId === pluginSessionId) {
      this.deliveryOwnersByPhysicalSession.delete(pluginSessionId);
    }
    for (const child of logicalChildren) this.unregisterInstance(child.pluginSessionId);
    // Reject any pending requests targeted at this (instanceId, role) tuple
    // if no other plugin handles it.
    for (const req of Array.from(this.pendingRequests.values())) {
      const stillHasHandler = Array.from(this.instances.values()).some(
        (i) => i.instanceId === req.targetInstanceId && i.role === req.targetRole,
      );
      if (!stillHasHandler) {
        this.removePendingRequest(req);
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
    const instance = this.instances.get(pluginSessionId);
    if (!instance) return;
    const now = Date.now();
    for (const candidate of this.instances.values()) {
      if (candidate.physicalSessionId === instance.physicalSessionId) {
        candidate.lastActivity = now;
      }
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
        this.notifyRequestAvailable(inst.physicalSessionId);
      }
    }
  }

  cleanupStaleInstances() {
    const now = Date.now();
    for (const [id, inst] of this.instances.entries()) {
      const deliveryActive =
        (this.deliveryOwnersByPhysicalSession.get(inst.physicalSessionId)?.size ?? 0) > 0;
      if (!deliveryActive && now - inst.lastActivity > STALE_INSTANCE_MS) {
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
    data: unknown,
    targetInstanceId: string,
    targetRole: string,
    timeoutMs = this.requestTimeout,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const requestId = randomUUID();
    const effectiveTimeoutMs = Math.max(1, timeoutMs);
    if (signal?.aborted) throw new Error('Request aborted');

    return new Promise((resolve, reject) => {
      const cancelPending = (reason: StudioCancellationReason, error: Error): void => {
        const pending = this.pendingRequests.get(requestId);
        if (!pending || !this.removePendingRequest(pending)) return;
        this.notifyRequestCancelled(pending, reason);
        pending.reject(error);
      };
      const timeoutId = setTimeout(
        () => cancelPending('timeout', new Error('Request timeout')),
        effectiveTimeoutMs,
      );
      const abortListener = () => cancelPending('aborted', new Error('Request aborted'));
      const request: PendingRequest = {
        id: requestId,
        endpoint,
        data,
        targetInstanceId,
        targetRole,
        timestamp: Date.now(),
        resolve,
        reject,
        timeoutId,
        timeoutMs: effectiveTimeoutMs,
        abortSignal: signal,
        abortListener,
      };

      this.pendingRequests.set(requestId, request);
      signal?.addEventListener('abort', abortListener, { once: true });
      if (signal?.aborted) abortListener();
      if (this.pendingRequests.has(requestId)) {
        for (const physicalSessionId of this.physicalSessionsForTarget(targetInstanceId, targetRole)) {
          this.notifyRequestAvailable(physicalSessionId);
        }
      }
    });
  }

  private removePendingRequest(request: PendingRequest): boolean {
    if (this.pendingRequests.get(request.id) !== request) return false;
    clearTimeout(request.timeoutId);
    if (request.abortSignal && request.abortListener) {
      request.abortSignal.removeEventListener('abort', request.abortListener);
    }
    this.pendingRequests.delete(request.id);
    return true;
  }


  claimNextRequestForPhysical(
    physicalSessionId: string,
    claimOwner: string,
  ): StudioQueuedRequest | null {
    let oldestRequest: PendingRequest | undefined;
    let logicalSessionId = '';
    for (const request of this.pendingRequests.values()) {
      if (request.claimOwner !== undefined) continue;
      let matchingSessionId: string | undefined;
      for (const candidate of this.instances.values()) {
        if (
          candidate.physicalSessionId === physicalSessionId &&
          candidate.instanceId === request.targetInstanceId &&
          candidate.role === request.targetRole
        ) {
          matchingSessionId = candidate.pluginSessionId;
          break;
        }
      }
      if (!matchingSessionId) continue;
      if (!oldestRequest || request.timestamp < oldestRequest.timestamp) {
        oldestRequest = request;
        logicalSessionId = matchingSessionId;
      }
    }
    if (!oldestRequest) return null;
    oldestRequest.claimOwner = claimOwner;
    oldestRequest.lastDeliveryPhysicalSessionId = physicalSessionId;
    return {
      requestId: oldestRequest.id,
      logicalSessionId,
      target: oldestRequest.targetRole,
      endpoint: oldestRequest.endpoint,
      data: oldestRequest.data,
      remainingMs: Math.max(1, oldestRequest.timeoutMs - (Date.now() - oldestRequest.timestamp)),
    };
  }


  claimNextCancellationForPhysical(
    physicalSessionId: string,
    claimOwner: string,
  ): StudioRequestCancellation | null {
    this.prunePendingCancellations(Date.now());
    for (const cancellation of this.pendingCancellations.values()) {
      if (cancellation.physicalSessionId !== physicalSessionId || cancellation.claimOwner !== undefined) {
        continue;
      }
      cancellation.claimOwner = claimOwner;
      return { requestId: cancellation.requestId, reason: cancellation.reason };
    }
    return null;
  }

  releaseDeliveryClaims(claimOwner: string): void {
    const physicalSessionIds = new Set<string>();
    for (const request of this.pendingRequests.values()) {
      if (request.claimOwner !== claimOwner) continue;
      request.claimOwner = undefined;
      for (const physicalSessionId of this.physicalSessionsForTarget(
        request.targetInstanceId,
        request.targetRole,
      )) {
        physicalSessionIds.add(physicalSessionId);
      }
    }
    for (const cancellation of this.pendingCancellations.values()) {
      if (cancellation.claimOwner !== claimOwner) continue;
      cancellation.claimOwner = undefined;
      physicalSessionIds.add(cancellation.physicalSessionId);
    }
    for (const physicalSessionId of physicalSessionIds) {
      this.notifyRequestAvailable(physicalSessionId);
    }
  }

  resolveRequest(requestId: string, response: unknown): SettlementDisposition {
    return this.settleRequest(requestId, (request) => request.resolve(response));
  }

  rejectRequest(requestId: string, error: unknown): SettlementDisposition {
    return this.settleRequest(requestId, (request) => request.reject(error));
  }

  private settleRequest(
    requestId: string,
    settle: (request: PendingRequest) => void,
  ): SettlementDisposition {
    const now = Date.now();
    this.pruneAcceptedRequestIds(now);

    const request = this.pendingRequests.get(requestId);
    if (!request) {
      return this.acceptedRequestIds.has(requestId) ? 'already_settled' : 'unknown';
    }

    this.removePendingRequest(request);
    this.acceptedRequestIds.set(requestId, now);
    this.pruneAcceptedRequestIds(now);
    settle(request);
    return 'accepted';
  }

  private pruneAcceptedRequestIds(now: number): void {
    for (const [requestId, acceptedAt] of this.acceptedRequestIds) {
      if (now - acceptedAt < ACCEPTED_REQUEST_TOMBSTONE_TTL_MS) break;
      this.acceptedRequestIds.delete(requestId);
    }

    while (this.acceptedRequestIds.size > MAX_ACCEPTED_REQUEST_TOMBSTONES) {
      const oldestRequestId = this.acceptedRequestIds.keys().next().value;
      if (oldestRequestId === undefined) break;
      this.acceptedRequestIds.delete(oldestRequestId);
    }
  }

  private prunePendingCancellations(now: number): void {
    for (const [requestId, cancellation] of this.pendingCancellations) {
      if (now - cancellation.createdAt < CANCELLATION_TOMBSTONE_TTL_MS) break;
      this.pendingCancellations.delete(requestId);
    }

    while (this.pendingCancellations.size > MAX_CANCELLATION_TOMBSTONES) {
      const oldestRequestId = this.pendingCancellations.keys().next().value;
      if (oldestRequestId === undefined) break;
      this.pendingCancellations.delete(oldestRequestId);
    }
  }

  cleanupOldRequests() {
    const now = Date.now();
    for (const request of this.pendingRequests.values()) {
      if (now - request.timestamp > request.timeoutMs && this.removePendingRequest(request)) {
        this.notifyRequestCancelled(request, 'timeout');
        request.reject(new Error('Request timeout'));
      }
    }
  }

  clearAllPendingRequests() {
    for (const request of Array.from(this.pendingRequests.values())) {
      this.removePendingRequest(request);
      request.reject(new Error('Connection closed'));
    }
    this.pendingCancellations.clear();
  }
}
