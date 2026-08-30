interface JobExecution {
	requestId: string;
	deadlineAt?: number;
	isCancelled?: () => boolean;
}

interface JobControl {
	checkpoint(): void;
}

interface BusyResult {
	error: "plugin_busy";
	activeRequestId: string;
}

interface DeadlineResult {
	error: "deadline_exceeded";
	requestId: string;
}

interface CancelledResult {
	error: "cancelled";
	requestId: string;
}

const DEADLINE_EXCEEDED = "__RSMCP_COOPERATIVE_JOB_DEADLINE_EXCEEDED__";
const CANCELLED = "__RSMCP_COOPERATIVE_JOB_CANCELLED__";
const MAX_SLICE_SECONDS = 0.008;
const CLOCK_CHECK_INTERVAL = 64;

const activeJobs = new Map<string, string>();

function runExclusive<T>(
	key: string,
	execution: JobExecution,
	work: (control: JobControl) => T,
): T | BusyResult | DeadlineResult | CancelledResult {
	const activeRequestId = activeJobs.get(key);
	if (activeRequestId !== undefined) {
		return {
			error: "plugin_busy",
			activeRequestId,
		};
	}

	activeJobs.set(key, execution.requestId);
	let sliceStartedAt = os.clock();
	let operationsUntilClockCheck = 0;
	const control: JobControl = {
		checkpoint() {
			if (execution.isCancelled?.()) {
				error(CANCELLED, 0);
			}
			if (operationsUntilClockCheck > 0) {
				operationsUntilClockCheck--;
				return;
			}
			operationsUntilClockCheck = CLOCK_CHECK_INTERVAL - 1;
			const now = os.clock();
			if (execution.deadlineAt !== undefined && now >= execution.deadlineAt) {
				error(DEADLINE_EXCEEDED, 0);
			}
			if (now - sliceStartedAt >= MAX_SLICE_SECONDS) {
				task.wait();
				sliceStartedAt = os.clock();
			}
		},
	};
	const [ok, result] = pcall(() => work(control));
	activeJobs.delete(key);
	if (!ok) {
		if (result === DEADLINE_EXCEEDED) {
			return {
				error: "deadline_exceeded",
				requestId: execution.requestId,
			};
		}
		if (result === CANCELLED) {
			return {
				error: "cancelled",
				requestId: execution.requestId,
			};
		}
		error(result, 0);
	}
	return result as T;
}

export = {
	runExclusive,
};
