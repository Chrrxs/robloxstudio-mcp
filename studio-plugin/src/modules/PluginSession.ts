import { HttpService, ReplicatedStorage, RunService, ServerStorage } from "@rbxts/services";
import State from "./State";
import PeerRole from "./PeerRole";
import TopologyId from "./TopologyId";

const CoreGui = game.GetService("CoreGui");

const MCP_PLACE_ID_ATTRIBUTE = "__MCPPlaceId";
const TOPOLOGY_MODE_ATTRIBUTE = "__MCPTopologyMode";
const TOPOLOGY_INSTANCE_ID_ATTRIBUTE = "__MCPTopologyInstanceId";
const TOPOLOGY_GROUP_ID_ATTRIBUTE = "__MCPTopologyGroupId";
const TOPOLOGY_TOKEN_ATTRIBUTE = "__MCPTopologyToken";
const SESSION_IDENTITY_NAME = "__MCPSessionIdentity";

const peerId = TopologyId.createPeerId();
const isEditSession = PeerRole.detect() === "edit";
const existingSessionIdentity = CoreGui.FindFirstChild(SESSION_IDENTITY_NAME);
let sessionInstanceId: string;
let createdSessionIdentity = false;
if (
	existingSessionIdentity !== undefined &&
	existingSessionIdentity.IsA("StringValue") &&
	!existingSessionIdentity.Archivable &&
	existingSessionIdentity.Value.match("^instance:[0-9a-z][0-9a-z][0-9a-z]%-[0-9a-z][0-9a-z][0-9a-z]$")[0] !== undefined
) {
	sessionInstanceId = existingSessionIdentity.Value;
} else {
	existingSessionIdentity?.Destroy();
	sessionInstanceId = TopologyId.createInstanceId();
	const sessionIdentity = new Instance("StringValue");
	sessionIdentity.Name = SESSION_IDENTITY_NAME;
	sessionIdentity.Value = sessionInstanceId;
	sessionIdentity.Archivable = false;
	sessionIdentity.Parent = CoreGui;
	createdSessionIdentity = true;
}
let inheritedInstanceId: string | undefined;

type TopologyMode = "shared" | "multiplayer";

let cachedPlaceName: string | undefined;
let cachedPlaceNamePlaceId: number | undefined;

function getMarkerMode(): TopologyMode | undefined {
	const mode = ReplicatedStorage.GetAttribute(TOPOLOGY_MODE_ATTRIBUTE);
	return mode === "shared" || mode === "multiplayer" ? mode : undefined;
}

function getInstanceId(): string {
	if (inheritedInstanceId !== undefined) return inheritedInstanceId;
	if (!isEditSession && getMarkerMode() === "shared") {
		const sharedInstanceId = ReplicatedStorage.GetAttribute(TOPOLOGY_INSTANCE_ID_ATTRIBUTE);
		if (typeIs(sharedInstanceId, "string") && sharedInstanceId !== "") {
			inheritedInstanceId = sharedInstanceId;
			return sharedInstanceId;
		}
	}
	return sessionInstanceId;
}

function getMultiplayerGroupId(): string | undefined {
	if (getMarkerMode() !== "multiplayer") return undefined;
	const groupId = ReplicatedStorage.GetAttribute(TOPOLOGY_GROUP_ID_ATTRIBUTE);
	return typeIs(groupId, "string") && groupId !== "" ? groupId : undefined;
}

function getPlaceKey(): string {
	if (game.PlaceId !== 0) {
		return `place:${tostring(game.PlaceId)}`;
	}
	const existing = ServerStorage.GetAttribute(MCP_PLACE_ID_ATTRIBUTE);
	if (typeIs(existing, "string") && existing !== "") {
		return `anon:${existing}`;
	}
	const fresh = HttpService.GenerateGUID(false);
	pcall(() => ServerStorage.SetAttribute(MCP_PLACE_ID_ATTRIBUTE, fresh));
	return `anon:${fresh}`;
}

function setTopologyMarker(mode: TopologyMode, instanceId: string | undefined, groupId: string | undefined): string {
	const token = HttpService.GenerateGUID(false);
	ReplicatedStorage.SetAttribute(TOPOLOGY_MODE_ATTRIBUTE, undefined);
	ReplicatedStorage.SetAttribute(TOPOLOGY_INSTANCE_ID_ATTRIBUTE, instanceId);
	ReplicatedStorage.SetAttribute(TOPOLOGY_GROUP_ID_ATTRIBUTE, groupId);
	ReplicatedStorage.SetAttribute(TOPOLOGY_TOKEN_ATTRIBUTE, token);
	ReplicatedStorage.SetAttribute(TOPOLOGY_MODE_ATTRIBUTE, mode);
	return token;
}

function prepareSharedTopology(): string {
	return setTopologyMarker("shared", sessionInstanceId, undefined);
}

function prepareMultiplayerTopology(groupId: string): string {
	return setTopologyMarker("multiplayer", undefined, groupId);
}

function clearTopologyMarker(token: string): void {
	if (ReplicatedStorage.GetAttribute(TOPOLOGY_TOKEN_ATTRIBUTE) !== token) return;
	if (isEditSession) {
		prepareSharedTopology();
		return;
	}
	ReplicatedStorage.SetAttribute(TOPOLOGY_MODE_ATTRIBUTE, undefined);
	ReplicatedStorage.SetAttribute(TOPOLOGY_INSTANCE_ID_ATTRIBUTE, undefined);
	ReplicatedStorage.SetAttribute(TOPOLOGY_GROUP_ID_ATTRIBUTE, undefined);
	ReplicatedStorage.SetAttribute(TOPOLOGY_TOKEN_ATTRIBUTE, undefined);
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

// CoreGui survives plugin reloads without saving or replicating this identity.
// Preserve active test markers on reload; fresh edits replace saved place markers.
if (isEditSession) {
	if (createdSessionIdentity || getMarkerMode() === undefined) prepareSharedTopology();
} else {
	getInstanceId();
}

export = {
	peerId,
	getInstanceId,
	getMultiplayerGroupId,
	getPlaceKey,
	getRole,
	getPlaceName,
	invalidatePlaceName,
	prepareSharedTopology,
	prepareMultiplayerTopology,
	clearTopologyMarker,
	createReadyPayload,
};
