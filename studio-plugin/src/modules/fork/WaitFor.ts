// wait_for: polls a Luau expression inside Studio until it is truthy or the
// timeout passes, so the agent makes one call instead of many. Edit mode runs
// in the plugin VM (like execute_luau); a running server or client peer runs
// in the game VM through the eval bridge (like eval_*_runtime), where game
// scripts' state lives.
import LuauExec from "../LuauExec";
import EvalRuntimeHandlers from "../handlers/EvalRuntimeHandlers";

const HttpService = game.GetService("HttpService");
const RunService = game.GetService("RunService");

const MAX_TIMEOUT = 120;
const MAX_VALUE_CHARS = 200;

function pollingSource(expr: string, timeout: number): string {
	return `local __expr = function()
	return (${expr}
)
end
local function __fmt(v)
	local s
	local t = typeof(v)
	if t == "string" then
		s = string.format("%q", v)
	elseif t == "Instance" then
		s = v:GetFullName()
	else
		s = tostring(v)
	end
	if #s > ${MAX_VALUE_CHARS} then
		s = string.sub(s, 1, ${MAX_VALUE_CHARS - 1}) .. "…"
	end
	return s
end
local __start = os.clock()
local __deadline = __start + ${timeout}
local __polls = 0
while true do
	__polls += 1
	local __ok, __v = pcall(__expr)
	local __done = __ok and __v
	if __done or os.clock() >= __deadline then
		return {
			ok = if __done then true else false,
			elapsed = os.clock() - __start,
			polls = __polls,
			value = if __ok then __fmt(__v) else "error: " .. __fmt(__v),
		}
	end
	task.wait(0.1)
end
`;
}

function decodeResult(encoded: unknown): unknown {
	if (!typeIs(encoded, "string")) return { error: "wait_for returned no result" };
	const [ok, decoded] = pcall(() => HttpService.JSONDecode(encoded));
	if (!ok || !typeIs(decoded, "table")) return { error: `wait_for returned an invalid result: ${encoded}` };
	return decoded;
}

function waitFor(data: Record<string, unknown>): unknown {
	const expr = data.expr;
	if (!typeIs(expr, "string") || expr === "") return { error: "expr is required" };
	const timeout = typeIs(data.timeout, "number") ? math.clamp(data.timeout, 0, MAX_TIMEOUT) : 5;
	const source = pollingSource(expr, timeout);

	if (RunService.IsRunning()) {
		const result = EvalRuntimeHandlers.evalRuntime({ code: source }) as Record<string, unknown>;
		if (result.ok !== true) return { error: tostring(result.error ?? "eval failed") };
		return decodeResult(result.result);
	}
	const result = LuauExec.execute(source) as unknown as Record<string, unknown>;
	if (result.success !== true) return { error: tostring(result.error ?? "execution failed") };
	return decodeResult(result.returnValue);
}

export = { waitFor };
