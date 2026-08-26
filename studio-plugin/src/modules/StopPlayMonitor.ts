// Cross-DM stop_playtest signaling via plugin:SetSetting, scoped by
// per-instance setting key so the same Studio process can host playtests
// for multiple places without one place's stop_playtest yanking another's.
// During publish-after-connect, both "anon:<uuid>" and "place:<PlaceId>"
// can refer to the same Studio place, so stop requests are mirrored across
// both keys while the monitor waits for a matching result on either key.
//
// `plugin:SetSetting` / `plugin:GetSetting` is a per-plugin persistent store
// shared across every DataModel the plugin runs in (edit DMs, play-server
// DMs, play-client DMs). For each connected place we use a dedicated key
// "MCP_STOP_PLAY_<instanceId>" as a tiny request/result mailbox:
//
//   * The edit DM's handler writes a tokenized stop request into its own key
//     (computed from its placeId / ServerStorage anon UUID).
//   * Each play-server DM's monitor loop polls the key matching its own
//     instanceId at 1Hz. On a fresh token, it calls StudioTestService:EndTest
//     and writes a matching result token. Play-server DMs for other places
//     never touch this key.
//   * The edit DM waits up to ~8s for its result token, confirming a matching
//     play-server actually consumed the request.
//
// Earlier versions used a single shared boolean flag, which let any
// play-server DM in the same Studio process consume any place's stop
// request — silently yanking teammates' playtests. The per-key scoping
// below is the fix.

import { HttpService, RunService, ServerStorage } from "@rbxts/services";

const StudioTestService = game.GetService("StudioTestService");

const SETTING_KEY_PREFIX = "MCP_STOP_PLAY_";
// Keep this conservative. plugin:GetSetting is backed by Studio's plugin
// settings store, and this monitor runs during every play session, including
// manually-started Play. The official reference implementation polls at 1s.
const POLL_INTERVAL_SEC = 1;
// Total time we wait for the matching play-server DM to consume the
// signal. Must cover: monitor detection (<= POLL_INTERVAL_SEC) +
// StudioTestService:EndTest teardown (several seconds on heavier places).
// 8s is intentionally shorter than the MCP request timeout but long enough
// for the 1s monitor cadence plus ordinary Studio teardown latency.
const WAIT_FOR_CONSUMPTION_TIMEOUT_SEC = 8.0;
const WAIT_POLL_SEC = 0.1;
const REQUEST_TTL_SEC = 12.0;

let pluginRef: Plugin | undefined;
let endTestIssued = false;

interface StopPayload {
	kind?: string;
	id?: string;
	requestedAt?: number;
	consumedAt?: number;
	ok?: boolean;
	error?: string;
}

interface StopRequestResult {
	ok: boolean;
	requestId?: string;
}

interface StopConsumptionResult {
	ok: boolean;
	consumed: boolean;
	error?: string;
}

function init(p: Plugin): void {
	pluginRef = p;
}

// Mirror of PluginSession's place identity rules. Duplicated here because
// StopPlayMonitor runs in both edit and play-server DMs, and both must
// agree on the place identifier (published places: placeId; unpublished:
// UUID on ServerStorage's __MCPPlaceId attribute, travels with the .rbxl
// into the play DM).
function addUnique(values: string[], value: string): void {
	if (!values.includes(value)) {
		values.push(value);
	}
}

function computeInstanceIds(): string[] {
	const ids: string[] = [];
	if (game.PlaceId !== 0) {
		addUnique(ids, `place:${tostring(game.PlaceId)}`);
	}
	const existing = ServerStorage.GetAttribute("__MCPPlaceId");
	if (typeIs(existing, "string") && existing !== "") {
		addUnique(ids, `anon:${existing as string}`);
	} else if (game.PlaceId === 0) {
		const fresh = HttpService.GenerateGUID(false);
		pcall(() => ServerStorage.SetAttribute("__MCPPlaceId", fresh));
		addUnique(ids, `anon:${fresh}`);
	}
	return ids;
}

function settingKey(instanceId: string): string {
	return SETTING_KEY_PREFIX + instanceId;
}

function settingKeys(): string[] {
	return computeInstanceIds().map((instanceId) => settingKey(instanceId));
}

function readSetting(key: string): unknown {
	if (!pluginRef) return undefined;
	const [ok, value] = pcall(() => pluginRef!.GetSetting(key));
	return ok ? value : undefined;
}

function writeSetting(key: string, value: unknown): boolean {
	if (!pluginRef) return false;
	const [ok] = pcall(() => pluginRef!.SetSetting(key, value));
	return ok;
}

function decodePayload(value: unknown): StopPayload | undefined {
	let decoded = value;
	if (typeIs(value, "string")) {
		const [ok, result] = pcall(() => HttpService.JSONDecode(value as string));
		if (!ok) return undefined;
		decoded = result;
	}
	if (!typeIs(decoded, "table")) return undefined;
	const payload = decoded as StopPayload;
	if (!typeIs(payload.kind, "string") || !typeIs(payload.id, "string")) {
		return undefined;
	}
	return payload;
}

function writePayload(key: string, payload: StopPayload): boolean {
	const [encodedOk, encoded] = pcall(() => HttpService.JSONEncode(payload));
	if (!encodedOk || !typeIs(encoded, "string")) return false;
	return writeSetting(key, encoded);
}

function writeResult(key: string, request: StopPayload, ok: boolean, errText?: string): void {
	writePayload(key, {
		kind: "result",
		id: request.id,
		requestedAt: request.requestedAt,
		consumedAt: tick(),
		ok,
		error: errText,
	});
}

function handleStopRequest(key: string, request: StopPayload): void {
	if (request.kind !== "request" || !typeIs(request.id, "string")) return;
	if (!typeIs(request.requestedAt, "number")) {
		writeSetting(key, false);
		return;
	}

	const age = tick() - request.requestedAt;
	if (age < -5 || age > REQUEST_TTL_SEC) {
		writeSetting(key, false);
		return;
	}

	if (endTestIssued) {
		writeResult(
			key,
			request,
			false,
			"StudioTestService:EndTest was already issued for this play session, but the runtime DataModel is still alive.",
		);
		return;
	}

	if (!RunService.IsRunning() || !RunService.IsServer()) {
		writeResult(key, request, false, "StopPlayMonitor is not running in the server DataModel.");
		return;
	}

	endTestIssued = true;
	const [endOk, endErr] = pcall(() => StudioTestService.EndTest("stopped_by_mcp"));
	writeResult(key, request, endOk, endOk ? undefined : tostring(endErr));
	if (!endOk) {
		endTestIssued = false;
	}
}

function startMonitor(): void {
	if (!pluginRef) {
		warn("[robloxstudio-mcp] StopPlayMonitor.startMonitor called before init; skipping");
		return;
	}
	task.spawn(() => {
		while (true) {
			for (const myKey of settingKeys()) {
				const payload = decodePayload(readSetting(myKey));
				if (payload) {
					handleStopRequest(myKey, payload);
				}
			}
			task.wait(POLL_INTERVAL_SEC);
		}
	});
}

function requestStop(): StopRequestResult {
	if (!pluginRef) return { ok: false };
	const requestId = HttpService.GenerateGUID(false);
	const payload: StopPayload = {
		kind: "request",
		id: requestId,
		requestedAt: tick(),
	};
	let ok = false;
	for (const myKey of settingKeys()) {
		ok = writePayload(myKey, payload) || ok;
	}
	return { ok, requestId: ok ? requestId : undefined };
}

function waitForConsumption(requestId: string): StopConsumptionResult {
	if (!pluginRef) return { ok: false, consumed: false, error: "Plugin reference is not initialized." };
	const start = tick();
	while (tick() - start < WAIT_FOR_CONSUMPTION_TIMEOUT_SEC) {
		for (const myKey of settingKeys()) {
			const payload = decodePayload(readSetting(myKey));
			if (payload && payload.kind === "result" && payload.id === requestId) {
				return {
					ok: payload.ok === true,
					consumed: true,
					error: payload.error,
				};
			}
		}
		task.wait(WAIT_POLL_SEC);
	}
	return {
		ok: false,
		consumed: false,
		error: "Timed out waiting for the play-server DataModel to acknowledge stop_playtest.",
	};
}

function clearPending(requestId?: string): void {
	if (!pluginRef) return;
	for (const myKey of settingKeys()) {
		if (requestId !== undefined) {
			const payload = decodePayload(readSetting(myKey));
			if (payload && payload.id !== requestId) continue;
		}
		writeSetting(myKey, false);
	}
}

export = {
	init,
	startMonitor,
	requestStop,
	waitForConsumption,
	clearPending,
};
