import Utils from "../Utils";
import Recording from "../Recording";

const { getInstanceByPath, getInstancePath, convertPropertyValue, applyScriptSource } = Utils;
const { beginRecording, finishRecording } = Recording;

// Native StringValue rejects UTF-8 strings of 200000 bytes or more.
const STRING_VALUE_MAX_BYTES = 199999;

// Atomic mode supports plain property assignment plus Name, Parent, and
// PrimaryPart: it snapshots those values and restores them if a later write
// fails. Changed listeners and other engine side effects of a write are not
// reversed. Script Source is rejected: it is outside ChangeHistoryService and
// needs revision-checked restoration (set_script_source expected_revision).
const REFERENCE_PROPERTIES = new Set(["Parent", "PrimaryPart"]);

type PropertyPlan =
	| { ok: true; property: string; value: unknown; previous: unknown }
	| { ok: false; property: string; code: string; error: string };

interface AppliedProperty {
	property: string;
	previous: unknown;
	// Value read back after our write; undefined readback still counts when readable.
	written: unknown;
	readable: boolean;
}

function jsonSafe(value: unknown): unknown {
	if (value === undefined || typeIs(value, "string") || typeIs(value, "boolean")) return value;
	// NaN and infinities are not valid JSON numbers.
	if (typeIs(value, "number")) return value - value === 0 ? value : tostring(value);
	if (typeOf(value) === "Instance") return getInstancePath(value as Instance);
	return tostring(value);
}

function typeMismatch(previous: unknown, value: unknown): string | undefined {
	if (previous === undefined) return undefined;
	const expected = typeOf(previous);
	const actual = typeOf(value);
	if (expected === "EnumItem") {
		const enumType = (previous as EnumItem).EnumType;
		if (actual === "number" || (actual === "EnumItem" && (value as EnumItem).EnumType === enumType)) return undefined;
		return `expected an item of Enum.${tostring(enumType)}, got ${actual === "string" ? `"${tostring(value)}"` : actual}`;
	}
	if (expected === actual || (expected === "string" && actual === "number")) return undefined;
	return `expected ${expected}, got ${actual}`;
}

// Converts and checks one property without writing it. The apply phase writes
// exactly the converted value returned here.
function planProperty(instance: Instance, property: string, requested: unknown): PropertyPlan {
	const inst = instance as unknown as Record<string, unknown>;
	const reject = (code: string, message: string): PropertyPlan => ({ ok: false, property, code, error: message });

	if (property === "Source" && instance.IsA("LuaSourceContainer")) {
		return reject(
			"source_unsupported",
			"Script Source cannot be set atomically because it is outside ChangeHistoryService; use set_script_source with expected_revision",
		);
	}
	const [readable, previous] = pcall(() => inst[property]);
	if (!readable) return reject("property_unreadable", `${property} is not a readable property of ${instance.ClassName}: ${tostring(previous)}`);

	if (REFERENCE_PROPERTIES.has(property)) {
		if (!typeIs(requested, "string")) {
			return reject("invalid_value", `${property} must be an instance path string (or an empty string to clear)`);
		}
		if (requested === "") return { ok: true, property, value: undefined, previous };
		const reference = getInstanceByPath(requested);
		if (!reference) return reject("reference_not_found", `${property} reference not found: ${requested}`);
		if (property === "Parent" && (reference === instance || reference.IsDescendantOf(instance))) {
			return reject("invalid_value", `Parent cannot be the instance itself or one of its descendants: ${requested}`);
		}
		if (property === "PrimaryPart" && !reference.IsA("BasePart")) {
			return reject("invalid_value", `PrimaryPart must reference a BasePart: ${requested}`);
		}
		return { ok: true, property, value: reference, previous };
	}

	let value: unknown;
	if (property === "Name") {
		if (!typeIs(requested, "string") && !typeIs(requested, "number")) return reject("invalid_value", "Name must be a string");
		value = tostring(requested);
	} else {
		const converted = convertPropertyValue(instance, property, requested);
		value = converted !== undefined ? converted : requested;
	}
	const mismatch = typeMismatch(previous, value);
	if (mismatch !== undefined) return reject("type_mismatch", `${property}: ${mismatch}`);
	return { ok: true, property, value, previous };
}

function setPropertiesAtomic(instancePath: string, properties: Record<string, unknown>, dryRun: boolean) {
	const report = (fields: Record<string, unknown>) => ({
		atomic: true,
		dryRun,
		instancePath,
		changed: [],
		restored: [],
		restoreFailures: [],
		rolledBack: false,
		...fields,
	});

	const instance = getInstanceByPath(instancePath);
	if (!instance) {
		return report({ success: false, phase: "validation", code: "instance_not_found", error: `Instance not found: ${instancePath}`, results: [] });
	}

	const names: string[] = [];
	const results = new Map<string, Record<string, unknown>>();
	for (const [property] of pairs(properties)) {
		if (!typeIs(property, "string")) {
			return report({ success: false, phase: "validation", code: "invalid_properties", error: "Property names must be strings", results: [] });
		}
		names.push(property);
	}
	names.sort();

	// Phase 1: resolve, convert, and snapshot every property before any write.
	const plans: { property: string; value: unknown; previous: unknown }[] = [];
	let invalid = 0;
	for (const property of names) {
		const plan = planProperty(instance, property, properties[property]);
		if (plan.ok) {
			plans.push(plan);
			results.set(property, { property, status: "valid", previous: jsonSafe(plan.previous), value: jsonSafe(plan.value) });
		} else {
			invalid++;
			results.set(property, { property, status: "invalid", code: plan.code, error: plan.error });
		}
	}
	const orderedResults = () => names.map((property) => results.get(property)!);

	if (invalid > 0 || dryRun) {
		return report({
			success: invalid === 0,
			phase: "validation",
			...(invalid > 0 ? { error: `${invalid} of ${names.size()} properties failed validation; nothing was written` } : {}),
			summary: { total: names.size(), invalid, changed: 0, restored: 0, restoreFailures: 0 },
			results: orderedResults(),
		});
	}

	// Phase 2: apply in name order, reading back each value we wrote.
	const inst = instance as unknown as Record<string, unknown>;
	const recordingId = beginRecording("Set multiple properties atomically");
	const applied: AppliedProperty[] = [];
	const changed: Record<string, unknown>[] = [];
	let failure: { property: string; error: string } | undefined;
	for (const plan of plans) {
		const [written, writeError] = pcall(() => {
			inst[plan.property] = plan.value;
		});
		const [readable, readback] = pcall(() => inst[plan.property]);
		const result = results.get(plan.property)!;
		if (written) {
			applied.push({ property: plan.property, previous: plan.previous, written: readback, readable });
			changed.push({ property: plan.property, previous: jsonSafe(plan.previous), value: readable ? jsonSafe(readback) : undefined });
			result.status = "applied";
			result.value = readable ? jsonSafe(readback) : undefined;
			continue;
		}
		// A setter can change the value before it throws; restore that too.
		if (readable && readback !== plan.previous) {
			applied.push({ property: plan.property, previous: plan.previous, written: readback, readable });
			changed.push({ property: plan.property, previous: jsonSafe(plan.previous), value: jsonSafe(readback), partial: true });
		}
		result.status = "failed";
		result.code = "write_failed";
		result.error = tostring(writeError);
		failure = { property: plan.property, error: tostring(writeError) };
		break;
	}

	const restored: string[] = [];
	const restoreFailures: Record<string, unknown>[] = [];
	if (failure !== undefined) {
		for (const plan of plans) {
			const result = results.get(plan.property)!;
			if (result.status === "valid") result.status = "not_attempted";
		}
		// Restore in reverse order, never overwriting a value that changed after our write.
		for (let i = applied.size() - 1; i >= 0; i--) {
			const entry = applied[i];
			const result = results.get(entry.property)!;
			const fail = (code: string, message: string, extra: Record<string, unknown> = {}) => {
				restoreFailures.push({ property: entry.property, code, error: message, ...extra });
				result.restoreStatus = code;
			};
			const [currentReadable, current] = pcall(() => inst[entry.property]);
			if (!entry.readable || !currentReadable) {
				fail("restore_unverifiable", `${entry.property} could not be read back, so it was left unchanged`);
				continue;
			}
			if (current !== entry.written) {
				fail("restore_conflict", `${entry.property} changed after it was written; left unchanged`, {
					written: jsonSafe(entry.written),
					current: jsonSafe(current),
					previous: jsonSafe(entry.previous),
				});
				continue;
			}
			const [restoredOk, restoreError] = pcall(() => {
				inst[entry.property] = entry.previous;
			});
			if (!restoredOk) {
				fail("restore_write_failed", tostring(restoreError), { previous: jsonSafe(entry.previous) });
				continue;
			}
			const [verifyReadable, verified] = pcall(() => inst[entry.property]);
			if (!verifyReadable || verified !== entry.previous) {
				fail("restore_unverified", `${entry.property} did not read back its previous value after restoring`, {
					previous: jsonSafe(entry.previous),
					current: verifyReadable ? jsonSafe(verified) : undefined,
				});
				continue;
			}
			restored.push(entry.property);
			result.restoreStatus = "restored";
		}
	}

	// Commit even after restoring: Cancel can undo earlier unrecorded edits.
	finishRecording(recordingId, true);

	const summary = { total: names.size(), invalid: 0, changed: changed.size(), restored: restored.size(), restoreFailures: restoreFailures.size() };
	if (failure === undefined) {
		return report({ success: true, phase: "apply", summary, results: orderedResults(), changed });
	}
	const rolledBack = restoreFailures.size() === 0;
	return report({
		success: false,
		phase: "apply",
		failedProperty: failure.property,
		error: rolledBack
			? `Writing ${failure.property} failed: ${failure.error}; every applied change was restored`
			: `Writing ${failure.property} failed: ${failure.error}; ${restoreFailures.size()} applied change(s) could not be restored`,
		summary,
		results: orderedResults(),
		changed,
		restored,
		restoreFailures,
		rolledBack,
	});
}

function setProperties(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const properties = requestData.properties as Record<string, unknown>;

	if (!instancePath || !properties || !typeIs(properties, "table")) {
		return { error: "Instance path and properties object are required" };
	}
	if (requestData.atomic === true) return setPropertiesAtomic(instancePath, properties, requestData.dryRun === true);
	if (requestData.dryRun === true) return { error: "dryRun requires atomic: true" };

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };

	const recordingId = beginRecording("Set multiple properties");
	const inst = instance as unknown as Record<string, unknown>;
	const results: Record<string, unknown>[] = [];
	let successCount = 0;
	let failureCount = 0;

	for (const [propName, propValue] of pairs(properties)) {
		const [success, err] = pcall(() => {
			if (propName === "Parent" || propName === "PrimaryPart") {
				if (!typeIs(propValue, "string")) error(`${propName} must be an instance path string (or an empty string to clear)`);
				if (propValue === "") {
					inst[propName as string] = undefined;
				} else {
					const refInstance = getInstanceByPath(propValue as string);
					if (!refInstance) error(`${propName} reference not found: ${propValue}`);
					inst[propName as string] = refInstance;
				}
			} else if (propName === "Name") {
				instance.Name = tostring(propValue);
			} else if (propName === "Source" && instance.IsA("LuaSourceContainer")) {
				if (!typeIs(propValue, "string")) error("Source must be a string");
				const result = applyScriptSource(instance as LuaSourceContainer, propValue as string);
				if (!result.success) error(result.error ?? "Script source update failed");
			} else {
				const converted = convertPropertyValue(instance, propName as string, propValue);
				inst[propName as string] = converted !== undefined ? converted : propValue;
			}
		});

		if (success) {
			successCount++;
			results.push({ property: propName, success: true });
		} else {
			failureCount++;
			const failure = { property: propName, success: false, error: tostring(err) };
			if (instance.IsA("StringValue") && propName === "Value" && typeIs(propValue, "string")) {
				results.push({
					...failure,
					details: { stage: "property_write", bytes: propValue.size(), limitBytes: STRING_VALUE_MAX_BYTES },
				});
			} else {
				results.push(failure);
			}
		}
	}

	// Without atomic this is not a rollback transaction. Cancel can undo earlier unrecorded
	// execute_luau edits as well, even when every assignment in this call failed.
	finishRecording(recordingId, true);

	return {
		success: failureCount === 0,
		instancePath,
		summary: { total: successCount + failureCount, succeeded: successCount, failed: failureCount },
		results,
	};
}

export = {
    setProperties,
};
