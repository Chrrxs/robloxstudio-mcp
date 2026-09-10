import Utils from "../Utils";
import Recording from "../Recording";

const { getInstanceByPath, convertPropertyValue } = Utils;
const { beginRecording, finishRecording } = Recording;

// Native StringValue rejects UTF-8 strings of 200000 bytes or more.
const STRING_VALUE_MAX_BYTES = 199999;

function setProperties(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const properties = requestData.properties as Record<string, unknown>;

	if (!instancePath || !properties || !typeIs(properties, "table")) {
		return { error: "Instance path and properties object are required" };
	}

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
				if (typeIs(propValue, "string")) {
					const refInstance = getInstanceByPath(propValue as string);
					if (!refInstance) error(`${propName} reference not found: ${propValue}`);
					inst[propName as string] = refInstance;
				}
			} else if (propName === "Name") {
				instance.Name = tostring(propValue);
			} else if (propName === "Source" && instance.IsA("LuaSourceContainer")) {
				(instance as unknown as { Source: string }).Source = tostring(propValue);
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

	// This tool is not a rollback transaction. Cancel can undo earlier unrecorded
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
