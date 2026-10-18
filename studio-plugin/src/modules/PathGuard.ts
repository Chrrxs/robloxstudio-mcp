import type { PathAmbiguity } from "../types";

// Central handling of request paths that name more than one instance.
// Every endpoint that accepts instance paths declares them here. Before the
// handler runs, each declared path is checked:
//   - write: an ambiguous path refuses the request, so no arbitrary duplicate
//     is modified;
//   - read: the handler runs on the first match, and the response gains
//     `ambiguousPaths` and `pathWarning` so the caller knows it may be wrong.
// Written against an injected resolver so it can run outside Studio.

type PathAccess = "read" | "write";

interface PathReference {
	field: string;
	path: string;
	access: PathAccess;
}

interface AmbiguousPathReport extends PathAmbiguity {
	field: string;
	path: string;
	access: PathAccess;
}

type PathExtractor = (data: Record<string, unknown>) => PathReference[];

function pathField(field: string, access: PathAccess | ((data: Record<string, unknown>) => PathAccess)): PathExtractor {
	return (data) => {
		const value = data[field];
		if (!typeIs(value, "string") || value === "") return [];
		return [{ field, path: value, access: typeIs(access, "string") ? access : access(data) }];
	};
}

function pathListField(field: string, access: PathAccess): PathExtractor {
	return (data) => {
		const value = data[field];
		const references: PathReference[] = [];
		if (!typeIs(value, "table")) return references;
		let index = 0;
		for (const entry of value as unknown[]) {
			if (typeIs(entry, "string") && entry !== "") {
				references.push({ field: `${field}[${index}]`, path: entry, access });
			}
			index++;
		}
		return references;
	};
}

// set_properties takes instance paths as the values of reference properties.
const REFERENCE_PROPERTIES = ["Parent", "PrimaryPart"];

function referencePropertyPaths(data: Record<string, unknown>): PathReference[] {
	const properties = data.properties;
	const references: PathReference[] = [];
	if (!typeIs(properties, "table")) return references;
	for (const propertyName of REFERENCE_PROPERTIES) {
		const value = (properties as Record<string, unknown>)[propertyName];
		if (typeIs(value, "string") && value !== "") {
			references.push({ field: `properties.${propertyName}`, path: value, access: "write" });
		}
	}
	return references;
}

const dryRunIsRead = (data: Record<string, unknown>): PathAccess => (data.dryRun === true ? "read" : "write");

const ENDPOINT_PATHS: Record<string, PathExtractor[]> = {
	"/api/file-tree": [pathField("path", "read")],
	"/api/search-objects": [pathField("path", "read")],
	"/api/instance-properties": [pathField("instancePath", "read")],
	"/api/project-structure": [pathField("path", "read")],
	"/api/grep-scripts": [pathField("path", "read")],
	"/api/get-script-source": [pathField("instancePath", "read")],
	"/api/get-attributes": [pathField("instancePath", "read")],
	"/api/set-selection": [pathListField("paths", "read")],
	"/api/focus-viewport": [pathField("path", "read")],
	"/api/breakpoints": [pathField("script_path", "read")],
	"/api/export-rbxm": [pathListField("instance_paths", "read")],

	"/api/set-properties": [pathField("instancePath", "write"), referencePropertyPaths],
	"/api/set-script-source": [pathField("instancePath", "write")],
	"/api/edit-script-lines": [pathField("instancePath", dryRunIsRead)],
	"/api/insert-script-lines": [pathField("instancePath", "write")],
	"/api/delete-script-lines": [pathField("instancePath", "write")],
	"/api/find-and-replace-in-scripts": [pathField("path", dryRunIsRead)],
	"/api/insert-asset": [pathField("parentPath", "write")],
	"/api/import-rbxm": [pathField("parent_path", "write")],
};

function describe(report: AmbiguousPathReport): string {
	return `${report.path} (${report.field}): ${report.matchCount} children of ${report.parentPath} are named "${report.segment}"`;
}

function describeAll(reports: AmbiguousPathReport[]): string {
	const parts: string[] = [];
	for (const report of reports) parts.push(describe(report));
	return parts.join("; ");
}

function createPathGuard(findAmbiguity: (path: string) => PathAmbiguity | undefined) {
	function inspect(endpoint: string, data: Record<string, unknown>): AmbiguousPathReport[] {
		const reports: AmbiguousPathReport[] = [];
		const extractors = ENDPOINT_PATHS[endpoint];
		if (extractors === undefined) return reports;
		for (const extract of extractors) {
			for (const reference of extract(data)) {
				const ambiguity = findAmbiguity(reference.path);
				if (ambiguity !== undefined) {
					reports.push({
						field: reference.field,
						path: reference.path,
						access: reference.access,
						segment: ambiguity.segment,
						parentPath: ambiguity.parentPath,
						matchCount: ambiguity.matchCount,
					});
				}
			}
		}
		return reports;
	}

	function run(endpoint: string, data: Record<string, unknown>, handle: () => unknown): unknown {
		const reports = inspect(endpoint, data);
		if (reports.size() === 0) return handle();

		const writes = reports.filter((report) => report.access === "write");
		if (writes.size() > 0) {
			return {
				error: `Ambiguous path ${describeAll(writes)}. Refusing to modify an arbitrary match; rename the duplicates or target the instance with execute_luau.`,
				ambiguousPaths: writes,
			};
		}

		const result = handle();
		if (typeIs(result, "table")) {
			const response = result as Record<string, unknown>;
			response.ambiguousPaths = reports;
			response.pathWarning = `Ambiguous path ${describeAll(reports)}; the first match was used.`;
		}
		return result;
	}

	return { inspect, run };
}

export = {
	createPathGuard,
};
