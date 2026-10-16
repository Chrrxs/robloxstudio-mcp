// Bounded instance search behind search_objects. It walks one subtree in
// GetChildren order, applies an optional IsA filter, and stops after
// maxResults matches. An ambiguous `path` is reported by PathGuard before this
// runs. It is written against an injected corpus so it can run outside Studio.

// Function properties rather than methods, so plain functions can be assigned
// directly under roblox-ts.
interface InstanceCorpus<T> {
	readonly resolveRoot: (path: string) => T | undefined;
	readonly getChildren: (node: T) => T[];
	readonly getName: (node: T) => string;
	readonly getClassName: (node: T) => string;
	readonly isA: (node: T, className: string) => boolean;
	/** tostring of the property, or undefined when it cannot be read. */
	readonly readPropertyText: (node: T, propertyName: string) => string | undefined;
	readonly getPath: (node: T) => string;
	readonly createAmbiguityChecker: () => (node: T) => boolean;
}

interface SearchControl {
	checkpoint(): void;
}

interface SearchResult {
	name: string;
	className: string;
	path: string;
	ambiguous?: true;
}

const SEARCH_TYPES = new Set<string>(["name", "class", "property"]);
const DEFAULT_MAX_RESULTS = 100;
const MAX_RESULTS = 10000;

function invalid(message: string): Record<string, unknown> {
	return { error: "invalid_request", message };
}

function containsText(haystack: string, needle: string): boolean {
	return string.find(haystack.lower(), needle, 1, true)[0] !== undefined;
}

function createInstanceSearch<T extends defined>(corpus: InstanceCorpus<T>) {
	function search(requestData: Record<string, unknown>, control: SearchControl): Record<string, unknown> {
		const rawQuery = requestData.query;
		if (rawQuery !== undefined && !typeIs(rawQuery, "string")) return invalid("query must be a string");
		const query = (rawQuery as string | undefined) ?? "";

		const rawSearchType = requestData.searchType ?? "name";
		if (!typeIs(rawSearchType, "string") || !SEARCH_TYPES.has(rawSearchType)) {
			return invalid("searchType must be one of name, class, property");
		}
		const searchType = rawSearchType;

		const propertyName = requestData.propertyName;
		if (searchType === "property" && (!typeIs(propertyName, "string") || propertyName === "")) {
			return invalid("propertyName is required when searchType is property");
		}

		const className = requestData.className;
		if (className !== undefined && (!typeIs(className, "string") || className === "")) {
			return invalid("className must be a non-empty string");
		}

		if (query === "" && className === undefined) {
			return { error: "query is required unless className is set" };
		}

		const requestedMaxResults = requestData.maxResults;
		if (
			requestedMaxResults !== undefined &&
			(
				!typeIs(requestedMaxResults, "number") ||
				math.floor(requestedMaxResults) !== requestedMaxResults ||
				requestedMaxResults < 1 ||
				requestedMaxResults > MAX_RESULTS
			)
		) {
			return invalid(`maxResults must be an integer between 1 and ${MAX_RESULTS}`);
		}
		const maxResults = (requestedMaxResults as number | undefined) ?? DEFAULT_MAX_RESULTS;

		const rawPath = requestData.path;
		if (rawPath !== undefined && !typeIs(rawPath, "string")) return invalid("path must be a string");
		const searchPath = (rawPath as string | undefined) ?? "";
		const root = corpus.resolveRoot(searchPath);
		if (root === undefined) return { error: `Path not found: ${searchPath}` };

		const needle = query.lower();
		const isAmbiguous = corpus.createAmbiguityChecker();

		function matches(node: T): boolean {
			if (className !== undefined && !corpus.isA(node, className as string)) return false;
			if (needle === "") return true;
			if (searchType === "name") return containsText(corpus.getName(node), needle);
			if (searchType === "class") return containsText(corpus.getClassName(node), needle);
			const text = corpus.readPropertyText(node, propertyName as string);
			return text !== undefined && containsText(text, needle);
		}

		const results: SearchResult[] = [];
		const stack: T[] = [root];
		let truncated = false;

		while (stack.size() > 0) {
			control.checkpoint();
			const node = stack.pop()!;
			if (matches(node)) {
				if (results.size() >= maxResults) {
					truncated = true;
					break;
				}
				const entry: SearchResult = {
					name: corpus.getName(node),
					className: corpus.getClassName(node),
					path: corpus.getPath(node),
				};
				if (isAmbiguous(node)) entry.ambiguous = true;
				results.push(entry);
			}
			const children = corpus.getChildren(node);
			for (let index = children.size() - 1; index >= 0; index--) stack.push(children[index]);
		}

		const response: Record<string, unknown> = {
			results,
			query,
			searchType,
			count: results.size(),
			truncated,
			maxResults,
			path: corpus.getPath(root),
		};
		if (searchType === "property") response.propertyName = propertyName;
		if (className !== undefined) response.className = className;
		return response;
	}

	return { search };
}

export = {
	createInstanceSearch,
};
