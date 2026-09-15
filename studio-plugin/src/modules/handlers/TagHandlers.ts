import { CollectionService } from "@rbxts/services";
import QueryHandlers from "./QueryHandlers";
import ScriptSearch from "../ScriptSearch";
import Utils from "../Utils";
import type { StudioRequestContext } from "../../types";

const { getInstancePath } = Utils;

const DEFAULT_MAX_RESULTS = 100;
const MAX_RESULTS = 1000;
const MAX_SCRIPT_MATCHES = 200;
const DYNAMIC_HINT =
	"No script contains this tag as a string literal. The tag name may come from a Config or data table, an attribute, or a StringValue; search those sources or the code that calls GetTagged with a variable.";

interface GrepMatch {
	line: number;
	column: number;
	text: string;
}

interface GrepScript {
	instancePath: string;
	name: string;
	className: string;
	matches: GrepMatch[];
}

interface GrepResult {
	error?: string;
	message?: string;
	results?: GrepScript[];
	scriptsSearched?: number;
	truncated?: boolean;
}

interface TagScriptUse {
	instancePath: string;
	className: string;
	line: number;
	text: string;
	api: string;
}

function listAllTags(): Record<string, unknown> {
	const counts = new Map<string, number>();
	const [ok, all] = pcall(() => CollectionService.GetAllTags());
	if (ok) {
		for (const tag of all) counts.set(tag, CollectionService.GetTagged(tag).size());
	} else {
		for (const instance of game.GetDescendants()) {
			for (const tag of CollectionService.GetTags(instance)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
		}
	}
	const tags: { tag: string; count: number }[] = [];
	for (const [tag, count] of counts) tags.push({ tag, count });
	tags.sort((a, b) => a.tag < b.tag);
	return { tags, totalTags: tags.size() };
}

function searchTags(requestData: Record<string, unknown>, execution: StudioRequestContext): unknown {
	const tag = requestData.tag;
	if (tag === undefined) return listAllTags();
	if (!typeIs(tag, "string") || tag === "") {
		return { error: "invalid_request", message: "tag must be a non-empty string" };
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
		return { error: "invalid_request", message: `maxResults must be an integer between 1 and ${MAX_RESULTS}` };
	}
	const maxResults = (requestedMaxResults as number | undefined) ?? DEFAULT_MAX_RESULTS;

	const tagged = CollectionService.GetTagged(tag);
	const instances: string[] = [];
	for (const instance of tagged) {
		if (instances.size() >= maxResults) break;
		instances.push(getInstancePath(instance));
	}

	const grep = QueryHandlers.grepScripts(
		{ pattern: ScriptSearch.tagLiteralPattern(tag), usePattern: true, maxResults: MAX_SCRIPT_MATCHES },
		execution,
	) as GrepResult;
	if (grep.error !== undefined) {
		return { error: grep.error, message: grep.message ?? grep.error, tag, instances, instanceCount: tagged.size() };
	}

	const scripts: TagScriptUse[] = [];
	for (const hit of grep.results ?? []) {
		for (const use of hit.matches) {
			scripts.push({
				instancePath: hit.instancePath,
				className: hit.className,
				line: use.line,
				text: use.text,
				api: ScriptSearch.classifyTagUsage(use.text),
			});
		}
	}

	const result: Record<string, unknown> = {
		tag,
		instances,
		instanceCount: tagged.size(),
		truncated: tagged.size() > instances.size(),
		scripts,
		scriptsSearched: grep.scriptsSearched ?? 0,
		scriptsTruncated: grep.truncated === true,
	};
	if (scripts.size() === 0) result.dynamicHint = DYNAMIC_HINT;
	return result;
}

export = { searchTags };
