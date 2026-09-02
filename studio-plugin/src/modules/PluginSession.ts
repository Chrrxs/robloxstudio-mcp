import { HttpService, ReplicatedStorage, RunService, ServerStorage } from "@rbxts/services";
import State from "./State";
import PeerRole from "./PeerRole";
import TopologyId from "./TopologyId";

const MCP_PLACE_ID_ATTRIBUTE = "__MCPPlaceId";
const TOPOLOGY_MODE_ATTRIBUTE = "__MCPTopologyMode";
const TOPOLOGY_INSTANCE_ID_ATTRIBUTE = "__MCPTopologyInstanceId";
const TOPOLOGY_GROUP_ID_ATTRIBUTE = "__MCPTopologyGroupId";
const TOPOLOGY_TOKEN_ATTRIBUTE = "__MCPTopologyToken";

const peerId = TopologyId.createPeerId();
const processInstanceId = TopologyId.currentProcessInstanceId();

type TopologyMode = "shared" | "multiplayer";

let cachedPlaceName: string | undefined;
let cachedPlaceNamePlaceId: number | undefined;

function getMarkerMode(): TopologyMode | undefined {
	const mode = ReplicatedStorage.GetAttribute(TOPOLOGY_MODE_ATTRIBUTE);
	return mode === "shared" || mode === "multiplayer" ? mode : undefined;
}

function getInstanceId(): string {
	if (getMarkerMode() === "shared") {
		const sharedInstanceId = ReplicatedStorage.GetAttribute(TOPOLOGY_INSTANCE_ID_ATTRIBUTE);
		if (typeIs(sharedInstanceId, "string") && sharedInstanceId !== "") {
			return sharedInstanceId;
		}
	}
	return processInstanceId;
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
	return setTopologyMarker("shared", processInstanceId, undefined);
}

function prepareMultiplayerTopology(groupId: string): string {
	return setTopologyMarker("multiplayer", undefined, groupId);
}

function clearTopologyMarker(token: string): void {
	if (ReplicatedStorage.GetAttribute(TOPOLOGY_TOKEN_ATTRIBUTE) !== token) return;
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
