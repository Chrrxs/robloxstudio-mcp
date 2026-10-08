import { HttpService, ReplicatedStorage, RunService, ServerStorage } from "@rbxts/services";
import State from "./State";
import PeerRole from "./PeerRole";
import TopologyId from "./TopologyId";
import * as PlaytestTickets from "./PlaytestTickets";
import type { PlaytestTicket, SettingsStore } from "./PlaytestTickets";

interface StudioTestServiceWithEditMode extends StudioTestService {
	EditModeActive: boolean;
}

const CoreGui = game.GetService("CoreGui");
const StudioTestService = game.GetService("StudioTestService") as StudioTestServiceWithEditMode;

const LEGACY_PLACE_ID_ATTRIBUTE = "__MCPPlaceId";
const TOPOLOGY_MODE_ATTRIBUTE = "__MCPTopologyMode";
const TOPOLOGY_INSTANCE_ID_ATTRIBUTE = "__MCPTopologyInstanceId";
const TOPOLOGY_GROUP_ID_ATTRIBUTE = "__MCPTopologyGroupId";
const TOPOLOGY_TOKEN_ATTRIBUTE = "__MCPTopologyToken";
// Older plugin versions saved these into places. Nothing MCP-owned belongs in a
// saved or published DataModel, so edit sessions remove them on load.
const LEGACY_TOPOLOGY_ATTRIBUTES = [
	TOPOLOGY_MODE_ATTRIBUTE,
	TOPOLOGY_INSTANCE_ID_ATTRIBUTE,
	TOPOLOGY_GROUP_ID_ATTRIBUTE,
	TOPOLOGY_TOKEN_ATTRIBUTE,
];
const SESSION_IDENTITY_NAME = "__MCPSessionIdentity";
// Attributes on the CoreGui identity value: CoreGui survives plugin reloads but
// is never saved with the place or copied into playtest DataModels.
const PLAY_RECORD_ATTRIBUTE = "PlayRecord";
const RUNTIME_TOPOLOGY_ATTRIBUTE = "RuntimeTopology";
// MCP-started solo and Run playtests carry their topology in StudioTestService
// test args, which never touch the DataModel.
const TEST_ARGS_TOPOLOGY_KEY = "__mcpTopology";

const TICKET_HEARTBEAT_SEC = 1;
const UNCLAIMED_TICKET_LIFETIME_MS = 120_000;
const RESOLVE_POLL_SEC = 0.25;
// A runtime claims a ticket only after it has been the single match for this
// long, so a second window's Play starting at the same moment is noticed.
const TICKET_SETTLE_SEC = 1;
const NO_TICKET_TIMEOUT_SEC = 5;
const AMBIGUOUS_TICKET_TIMEOUT_SEC = 15;
// A prepared MCP playtest that never started (its handler died) must not stop
// later Play-button runs from posting tickets.
const ARMED_PLAY_TTL_SEC = 30;

interface SessionOptions {
	getServerUrl: () => string | undefined;
}

type TicketState = "posted" | "claimed" | "expired";
type PlayPhase = "armed" | "active";

/** The edit's current playtest, kept in CoreGui so a plugin reload can finish it. */
interface PlayRecord {
	phase: PlayPhase;
	token?: string;
	armedAt?: number;
	ticket?: PlaytestTicket;
	ticketState?: TicketState;
}

interface PreparedSoloTest {
	token: string;
	testArgs: Record<string, unknown>;
}

interface RuntimeTopology {
	instanceId?: string;
	groupId?: string;
	placeKey?: string;
	serverUrl?: string;
}

const peerId = TopologyId.createPeerId();
const isEditSession = PeerRole.detect() === "edit";
const existingSessionIdentity = CoreGui.FindFirstChild(SESSION_IDENTITY_NAME);
let sessionIdentity: StringValue;
if (
	existingSessionIdentity !== undefined &&
	existingSessionIdentity.IsA("StringValue") &&
	!existingSessionIdentity.Archivable &&
	existingSessionIdentity.Value.match("^instance:[0-9a-z][0-9a-z][0-9a-z]%-[0-9a-z][0-9a-z][0-9a-z]$")[0] !== undefined
) {
	sessionIdentity = existingSessionIdentity;
} else {
	existingSessionIdentity?.Destroy();
	sessionIdentity = new Instance("StringValue");
	sessionIdentity.Name = SESSION_IDENTITY_NAME;
	sessionIdentity.Value = TopologyId.createInstanceId();
	sessionIdentity.Archivable = false;
	sessionIdentity.Parent = CoreGui;
}
const sessionInstanceId = sessionIdentity.Value;
let settingsStore: SettingsStore | undefined;
let serverUrlProvider: (() => string | undefined) | undefined;
let legacyPlaceKey: string | undefined;
let runtimeTopology: RuntimeTopology | undefined;
let runtimeResolutionStarted = false;
let heartbeatTicketId: string | undefined;

let cachedPlaceName: string | undefined;
let cachedPlaceNamePlaceId: number | undefined;

function getInstanceId(): string {
	return runtimeTopology?.instanceId ?? sessionInstanceId;
}

function getMultiplayerGroupId(): string | undefined {
	if (!isEditSession) return runtimeTopology?.groupId;
	return readPlayRecord()?.ticket?.groupId;
}

function getPlaceKey(): string {
	const inherited = runtimeTopology?.placeKey;
	if (inherited !== undefined) return inherited;
	if (game.PlaceId !== 0) {
		return `place:${tostring(game.PlaceId)}`;
	}
	return `name:${game.Name}`;
}

function getLegacyPlaceKey(): string | undefined {
	return legacyPlaceKey;
}

function getInheritedServerUrl(): string | undefined {
	return runtimeTopology?.serverUrl;
}

function removeAttribute(target: Instance, name: string): void {
	if (target.GetAttribute(name) === undefined) return;
	pcall(() => target.SetAttribute(name, undefined));
}

function removeSavedSessionState(): void {
	const savedPlaceId = ServerStorage.GetAttribute(LEGACY_PLACE_ID_ATTRIBUTE);
	if (typeIs(savedPlaceId, "string") && savedPlaceId !== "") legacyPlaceKey = `anon:${savedPlaceId}`;
	removeAttribute(ServerStorage, LEGACY_PLACE_ID_ATTRIBUTE);
	for (const name of LEGACY_TOPOLOGY_ATTRIBUTES) removeAttribute(ReplicatedStorage, name);
}

function optionalString(value: unknown): string | undefined {
	return typeIs(value, "string") && value !== "" ? value : undefined;
}

function readPlayRecord(): PlayRecord | undefined {
	const raw = sessionIdentity.GetAttribute(PLAY_RECORD_ATTRIBUTE);
	if (!typeIs(raw, "string")) return undefined;
	const [ok, decoded] = pcall(() => HttpService.JSONDecode(raw));
	if (!ok || !typeIs(decoded, "table")) return undefined;
	const data = decoded as Record<string, unknown>;
	const phase = data.phase === "armed" || data.phase === "active" ? data.phase : undefined;
	if (phase === undefined) return undefined;
	const armedAt = data.armedAt;
	const ticketState = data.ticketState;
	return {
		phase,
		token: optionalString(data.token),
		armedAt: typeIs(armedAt, "number") ? armedAt : undefined,
		ticket: PlaytestTickets.decodeTicket(data.ticket),
		ticketState: ticketState === "posted" || ticketState === "claimed" || ticketState === "expired"
			? ticketState
			: undefined,
	};
}

function writePlayRecord(record: PlayRecord | undefined): void {
	if (record === undefined) {
		sessionIdentity.SetAttribute(PLAY_RECORD_ATTRIBUTE, undefined);
		return;
	}
	const [ok, encoded] = pcall(() => HttpService.JSONEncode(record));
	if (ok && typeIs(encoded, "string")) sessionIdentity.SetAttribute(PLAY_RECORD_ATTRIBUTE, encoded);
}

function createTicket(instanceId: string | undefined, groupId: string | undefined): PlaytestTicket {
	const now = PlaytestTickets.nowMs();
	return {
		id: HttpService.GenerateGUID(false),
		instanceId,
		groupId,
		placeId: game.PlaceId,
		placeKey: getPlaceKey(),
		dataModelName: game.Name,
		serverUrl: serverUrlProvider?.(),
		postedAt: now,
		heartbeatAt: now,
	};
}

function startTicketHeartbeat(ticketId: string): void {
	if (heartbeatTicketId === ticketId) return;
	heartbeatTicketId = ticketId;
	task.delay(TICKET_HEARTBEAT_SEC, () => refreshTicket(ticketId));
}

function refreshTicket(ticketId: string): void {
	if (heartbeatTicketId !== ticketId) return;
	const store = settingsStore;
	const record = readPlayRecord();
	const ticket = record?.ticket;
	if (
		store === undefined || record === undefined || ticket === undefined ||
		ticket.id !== ticketId || record.ticketState !== "posted"
	) {
		heartbeatTicketId = undefined;
		return;
	}
	if (PlaytestTickets.readClaim(store, ticketId) !== undefined) {
		// Keep the claim itself until Play ends: the runtime verifies it.
		PlaytestTickets.withdraw(store, ticketId);
		record.ticketState = "claimed";
		writePlayRecord(record);
		heartbeatTicketId = undefined;
		return;
	}
	if (PlaytestTickets.nowMs() - ticket.postedAt > UNCLAIMED_TICKET_LIFETIME_MS) {
		PlaytestTickets.withdraw(store, ticketId);
		record.ticketState = "expired";
		writePlayRecord(record);
		heartbeatTicketId = undefined;
		return;
	}
	PlaytestTickets.publish(store, ticket);
	task.delay(TICKET_HEARTBEAT_SEC, () => refreshTicket(ticketId));
}

function retirePlayRecord(record: PlayRecord): void {
	const store = settingsStore;
	const ticket = record.ticket;
	if (store === undefined || ticket === undefined) return;
	PlaytestTickets.withdraw(store, ticket.id);
	PlaytestTickets.clearClaim(store, ticket.id);
}

function beginPlay(): void {
	const store = settingsStore;
	if (store === undefined) return;
	const record = readPlayRecord();
	if (record !== undefined) {
		if (record.phase === "active") return;
		if (os.clock() - (record.armedAt ?? 0) <= ARMED_PLAY_TTL_SEC) {
			record.phase = "active";
			writePlayRecord(record);
			return;
		}
		retirePlayRecord(record);
	}
	const ticket = createTicket(sessionInstanceId, undefined);
	writePlayRecord({ phase: "active", ticket, ticketState: "posted" });
	PlaytestTickets.publish(store, ticket);
	startTicketHeartbeat(ticket.id);
}

function finishPlay(): void {
	const record = readPlayRecord();
	// An armed record belongs to an MCP playtest whose Play has not begun yet.
	if (record === undefined || record.phase !== "active") return;
	retirePlayRecord(record);
	writePlayRecord(undefined);
}

function armPlay(record: PlayRecord): void {
	const existing = readPlayRecord();
	if (existing !== undefined) retirePlayRecord(existing);
	writePlayRecord(record);
}

function prepareSoloTest(): PreparedSoloTest {
	const token = HttpService.GenerateGUID(false);
	armPlay({ phase: "armed", token, armedAt: os.clock() });
	return {
		token,
		testArgs: {
			[TEST_ARGS_TOPOLOGY_KEY]: {
				instanceId: sessionInstanceId,
				placeKey: getPlaceKey(),
				serverUrl: serverUrlProvider?.(),
			},
		},
	};
}

/**
 * Multiplayer test args belong to the user's game code, so the group reaches
 * the test server through a ticket instead.
 */
function prepareMultiplayerTest(groupId: string): string {
	const token = HttpService.GenerateGUID(false);
	const ticket = createTicket(undefined, groupId);
	armPlay({ phase: "armed", token, armedAt: os.clock(), ticket, ticketState: "posted" });
	const store = settingsStore;
	if (store !== undefined) {
		PlaytestTickets.publish(store, ticket);
		startTicketHeartbeat(ticket.id);
	}
	return token;
}

function finishTest(token: string): void {
	const record = readPlayRecord();
	if (record === undefined || record.token !== token) return;
	retirePlayRecord(record);
	writePlayRecord(undefined);
}

function onEditModeChanged(): void {
	if (StudioTestService.EditModeActive) finishPlay();
	else beginPlay();
}

function matchingTickets(store: SettingsStore): PlaytestTicket[] {
	const samePlace: PlaytestTicket[] = [];
	let nameMatched = false;
	for (const ticket of PlaytestTickets.liveTickets(store)) {
		if (ticket.placeId !== game.PlaceId) continue;
		const claimant = PlaytestTickets.readClaim(store, ticket.id);
		if (claimant !== undefined && claimant !== peerId) continue;
		samePlace.push(ticket);
		if (ticket.dataModelName === game.Name) nameMatched = true;
	}
	// Runtime DataModel names are expected to match their edit, but only narrow
	// on the name when it actually distinguishes a candidate.
	return nameMatched ? samePlace.filter((ticket) => ticket.dataModelName === game.Name) : samePlace;
}

/**
 * Waits for exactly one matching ticket and claims it. Returns nothing when no
 * edit posts a ticket, or when several windows of the same place started Play
 * together: the runtime then keeps its own identity rather than guessing.
 */
function claimTicket(store: SettingsStore): PlaytestTicket | undefined {
	const startedAt = os.clock();
	let candidateSeen = false;
	let settlingId: string | undefined;
	let settlingSince = 0;
	for (;;) {
		const now = os.clock();
		const candidates = matchingTickets(store);
		const first = candidates[0];
		const only = first !== undefined && candidates[1] === undefined ? first : undefined;
		if (first !== undefined) candidateSeen = true;
		if (only === undefined) {
			settlingId = undefined;
		} else if (settlingId !== only.id) {
			settlingId = only.id;
			settlingSince = now;
		} else if (now - settlingSince >= TICKET_SETTLE_SEC) {
			PlaytestTickets.writeClaim(store, only.id, peerId);
			task.wait(RESOLVE_POLL_SEC);
			if (PlaytestTickets.readClaim(store, only.id) === peerId) return only;
			settlingId = undefined;
			continue;
		}
		const timeout = candidateSeen ? AMBIGUOUS_TICKET_TIMEOUT_SEC : NO_TICKET_TIMEOUT_SEC;
		if (now - startedAt >= timeout) return undefined;
		task.wait(RESOLVE_POLL_SEC);
	}
}

function topologyFromTestArgs(): RuntimeTopology | undefined {
	const [ok, args] = pcall(() => StudioTestService.GetTestArgs());
	if (!ok || !typeIs(args, "table")) return undefined;
	const testArgs = args as Record<string, unknown>;
	const envelope = testArgs[TEST_ARGS_TOPOLOGY_KEY];
	if (!typeIs(envelope, "table")) return undefined;
	const topology = envelope as Record<string, unknown>;
	const instanceId = optionalString(topology.instanceId);
	if (instanceId === undefined) return undefined;
	return {
		instanceId,
		placeKey: optionalString(topology.placeKey),
		serverUrl: optionalString(topology.serverUrl),
	};
}

function readRememberedRuntimeTopology(): RuntimeTopology | undefined {
	const raw = sessionIdentity.GetAttribute(RUNTIME_TOPOLOGY_ATTRIBUTE);
	if (!typeIs(raw, "string")) return undefined;
	const [ok, decoded] = pcall(() => HttpService.JSONDecode(raw));
	if (!ok || !typeIs(decoded, "table")) return undefined;
	const data = decoded as Record<string, unknown>;
	return {
		instanceId: optionalString(data.instanceId),
		groupId: optionalString(data.groupId),
		placeKey: optionalString(data.placeKey),
		serverUrl: optionalString(data.serverUrl),
	};
}

function adoptRuntimeTopology(topology: RuntimeTopology): void {
	runtimeTopology = topology;
	const [ok, encoded] = pcall(() => HttpService.JSONEncode(topology));
	if (ok && typeIs(encoded, "string")) sessionIdentity.SetAttribute(RUNTIME_TOPOLOGY_ATTRIBUTE, encoded);
}

/**
 * Resolves which edit session this playtest server belongs to. Yields; call it
 * before the server peer registers with MCP.
 */
function resolveRuntimeTopology(): void {
	if (isEditSession || runtimeTopology !== undefined || runtimeResolutionStarted) return;
	if (PeerRole.detect() !== "server") return;
	runtimeResolutionStarted = true;
	const fromArgs = topologyFromTestArgs();
	if (fromArgs !== undefined) {
		adoptRuntimeTopology(fromArgs);
		return;
	}
	const store = settingsStore;
	const ticket = store !== undefined ? claimTicket(store) : undefined;
	// Record a fallback too, so a plugin reload keeps this server's own identity.
	adoptRuntimeTopology(ticket === undefined ? {} : {
		instanceId: ticket.instanceId,
		groupId: ticket.groupId,
		placeKey: ticket.placeKey,
		serverUrl: ticket.serverUrl,
	});
}

function getRole(): "edit" | "server" | "client" {
	return PeerRole.detect();
}

function invalidatePlaceName(): void {
	cachedPlaceName = undefined;
	cachedPlaceNamePlaceId = undefined;
}

function getPlaceName(): string {
	if (cachedPlaceName !== undefined && cachedPlaceNamePlaceId === game.PlaceId) return cachedPlaceName;
	invalidatePlaceName();
	cachedPlaceNamePlaceId = game.PlaceId;
	if (game.PlaceId === 0) {
		cachedPlaceName = game.Name;
		return cachedPlaceName;
	}

	const MarketplaceService = game.GetService("MarketplaceService");
	const [ok, info] = pcall(() => MarketplaceService.GetProductInfo(game.PlaceId));
	if (ok && info !== undefined) {
		// GetProductInfo's generated type is broader than the place metadata returned here.
		const placeInfo = info as { Name?: string };
		const name = placeInfo.Name;
		if (typeIs(name, "string") && name !== "") {
			cachedPlaceName = name;
			return cachedPlaceName;
		}
	}
	return game.Name;
}

function createReadyPayload(
	readyPeerId: string,
	role: string,
	instanceId = getInstanceId(),
	multiplayerGroupId = getMultiplayerGroupId(),
): Record<string, unknown> {
	return {
		peerId: readyPeerId,
		transportPeerId: peerId,
		instanceId,
		multiplayerGroupId,
		role,
		placeId: game.PlaceId,
		placeName: getPlaceName(),
		placeKey: getPlaceKey(),
		dataModelName: game.Name,
		isRunning: RunService.IsRunning(),
		pluginVersion: State.CURRENT_VERSION,
		pluginVariant: State.PLUGIN_VARIANT,
		timestamp: tick(),
	};
}

function resumePlayRecord(): void {
	const record = readPlayRecord();
	if (record === undefined) return;
	if (StudioTestService.EditModeActive) {
		// The Play ended while the plugin was reloading.
		if (record.phase === "active") finishPlay();
	} else if (record.phase === "armed") {
		beginPlay();
	}
	const current = readPlayRecord();
	const ticket = current?.ticket;
	if (current?.ticketState === "posted" && ticket !== undefined) startTicketHeartbeat(ticket.id);
}

function init(store: SettingsStore, options: SessionOptions): void {
	settingsStore = store;
	serverUrlProvider = options.getServerUrl;
	if (!isEditSession) {
		runtimeTopology = readRememberedRuntimeTopology();
		return;
	}
	removeSavedSessionState();
	StudioTestService.GetPropertyChangedSignal("EditModeActive").Connect(onEditModeChanged);
	resumePlayRecord();
}

export = {
	peerId,
	init,
	resolveRuntimeTopology,
	getInstanceId,
	getMultiplayerGroupId,
	getPlaceKey,
	getLegacyPlaceKey,
	getInheritedServerUrl,
	getRole,
	getPlaceName,
	invalidatePlaceName,
	prepareSoloTest,
	finishTest,
	prepareMultiplayerTest,
	createReadyPayload,
};
