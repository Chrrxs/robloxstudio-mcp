// Script classes a caller can select with classFilter. Class names are
// compared exactly: "Script" must not also select LocalScript or ModuleScript.
// An omitted filter selects every LuaSourceContainer the corpus can read.
const SCRIPT_CLASS_FILTERS = ["Script", "LocalScript", "ModuleScript"];

function isScriptClassFilter(value: unknown): value is string {
	return typeIs(value, "string") && SCRIPT_CLASS_FILTERS.includes(value);
}

/** Returns an error message when classFilter is present but not a supported script class. */
function classFilterError(value: unknown): string | undefined {
	if (value === undefined || isScriptClassFilter(value)) return undefined;
	return `classFilter must be one of ${SCRIPT_CLASS_FILTERS.join(", ")}`;
}

function matchesClassFilter(className: string, classFilter: string | undefined): boolean {
	return classFilter === undefined || className === classFilter;
}

export = {
	SCRIPT_CLASS_FILTERS,
	classFilterError,
	matchesClassFilter,
};
