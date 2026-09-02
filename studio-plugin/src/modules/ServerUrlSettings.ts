import { HttpService, ServerStorage } from "@rbxts/services";

const SETTING_KEY_PREFIX = "MCP_LAST_SUCCESSFUL_SERVER_URL_";
const GLOBAL_SETTING_KEY = "MCP_LAST_SUCCESSFUL_SERVER_URL_GLOBAL_V1";

let pluginRef: Plugin | undefined;

function init(p: Plugin): void {
	pluginRef = p;
}

function normalizeServerUrl(serverUrl: string | undefined): string {
	let normalized = (serverUrl ?? "").gsub("^%s+", "")[0].gsub("%s+$", "")[0];
	if (normalized === "") return "";

	if (normalized.match("^%a[%w+.-]*://")[0] === undefined) {
		normalized = `http://${normalized}`;
	}

	while (
		normalized.size() > 0 &&
		normalized.sub(-1) === "/" &&
		normalized.match("^%a[%w+.-]*://$")[0] === undefined
	) {
		normalized = normalized.sub(1, -2);
	}

	return normalized;
}

function extractPort(serverUrl: string): number | undefined {
	const [portStr] = serverUrl.match(":(%d+)$");
	if (portStr === undefined) return undefined;
	return tonumber(portStr);
}

function addUnique(values: string[], value: string): void {
	if (!values.includes(value)) {
		values.push(value);
	}
}

function computePlaceKeys(options?: { createAnonymous?: boolean }): string[] {
	const placeKeys: string[] = [];
	if (game.PlaceId !== 0) {
		addUnique(placeKeys, `place:${tostring(game.PlaceId)}`);
	}
	const existing = ServerStorage.GetAttribute("__MCPPlaceId");
	if (typeIs(existing, "string") && existing !== "") {
		addUnique(placeKeys, `anon:${existing}`);
	} else if (game.PlaceId === 0 && options?.createAnonymous === true) {
		const fresh = HttpService.GenerateGUID(false);
		pcall(() => ServerStorage.SetAttribute("__MCPPlaceId", fresh));
		addUnique(placeKeys, `anon:${fresh}`);
	}
	return placeKeys;
}

function settingKey(placeKey: string): string {
	return SETTING_KEY_PREFIX + placeKey;
}


function readSettingString(key: string): string | undefined {
	if (!pluginRef) return undefined;
	const [ok, value] = pcall(() => pluginRef!.GetSetting(key));
	if (!ok || !typeIs(value, "string")) return undefined;

	const normalized = normalizeServerUrl(value as string);
	return normalized !== "" ? normalized : undefined;
}

function writeSettingString(key: string, serverUrl: string): void {
	if (!pluginRef) return;
	pcall(() => pluginRef!.SetSetting(key, serverUrl));
}

function rememberServerUrl(serverUrl: string): void {
	const normalized = normalizeServerUrl(serverUrl);
	if (!pluginRef || normalized === "") return;
	writeSettingString(GLOBAL_SETTING_KEY, normalized);
	for (const placeKey of computePlaceKeys({ createAnonymous: true })) {
		writeSettingString(settingKey(placeKey), normalized);
	}
}

function readServerUrl(): string | undefined {
	if (!pluginRef) return undefined;
	// Reading settings should not mint a place key. Client play DataModels have
	// their own ServerStorage; creating a key there would not match the
	// edit/server place-scoped setting.
	for (const placeKey of computePlaceKeys()) {
		const remembered = readSettingString(settingKey(placeKey));
		if (remembered !== undefined) return remembered;
	}
	const globalRemembered = readSettingString(GLOBAL_SETTING_KEY);
	if (globalRemembered !== undefined) return globalRemembered;

	return undefined;
}

export = {
	init,
	normalizeServerUrl,
	extractPort,
	rememberServerUrl,
	readServerUrl,
};
