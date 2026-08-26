import { HttpService, RunService, ServerStorage } from "@rbxts/services";
import State from "./State";

const MCP_PLACE_ID_ATTRIBUTE = "__MCPPlaceId";
const id = HttpService.GenerateGUID(false);

let cachedPlaceName: string | undefined;
let cachedPlaceNamePlaceId: number | undefined;

function getInstanceId(): string {
	if (game.PlaceId !== 0) {
		return `place:${tostring(game.PlaceId)}`;
	}
	const existing = ServerStorage.GetAttribute(MCP_PLACE_ID_ATTRIBUTE);
	if (typeIs(existing, "string") && existing !== "") {
		return `anon:${existing as string}`;
	}
	const fresh = HttpService.GenerateGUID(false);
	pcall(() => ServerStorage.SetAttribute(MCP_PLACE_ID_ATTRIBUTE, fresh));
	return `anon:${fresh}`;
}

function getRole(): "edit" | "server" | "client" {
	if (!RunService.IsRunning()) return "edit";
	if (RunService.IsServer()) return "server";
	return "client";
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

function createReadyPayload(pluginSessionId: string, role: string): Record<string, unknown> {
	return {
		pluginSessionId,
		physicalSessionId: id,
		instanceId: getInstanceId(),
		role,
		placeId: game.PlaceId,
		placeName: getPlaceName(),
		dataModelName: game.Name,
		isRunning: RunService.IsRunning(),
		pluginVersion: State.CURRENT_VERSION,
		pluginVariant: State.PLUGIN_VARIANT,
		timestamp: tick(),
	};
}

export = {
	id,
	getInstanceId,
	getRole,
	getPlaceName,
	invalidatePlaceName,
	createReadyPayload,
};
