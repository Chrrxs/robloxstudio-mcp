// Cross-DataModel stop_playtest signaling via plugin settings. Solo edit and
// runtime peers share one process instanceId through PluginSession's topology
// marker, so only the intended Studio process can consume the request.

import { HttpService, RunService } from "@rbxts/services";
import PluginSession from "./PluginSession";

const StudioTestService = game.GetService("StudioTestService");

const SETTING_KEY_PREFIX = "MCP_STOP_PLAY_";
const RESULT_KEY_SUFFIX = "_RESULT";
// Capture before registration yields. Requests from an earlier runtime must
// never stop a newly created play session, even if clearing settings was lost.
const moduleLoadedAt = tick();
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
// Plugin settings can silently lose writes when other Studio windows use the
// same plugin. Redeliver the same request, without extending its deadline/TTL.
const RETRY_INTERVAL_SEC = 1;

let pluginRef: Plugin | undefined;
let endTestIssued = false;
let transportLifecycle: StopTransportLifecycle | undefined;
let pendingRequest: { key: string; payload: StopPayload; lastPublishedAt: number } | undefined;
let lastResult: { key: string; payload: StopPayload } | undefined;

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

interface StopTransportLifecycle {
	beforeEndTest: () => void;
	afterEndTestFailure: () => void;
}

function init(p: Plugin): void {
	pluginRef = p;
}

function settingKey(): string {
	return SETTING_KEY_PREFIX + PluginSession.getInstanceId();
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
	const payload: StopPayload = {
		kind: "result",
		id: request.id,
		requestedAt: request.requestedAt,
		consumedAt: tick(),
		ok,
		error: errText,
	};
	// Cache before publishing: a lost acknowledgement must not issue EndTest a
	// second time or turn a successful duplicate into an "already issued" error.
	lastResult = { key, payload };
	writePayload(key + RESULT_KEY_SUFFIX, payload);
}

function handleStopRequest(key: string, request: StopPayload): void {
	if (request.kind !== "request" || !typeIs(request.id, "string")) return;
	if (!typeIs(request.requestedAt, "number")) {
		writeSetting(key, false);
		return;
	}

	const age = tick() - request.requestedAt;
	if (request.requestedAt < moduleLoadedAt || age < -5 || age > REQUEST_TTL_SEC) {
		writeSetting(key, false);
		return;
	}
	if (lastResult !== undefined && lastResult.key === key && lastResult.payload.id === request.id) {
		writePayload(key + RESULT_KEY_SUFFIX, lastResult.payload);
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
	const lifecycle = transportLifecycle;
	if (lifecycle !== undefined) {
		const [closeOk, closeError] = pcall(lifecycle.beforeEndTest);
		if (!closeOk) {
			warn(`[robloxstudio-mcp] Failed to close the play-server transport before EndTest: ${tostring(closeError)}`);
		}
	}
	const [endOk, endErr] = pcall(() => StudioTestService.EndTest("stopped_by_mcp"));
	writeResult(key, request, endOk, endOk ? undefined : tostring(endErr));
	if (!endOk) {
		endTestIssued = false;
		if (lifecycle !== undefined) {
			const [restoreOk, restoreError] = pcall(lifecycle.afterEndTestFailure);
			if (!restoreOk) {
				warn(`[robloxstudio-mcp] Failed to restore the play-server transport after EndTest failed: ${tostring(restoreError)}`);
			}
		}
	}
}

function startMonitor(lifecycle: StopTransportLifecycle): void {
	transportLifecycle = lifecycle;
	if (!pluginRef) {
		warn("[robloxstudio-mcp] StopPlayMonitor.startMonitor called before init; skipping");
		return;
	}
	task.spawn(() => {
		while (true) {
			const myKey = settingKey();
			const payload = decodePayload(readSetting(myKey));
			if (payload) {
				handleStopRequest(myKey, payload);
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
	const ok = writePayload(settingKey(), payload);
	pendingRequest = ok ? { key: settingKey(), payload, lastPublishedAt: tick() } : undefined;
	return { ok, requestId: ok ? requestId : undefined };
}

function waitForConsumption(requestId: string): StopConsumptionResult {
	if (!pluginRef) return { ok: false, consumed: false, error: "Plugin reference is not initialized." };
	const start = tick();
	const pending = pendingRequest;
	const key = pending !== undefined && pending.payload.id === requestId ? pending.key : settingKey();
	while (tick() - start < WAIT_FOR_CONSUMPTION_TIMEOUT_SEC) {
		// Separate slots prevent a retry from overwriting a durable acknowledgement
		// during a transient nil read after the server VM has already exited.
		const payload = decodePayload(readSetting(key + RESULT_KEY_SUFFIX));
		if (payload && payload.kind === "result" && payload.id === requestId) {
			return {
				ok: payload.ok === true,
				consumed: true,
				error: payload.error,
			};
		}
		if (pending !== undefined && pendingRequest === pending && pending.payload.id === requestId &&
			tick() - pending.lastPublishedAt >= RETRY_INTERVAL_SEC &&
			tick() - (pending.payload.requestedAt ?? 0) < REQUEST_TTL_SEC) {
			writePayload(key, pending.payload);
			pending.lastPublishedAt = tick();
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
	if (requestId === undefined || pendingRequest?.payload.id === requestId) pendingRequest = undefined;
	const myKey = settingKey();
	if (requestId !== undefined) {
		const payload = decodePayload(readSetting(myKey));
		if (payload && payload.id !== requestId) return;
	}
	writeSetting(myKey, false);
}

export = {
	init,
	startMonitor,
	requestStop,
	waitForConsumption,
	clearPending,
};
