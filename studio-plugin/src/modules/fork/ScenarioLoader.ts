// run_scenario, step 1: load a scenario ModuleScript in the edit DataModel and
// return its definition as plain JSON. A named scenario is cloned beside the
// original before require, so edits since the last run are picked up and
// relative requires (script.Parent...) still resolve.
import Utils from "../Utils";

const ServerStorage = game.GetService("ServerStorage");

const MAX_STEPS = 100;
const MAX_PLAYERS = 8;

type Json = string | number | boolean | Record<string, unknown>;

function plainValue(value: unknown): Json | undefined {
	const kind = typeOf(value);
	if (kind === "string" || kind === "number" || kind === "boolean") return value as Json;
	if (kind === "Vector3") {
		const v = value as Vector3;
		return { x: v.X, y: v.Y, z: v.Z };
	}
	if (kind === "Instance") return Utils.getInstancePath(value as Instance);
	return undefined;
}

function normalizeStep(step: unknown, index: number): Record<string, unknown> | string {
	if (!typeIs(step, "table")) return `step ${index} is not a table`;
	const out: Record<string, unknown> = {};
	for (const [key, value] of pairs(step as object)) {
		if (!typeIs(key, "string")) continue;
		const plain = plainValue(value);
		if (plain !== undefined) out[key] = plain;
	}
	const positional = (step as unknown as unknown[])[0];
	if (out.type === undefined && typeIs(positional, "string")) out.type = positional;
	if (!typeIs(out.type, "string")) return `step ${index} has no type (use { "press", ... } or type = "press")`;
	return out;
}

function availableNames(container: Instance): string {
	const names: string[] = [];
	for (const child of container.GetChildren()) {
		if (child.IsA("ModuleScript") && names.size() < 20) names.push(child.Name);
	}
	return names.size() > 0 ? names.join(", ") : "none";
}

function load(data: Record<string, unknown>): unknown {
	const containerPath = typeIs(data.container, "string") && data.container !== "" ? data.container : "ServerStorage.Scenarios";
	const container = Utils.getInstanceByPath(containerPath);
	let module: ModuleScript;
	let label: string;

	if (typeIs(data.source, "string") && data.source !== "") {
		module = new Instance("ModuleScript");
		const [okSet, setErr] = pcall(() => {
			(module as unknown as { Source: string }).Source = data.source as string;
		});
		if (!okSet) {
			module.Destroy();
			return { error: `cannot set scenario source: ${tostring(setErr)}` };
		}
		label = "inline";
		module.Name = "__MCPScenario";
		module.Parent = container ?? ServerStorage;
	} else if (typeIs(data.name, "string") && data.name !== "") {
		if (container === undefined) return { error: `no scenario container at ${containerPath}` };
		const original = container.FindFirstChild(data.name);
		if (original === undefined || !original.IsA("ModuleScript")) {
			return { error: `no ModuleScript "${data.name}" in ${containerPath} (found: ${availableNames(container)})` };
		}
		module = original.Clone();
		label = data.name;
		module.Name = `${data.name}__mcp`;
		module.Parent = container;
	} else {
		return { error: "name or source is required" };
	}

	const [okRequire, required] = pcall(() => require(module));
	module.Destroy();
	if (!okRequire) return { error: `scenario ${label} failed to load: ${tostring(required)}` };

	let definition = required as unknown;
	if (typeIs(definition, "function")) {
		const [okCall, built] = pcall(() => (definition as (params: unknown) => unknown)(data.params ?? {}));
		if (!okCall) return { error: `scenario ${label} failed when called with params: ${tostring(built)}` };
		definition = built;
	}
	if (!typeIs(definition, "table")) return { error: `scenario ${label} must return a table (or a function returning one)` };

	const fields = definition as Record<string, unknown>;
	const players = fields.players === undefined ? 1 : fields.players;
	if (!typeIs(players, "number") || players !== math.floor(players) || players < 0 || players > MAX_PLAYERS) {
		return { error: `scenario ${label}: players must be a whole number from 0 to ${MAX_PLAYERS}` };
	}
	if (!typeIs(fields.steps, "table")) return { error: `scenario ${label}: steps must be a list` };
	const steps: Record<string, unknown>[] = [];
	for (const step of fields.steps as unknown[]) {
		if (steps.size() >= MAX_STEPS) return { error: `scenario ${label}: at most ${MAX_STEPS} steps` };
		const normalized = normalizeStep(step, steps.size() + 1);
		if (typeIs(normalized, "string")) return { error: `scenario ${label}: ${normalized}` };
		steps.push(normalized);
	}
	return { name: label, players, steps };
}

export = { load };
