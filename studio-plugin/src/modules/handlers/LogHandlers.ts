import RuntimeLogBuffer from "../RuntimeLogBuffer";

function getRuntimeLogs(requestData: Record<string, unknown>): unknown {
	const since = requestData.since as number | undefined;
	const tail = requestData.tail as number | undefined;
	const filter = requestData.filter as string | undefined;
	return RuntimeLogBuffer.query({ since, tail, filter });
}

export = { getRuntimeLogs };
