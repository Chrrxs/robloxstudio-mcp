import RuntimeLogBuffer from "../RuntimeLogBuffer";

type LogLevel = "OUT" | "WARN" | "ERR" | "INFO";

const LEVELS: LogLevel[] = ["ERR", "WARN", "INFO", "OUT"];

function getRuntimeLogs(requestData: Record<string, unknown>): unknown {
	const since = requestData.since as number | undefined;
	const tail = requestData.tail as number | undefined;
	const filter = requestData.filter as string | undefined;
	const level = requestData.level;
	if (level !== undefined && (!typeIs(level, "string") || !LEVELS.includes(level as LogLevel))) {
		return { error: `level must be one of ${LEVELS.join(", ")}` };
	}
	const sinceTs = requestData.sinceTs;
	if (sinceTs !== undefined && (!typeIs(sinceTs, "number") || sinceTs < 0)) {
		return { error: "sinceTs must be a non-negative number" };
	}
	const exclude = requestData.exclude;
	if (exclude !== undefined && !typeIs(exclude, "string")) {
		return { error: "exclude must be a string" };
	}
	const dedupe = requestData.dedupe;
	if (dedupe !== undefined && !typeIs(dedupe, "boolean")) {
		return { error: "dedupe must be a boolean" };
	}
	return RuntimeLogBuffer.query({
		since,
		tail,
		filter,
		level: level as LogLevel | undefined,
		sinceTs: sinceTs as number | undefined,
		exclude: exclude as string | undefined,
		dedupe: dedupe as boolean | undefined,
	});
}

export = { getRuntimeLogs };
