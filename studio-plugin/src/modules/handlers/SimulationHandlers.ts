// Fixed reads of Studio's network and device simulation state. They take no
// code from the caller, so a restricted MCP server can forward them.

const NETWORK_SERVICE = "NetworkSettings";
const DEVICE_SERVICE = "StudioDeviceSimulatorService";

const NETWORK_SETTINGS_READERS: Array<[string, (networkSettings: NetworkSettings) => number]> = [
	["InboundNetworkMinDelayMs", (networkSettings) => networkSettings.InboundNetworkMinDelayMs],
	["OutboundNetworkMinDelayMs", (networkSettings) => networkSettings.OutboundNetworkMinDelayMs],
	["InboundNetworkJitterMs", (networkSettings) => networkSettings.InboundNetworkJitterMs],
	["OutboundNetworkJitterMs", (networkSettings) => networkSettings.OutboundNetworkJitterMs],
	["InboundNetworkLossPercent", (networkSettings) => networkSettings.InboundNetworkLossPercent],
	["OutboundNetworkLossPercent", (networkSettings) => networkSettings.OutboundNetworkLossPercent],
];

const ACTIVE_DEVICE_GETTERS: Array<[string, (simulator: StudioDeviceSimulatorService) => unknown]> = [
	["resolution", (simulator) => simulator.GetResolutionAsync()],
	["pixelDensity", (simulator) => simulator.GetPixelDensityAsync()],
	["orientation", (simulator) => simulator.GetOrientationAsync()],
	["scalingMode", (simulator) => simulator.GetScalingModeAsync()],
];

interface DeviceList {
	devices: Array<Record<string, unknown>>;
	ids: Set<string>;
}

function failure(code: string, message: string, extra?: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { success: false, error: code, message };
	if (extra) {
		for (const [key, value] of pairs(extra)) result[key] = value;
	}
	return result;
}

// The service, or an API this read needs, does not exist in this DataModel.
function serviceUnavailable(service: string, reason: unknown): Record<string, unknown> {
	return failure("service_unavailable", `${service} is unavailable in this DataModel: ${tostring(reason)}`, { service });
}

function plain(value: unknown): unknown {
	if (typeIs(value, "Vector2")) {
		return { x: value.X, y: value.Y, width: value.X, height: value.Y };
	}
	if (typeIs(value, "EnumItem")) return value.Name;
	if (typeIs(value, "table")) {
		const out: Record<string, unknown> = {};
		for (const [key, child] of pairs(value)) out[tostring(key)] = plain(child);
		return out;
	}
	return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeIs(value, "table") ? (value as Record<string, unknown>) : undefined;
}

function deviceInfo(simulator: StudioDeviceSimulatorService, deviceId: string): Record<string, unknown> | undefined {
	const [ok, info] = pcall(() => simulator.GetDeviceInfoAsync(deviceId));
	return ok ? asRecord(plain(info)) : undefined;
}

// Built-in presets only: a custom device cannot be restored or selected by ID.
function builtInDevices(simulator: StudioDeviceSimulatorService): DeviceList {
	const devices: Array<Record<string, unknown>> = [];
	const ids = new Set<string>();
	for (const entry of simulator.GetDeviceListAsync()) {
		let item: Record<string, unknown>;
		let id: unknown;
		const entryRecord = asRecord(plain(entry));
		if (entryRecord) {
			item = entryRecord;
			id = item.DeviceId ?? item.deviceId ?? item.Id ?? item.id;
		} else {
			id = tostring(entry);
			item = { DeviceId: id };
		}
		if (id === undefined) continue;
		const deviceId = tostring(id);
		const info = deviceInfo(simulator, deviceId);
		if (info) {
			item = info;
			if (item.DeviceId === undefined) item.DeviceId = deviceId;
		}
		if (item.IsCustom !== true) {
			ids.add(deviceId);
			devices.push(item);
		}
	}
	return { devices, ids };
}

function getNetworkSimulationState(): unknown {
	const [serviceOk, service] = pcall(() => settings().GetService(NETWORK_SERVICE));
	if (!serviceOk || service === undefined) return serviceUnavailable(NETWORK_SERVICE, service);
	const networkSettings = service as NetworkSettings;
	const state: Record<string, number> = {};
	for (const [key, read] of NETWORK_SETTINGS_READERS) {
		const [ok, value] = pcall(() => read(networkSettings));
		if (!ok || !typeIs(value, "number")) return serviceUnavailable(NETWORK_SERVICE, `${key}: ${tostring(value)}`);
		state[key] = value;
	}
	return { success: true, state };
}

function getDeviceSimulatorState(data: Record<string, unknown>): unknown {
	const includeDeviceList = data.includeDeviceList;
	if (includeDeviceList !== undefined && !typeIs(includeDeviceList, "boolean")) {
		return failure("invalid_argument", "includeDeviceList must be a boolean when provided");
	}
	const deviceId = data.deviceId;
	if (deviceId !== undefined && (!typeIs(deviceId, "string") || deviceId === "")) {
		return failure("invalid_argument", "deviceId must be a non-empty string when provided");
	}

	const [serviceOk, service] = pcall(() => game.GetService(DEVICE_SERVICE));
	if (!serviceOk || service === undefined) return serviceUnavailable(DEVICE_SERVICE, service);
	const simulator = service as StudioDeviceSimulatorService;
	// The first call shows whether this DataModel serves the simulator at all.
	const [activeOk, active] = pcall(() => simulator.GetDeviceAsync());
	if (!activeOk) return serviceUnavailable(DEVICE_SERVICE, active);

	const activeDeviceId = tostring(active);
	const isSimulating = activeDeviceId !== "default";
	const state: Record<string, unknown> = { activeDeviceId, isSimulating };

	const wantsDeviceList = includeDeviceList !== false;
	if (wantsDeviceList || deviceId !== undefined) {
		const [listOk, listed] = pcall(() => builtInDevices(simulator));
		if (!listOk) {
			return failure("read_failed", `Could not list simulator devices: ${tostring(listed)}`, { service: DEVICE_SERVICE });
		}
		const list = listed as DeviceList;
		if (wantsDeviceList) state.devices = list.devices;
		if (typeIs(deviceId, "string")) {
			if (!list.ids.has(deviceId)) {
				const available: string[] = [];
				for (const id of list.ids) available.push(id);
				available.sort();
				return failure(
					"invalid_device_id",
					`deviceId "${deviceId}" is not an available built-in device. Use get_device_simulator_state to list supported device IDs. Available: ${available.join(", ")}`,
					{ deviceId, available },
				);
			}
			const [infoOk, info] = pcall(() => simulator.GetDeviceInfoAsync(deviceId));
			if (!infoOk) {
				return failure("read_failed", `Could not read device "${deviceId}": ${tostring(info)}`, { service: DEVICE_SERVICE, deviceId });
			}
			state.deviceInfo = plain(info);
		}
	}

	if (isSimulating) {
		const unavailable: Record<string, string> = {};
		let anyUnavailable = false;
		for (const [key, read] of ACTIVE_DEVICE_GETTERS) {
			const [ok, value] = pcall(() => read(simulator));
			if (ok) {
				state[key] = plain(value);
			} else {
				unavailable[key] = tostring(value);
				anyUnavailable = true;
			}
		}
		if (anyUnavailable) state.unavailable = unavailable;
	}

	return state;
}

export = {
	getNetworkSimulationState,
	getDeviceSimulatorState,
};
