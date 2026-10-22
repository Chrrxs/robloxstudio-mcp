// snapshot / diff_state: read selected properties and all attributes of a
// few instances, formatted compactly. The server stores and diffs them.
import QueryTree from "./QueryTree";
import Utils from "../Utils";

const MAX_PATHS = 50;

function read(data: Record<string, unknown>): unknown {
	const paths: string[] = [];
	if (typeIs(data.paths, "table")) {
		for (const path of data.paths as unknown[]) if (typeIs(path, "string") && path !== "") paths.push(path);
	}
	if (paths.size() === 0) return { error: "paths is required" };
	if (paths.size() > MAX_PATHS) return { error: `at most ${MAX_PATHS} paths` };
	const fields: string[] = [];
	if (typeIs(data.fields, "table")) {
		for (const field of data.fields as unknown[]) if (typeIs(field, "string") && field !== "") fields.push(field);
	}

	const instances: Record<string, unknown>[] = [];
	for (const path of paths) {
		const instance = Utils.getInstanceByPath(path);
		if (instance === undefined) {
			instances.push({ path, found: false });
			continue;
		}
		const values: Record<string, string> = {};
		for (const field of fields) {
			const [ok, value] = pcall(() => (instance as unknown as Record<string, unknown>)[field]);
			if (ok) values[field] = QueryTree.formatValue(value);
		}
		const attributes: Record<string, string> = {};
		for (const [name, value] of instance.GetAttributes()) attributes[name] = QueryTree.formatValue(value);
		instances.push({ path, found: true, values, attributes });
	}
	return { instances };
}

export = { read };
