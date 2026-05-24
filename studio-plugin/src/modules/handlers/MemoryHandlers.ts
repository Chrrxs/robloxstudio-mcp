const Stats = game.GetService("Stats");

// GetMemoryUsageMbAllCategories is gated by capability "InternalTest" and not
// callable from plugin context. GetMemoryUsageMbForTag is not - so we iterate
// Enum.DeveloperMemoryTag and ask per-tag.
function getMemoryBreakdown(requestData: Record<string, unknown>): unknown {
	if (!Stats.MemoryTrackingEnabled) {
		return { error: "MemoryTrackingEnabled is false on this peer" };
	}

	const requested = requestData.tags as string[] | undefined;
	const requestedSet = requested && requested.size() > 0 ? new Set(requested) : undefined;

	const categories: Record<string, number> = {};
	for (const item of Enum.DeveloperMemoryTag.GetEnumItems()) {
		const name = item.Name;
		if (requestedSet && !requestedSet.has(name)) continue;
		const [ok, mb] = pcall(() => Stats.GetMemoryUsageMbForTag(item));
		categories[name] = ok ? (mb as number) : 0;
	}

	const unknownTags: string[] = [];
	if (requestedSet) {
		const known = new Set<string>();
		for (const i of Enum.DeveloperMemoryTag.GetEnumItems()) known.add(i.Name);
		for (const t of requestedSet) {
			if (!known.has(t)) {
				unknownTags.push(t);
				categories[t] = 0;
			}
		}
	}

	const result: Record<string, unknown> = {
		total_mb: Stats.GetTotalMemoryUsageMb(),
		categories,
		memory_tracking_enabled: true,
		timestamp: DateTime.now().UnixTimestampMillis,
	};
	if (unknownTags.size() > 0) result.unknown_tags = unknownTags;
	return result;
}

export = { getMemoryBreakdown };
