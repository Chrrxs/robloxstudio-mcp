// query_tree: one compact line per instance under a path, with only the
// requested fields. Walks breadth-first, yields through CooperativeJobRunner,
// and keeps counting past `limit` so the caller learns the true total.
import CooperativeJobRunner from "../CooperativeJobRunner";
import Utils from "../Utils";
import type { StudioRequestContext } from "../../types";

const HttpService = game.GetService("HttpService");

const MAX_DEPTH = 10;
const MAX_LIMIT = 500;
const MAX_VALUE_CHARS = 80;
const FALLBACK_BUDGET_SECONDS = 20;

function num(n: number): string {
	if (n === math.floor(n) && math.abs(n) < 1e15) return string.format("%d", n);
	const [text] = string.format("%.3f", n).gsub("0+$", "");
	const [trimmed] = text.gsub("%.$", "");
	return trimmed;
}

function formatValue(value: unknown): string {
	const kind = typeOf(value);
	let text: string;
	if (kind === "number") {
		text = num(value as number);
	} else if (kind === "string") {
		const s = value as string;
		const [escaped] = s.gsub("\n", "\\n");
		text = s === "" || s.find("[%s=]")[0] !== undefined ? `"${escaped}"` : escaped;
	} else if (kind === "Vector3") {
		const v = value as Vector3;
		text = `${num(v.X)},${num(v.Y)},${num(v.Z)}`;
	} else if (kind === "Vector2") {
		const v = value as Vector2;
		text = `${num(v.X)},${num(v.Y)}`;
	} else if (kind === "CFrame") {
		const cf = value as CFrame;
		const [rx, ry, rz] = cf.ToOrientation();
		text = `${num(cf.X)},${num(cf.Y)},${num(cf.Z)}@${num(math.deg(rx))},${num(math.deg(ry))},${num(math.deg(rz))}`;
	} else if (kind === "Color3") {
		text = `#${(value as Color3).ToHex()}`;
	} else if (kind === "UDim2") {
		const u = value as UDim2;
		text = `${num(u.X.Scale)},${num(u.X.Offset)},${num(u.Y.Scale)},${num(u.Y.Offset)}`;
	} else if (kind === "UDim") {
		const u = value as UDim;
		text = `${num(u.Scale)},${num(u.Offset)}`;
	} else if (kind === "EnumItem") {
		text = (value as EnumItem).Name;
	} else if (kind === "BrickColor") {
		text = (value as BrickColor).Name;
	} else if (kind === "Instance") {
		text = Utils.getInstancePath(value as Instance);
	} else if (value === undefined) {
		text = "nil";
	} else {
		text = tostring(value);
	}
	return text.size() > MAX_VALUE_CHARS ? `${text.sub(1, MAX_VALUE_CHARS - 1)}…` : text;
}

function readField(instance: Instance, field: string): string | undefined {
	if (field.sub(1, 1) === "@") {
		const value = instance.GetAttribute(field.sub(2));
		return value === undefined ? undefined : formatValue(value);
	}
	const [ok, value] = pcall(() => (instance as unknown as Record<string, unknown>)[field]);
	if (!ok) return undefined;
	return formatValue(value);
}

function relativePath(instance: Instance, rootPath: string): string {
	const full = Utils.getInstancePath(instance);
	if (full === rootPath) return ".";
	let rest = full.sub(rootPath.size() + 1);
	if (rest.sub(1, 1) === ".") rest = rest.sub(2);
	return rest;
}

function query(data: Record<string, unknown>, context?: StudioRequestContext): unknown {
	const path = data.path;
	if (!typeIs(path, "string") || path === "") return { error: "path is required" };
	const root = Utils.getInstanceByPath(path);
	if (root === undefined) return { error: `no instance at ${path}` };
	const className = typeIs(data.class, "string") && data.class !== "" ? data.class : undefined;
	const depth = typeIs(data.depth, "number") ? math.clamp(math.floor(data.depth), 0, MAX_DEPTH) : 1;
	const limit = typeIs(data.limit, "number") ? math.clamp(math.floor(data.limit), 1, MAX_LIMIT) : 25;
	const fields: string[] = [];
	if (typeIs(data.fields, "table")) {
		for (const field of data.fields as unknown[]) if (typeIs(field, "string") && field !== "") fields.push(field);
	}
	const rootPath = Utils.getInstancePath(root);

	const execution = context ?? {
		requestId: HttpService.GenerateGUID(false),
		deadlineAt: os.clock() + FALLBACK_BUDGET_SECONDS,
	};
	const result = CooperativeJobRunner.runExclusive(`query-tree:${execution.requestId}`, execution, (control) => {
		const lines: string[] = [];
		let total = 0;
		const visit = (instance: Instance) => {
			control.checkpoint();
			const [isA] = className === undefined ? [true] : pcall(() => instance.IsA(className as keyof Instances));
			if (isA !== true) return;
			total++;
			if (lines.size() >= limit) return;
			const parts = [relativePath(instance, rootPath), instance.ClassName];
			for (const field of fields) {
				const value = readField(instance, field);
				if (value !== undefined) parts.push(`${field}=${value}`);
			}
			lines.push(parts.join(" "));
		};
		if (depth === 0) {
			visit(root);
		} else {
			let level: Instance[] = [root];
			for (let d = 1; d <= depth && level.size() > 0; d++) {
				const nextLevel: Instance[] = [];
				for (const parent of level) {
					for (const child of parent.GetChildren()) {
						visit(child);
						if (d < depth) nextLevel.push(child);
					}
				}
				level = nextLevel;
			}
		}
		return { lines, total };
	});
	if ((result as { error?: string }).error === "deadline_exceeded") {
		return { error: "query_tree ran out of time; narrow path, class or depth." };
	}
	return result;
}

export = { query, formatValue };
