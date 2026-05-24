import { HttpService, Players, ReplicatedStorage, RunService } from "@rbxts/services";
import RuntimeLogBuffer from "./RuntimeLogBuffer";
import MemoryHandlers from "./handlers/MemoryHandlers";

// The client peer cannot reach the MCP HTTP server - Roblox forbids
// HttpService:RequestAsync from the client DM even under PluginSecurity, and
// HttpEnabled reads as false there regardless of identity. So the server peer
// brokers execute_luau requests to the client via a RemoteFunction it places
// in ReplicatedStorage; each player gets a proxy "client" registration on the
// MCP side, polled and dispatched by the server peer.
//
// The same server peer also registers an "edit" proxy that intercepts
// /api/stop-playtest specifically - StudioTestService:EndTest only works from
// the play server DM, so the real edit DM cannot satisfy stop requests on its
// own. MCP returns the same pending request to multiple pollers until someone
// /responds, so non-stop edit-targeted requests fall through to the actual
// edit DM untouched.

const MCP_URL = "http://localhost:58741";
const BROKER_NAME = "__MCPClientBroker";

interface ProxyEntry {
	instanceId: string;
	role: string;
}

interface BrokerEnvelope {
	endpoint?: string;
	data?: Record<string, unknown>;
	// Backward-compat: older server-broker code (pre-v2.10) sent the raw
	// {code} payload directly. If we see code at the top level and no
	// endpoint, treat it as execute-luau.
	code?: string;
}

interface ExecuteResult {
	success: boolean;
	returnValue?: string;
	message?: string;
	error?: string;
}

// Endpoints the server-peer broker is allowed to forward to the client peer.
// Each requires the client peer's plugin VM (because the buffer / require
// cache / etc. lives there) so the server peer alone can't satisfy them.
const CLIENT_BROKER_ALLOWED_ENDPOINTS = new Set<string>([
	"/api/execute-luau",
	"/api/get-runtime-logs",
	"/api/get-memory-breakdown",
]);

interface ReadyResponseBody {
	assignedRole?: string;
}

interface PollResponseBody {
	requestId?: string;
	request?: {
		endpoint: string;
		data?: Record<string, unknown>;
	};
	// Server signals knownInstance=false when our proxy isn't in its
	// in-memory instances map (typically after an MCP process restart).
	// Triggers a re-register POST to /ready.
	knownInstance?: boolean;
}

// Throttle re-ready calls per proxyId so a brief window of unknownInstance
// polls doesn't cause a re-register stampede.
const lastReadyByProxy = new Map<string, number>();

function reRegisterProxy(proxyId: string, role: string): void {
	const now = tick();
	const last = lastReadyByProxy.get(proxyId) ?? 0;
	if (now - last < 2) return;
	lastReadyByProxy.set(proxyId, now);
	pcall(() => postJson("/ready", { instanceId: proxyId, role }));
}

function forkRole(): "edit" | "server" | "client" {
	if (!RunService.IsRunning()) return "edit";
	if (RunService.IsServer()) return "server";
	return "client";
}

function postJson(endpoint: string, body: Record<string, unknown>) {
	return pcall(() =>
		HttpService.RequestAsync({
			Url: `${MCP_URL}${endpoint}`,
			Method: "POST",
			Headers: { "Content-Type": "application/json" },
			Body: HttpService.JSONEncode(body),
		}),
	);
}

function handleExecuteLuau(data: Record<string, unknown> | undefined): ExecuteResult {
	const code = data && (data.code as string | undefined);
	if (typeIs(code, "string") === false || code === "") {
		return { success: false, error: "code is required" };
	}
	const m = new Instance("ModuleScript");
	m.Name = "__MCPClientEval";
	const [okSet, setErr] = pcall(() => {
		(m as unknown as { Source: string }).Source = code as string;
	});
	if (!okSet) {
		m.Destroy();
		return { success: false, error: `Source set failed: ${tostring(setErr)}` };
	}
	m.Parent = game.Workspace;
	const [okReq, result] = pcall(() => require(m));
	m.Destroy();
	if (okReq) {
		return {
			success: true,
			returnValue: result !== undefined ? tostring(result) : undefined,
			message: "Code executed successfully",
		};
	}
	return { success: false, error: tostring(result) };
}

function handleGetRuntimeLogs(data: Record<string, unknown> | undefined): unknown {
	const d = data ?? {};
	const since = d.since as number | undefined;
	const tail = d.tail as number | undefined;
	const filter = d.filter as string | undefined;
	// "client" is the generic peer tag; MCP-side aggregator overrides with
	// the specific role (e.g. "client-1") on target=all fan-out.
	return RuntimeLogBuffer.query({ since, tail, filter }, "client");
}

function setupClientBroker() {
	const rf = ReplicatedStorage.WaitForChild(BROKER_NAME, 10);
	if (!rf || !rf.IsA("RemoteFunction")) {
		warn(`[MCPFork] client: ${BROKER_NAME} not found`);
		return;
	}
	rf.OnClientInvoke = (payload: BrokerEnvelope | undefined) => {
		// Two payload shapes in the wild:
		// - {endpoint, data} from v2.10+ server-peer broker (this is the new
		//   discriminated form that lets us dispatch on endpoint)
		// - {code} from pre-v2.10 server-peer broker (raw execute-luau payload)
		// The shapes coexist gracefully because we fall back to execute-luau
		// when endpoint is missing.
		if (payload && payload.endpoint === "/api/get-runtime-logs") {
			return handleGetRuntimeLogs(payload.data);
		}
		if (payload && payload.endpoint === "/api/get-memory-breakdown") {
			return MemoryHandlers.getMemoryBreakdown(payload.data ?? {});
		}
		if (payload && payload.endpoint === "/api/execute-luau") {
			return handleExecuteLuau(payload.data);
		}
		// Legacy: raw execute-luau payload at the top level.
		return handleExecuteLuau(payload as Record<string, unknown> | undefined);
	};
}

const proxyByPlayer = new Map<Player, ProxyEntry>();

function pollProxy(proxyId: string, player: Player, rf: RemoteFunction) {
	while (player.Parent !== undefined && proxyByPlayer.has(player)) {
		const [ok, res] = pcall(() =>
			HttpService.RequestAsync({
				Url: `${MCP_URL}/poll?instanceId=${proxyId}`,
				Method: "GET",
				Headers: { "Content-Type": "application/json" },
			}),
		);
		if (ok && res && (res.Success || res.StatusCode === 503)) {
			const [okJson, body] = pcall(() => HttpService.JSONDecode(res.Body) as PollResponseBody);
			if (okJson && body) {
				// Server lost our proxy registration (process restart, etc.) -
				// re-register so the next poll cycle starts routing again.
				if (body.knownInstance === false) {
					reRegisterProxy(proxyId, "client");
				}
				if (body.request && body.requestId !== undefined) {
					const request = body.request;
					let response: unknown;
					if (CLIENT_BROKER_ALLOWED_ENDPOINTS.has(request.endpoint)) {
						// Forward as a discriminated envelope so the client-side
						// OnClientInvoke knows which endpoint it's serving.
						const envelope = { endpoint: request.endpoint, data: request.data };
						const [okInvoke, invokeRes] = pcall(() => rf.InvokeClient(player, envelope));
						if (okInvoke) {
							response = invokeRes !== undefined ? invokeRes : { success: false, error: "nil response" };
						} else {
							response = { success: false, error: `InvokeClient failed: ${tostring(invokeRes)}` };
						}
					} else {
						response = {
							error:
								`Client-proxy does not forward ${tostring(request.endpoint)}. ` +
								`Allowed: /api/execute-luau, /api/get-runtime-logs.`,
						};
					}
					postJson("/response", { requestId: body.requestId, response });
				}
			}
		}
		task.wait(0.5);
	}
}

function registerProxy(player: Player, rf: RemoteFunction) {
	if (proxyByPlayer.has(player)) return;
	const proxyId = HttpService.GenerateGUID(false);
	const [ok, res] = postJson("/ready", { instanceId: proxyId, role: "client" });
	if (!ok || !res || !res.Success) {
		warn(`[MCPFork] proxy register failed for ${player.Name}`);
		return;
	}
	const body = HttpService.JSONDecode(res.Body) as ReadyResponseBody;
	const assigned = body.assignedRole ?? "client";
	proxyByPlayer.set(player, { instanceId: proxyId, role: assigned });
	task.spawn(pollProxy, proxyId, player, rf);
}

function startEditProxyLoop() {
	task.spawn(() => {
		const proxyId = HttpService.GenerateGUID(false);
		const [ok, res] = postJson("/ready", { instanceId: proxyId, role: "edit-proxy" });
		if (!ok || !res || !res.Success) {
			warn("[MCPFork] edit-proxy register failed");
			return;
		}
		while (true) {
			const [okPoll, pollRes] = pcall(() =>
				HttpService.RequestAsync({
					Url: `${MCP_URL}/poll?instanceId=${proxyId}`,
					Method: "GET",
					Headers: { "Content-Type": "application/json" },
				}),
			);
			if (okPoll && pollRes && (pollRes.Success || pollRes.StatusCode === 503)) {
				const [okJson, body] = pcall(() => HttpService.JSONDecode(pollRes.Body) as PollResponseBody);
				if (okJson && body) {
					// Re-register if the server lost our edit-proxy registration.
					if (body.knownInstance === false) {
						reRegisterProxy(proxyId, "edit-proxy");
					}
					if (
						body.request &&
						body.request.endpoint === "/api/stop-playtest" &&
						body.requestId !== undefined
					) {
						const sts = game.GetService("StudioTestService") as Instance & {
							EndTest(reason: string): void;
						};
						const [endOk, endErr] = pcall(() => sts.EndTest("stopped_by_mcp"));
						const response = endOk
							? { success: true, message: "Playtest stopped via edit-proxy/EndTest" }
							: { success: false, error: `EndTest failed: ${tostring(endErr)}` };
						postJson("/response", { requestId: body.requestId, response });
					}
				}
			}
			task.wait(0.15);
		}
	});
}

function setupServerBroker() {
	let rf = ReplicatedStorage.FindFirstChild(BROKER_NAME) as RemoteFunction | undefined;
	if (!rf) {
		rf = new Instance("RemoteFunction");
		rf.Name = BROKER_NAME;
		rf.Parent = ReplicatedStorage;
	}
	const broker = rf;
	Players.PlayerAdded.Connect((p) => registerProxy(p, broker));
	for (const p of Players.GetPlayers()) {
		task.spawn(registerProxy, p, broker);
	}
	Players.PlayerRemoving.Connect((p) => {
		const entry = proxyByPlayer.get(p);
		if (entry) {
			proxyByPlayer.delete(p);
			postJson("/disconnect", { instanceId: entry.instanceId });
		}
	});
	game.BindToClose(() => {
		for (const [, entry] of proxyByPlayer) {
			postJson("/disconnect", { instanceId: entry.instanceId });
		}
		proxyByPlayer.clear();
	});
	startEditProxyLoop();
}

export = {
	MCP_URL,
	forkRole,
	setupClientBroker,
	setupServerBroker,
};
