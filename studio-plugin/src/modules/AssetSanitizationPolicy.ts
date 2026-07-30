export interface ImportedAssetInstance {
	IsA(className: string): boolean;
	GetDescendants(): ImportedAssetInstance[];
}

export interface ForbiddenImportScan {
	scripts: ImportedAssetInstance[];
	packageLinks: ImportedAssetInstance[];
}

export interface AssetSanitizationOperations {
	forceUnparent: (root: ImportedAssetInstance) => boolean;
	destroy: (instance: ImportedAssetInstance) => boolean;
}

export interface AssetSanitizationResult {
	success: boolean;
	removedScriptCount: number;
	removedPackageLinkCount: number;
	remainingScriptCount: number;
	remainingPackageLinkCount: number;
	error?: string;
}

function countInstances(instances: ImportedAssetInstance[]): number {
	let count = 0;
	for (const _instance of instances) count++;
	return count;
}

export function scanForbiddenImportedInstances(root: ImportedAssetInstance): ForbiddenImportScan {
	const scripts: ImportedAssetInstance[] = [];
	const packageLinks: ImportedAssetInstance[] = [];

	function inspect(instance: ImportedAssetInstance) {
		// IsA("LuaSourceContainer") covers Script, LocalScript, ModuleScript,
		// and any future script-bearing subclass. Names, source, creator,
		// reputation, and hierarchy depth are deliberately irrelevant.
		if (instance.IsA("LuaSourceContainer")) {
			scripts.push(instance);
		}
		if (instance.IsA("PackageLink")) {
			packageLinks.push(instance);
		}
	}

	inspect(root);
	// GetDescendants performs an engine-level, unlimited-depth traversal.
	// Never replace this security scan with a depth-limited tree walk.
	for (const descendant of root.GetDescendants()) {
		inspect(descendant);
	}

	return { scripts, packageLinks };
}

export function sanitizeLoadedAsset(
	root: ImportedAssetInstance,
	operations: AssetSanitizationOperations,
): AssetSanitizationResult {
	if (!operations.forceUnparent(root)) {
		operations.destroy(root);
		return {
			success: false,
			removedScriptCount: 0,
			removedPackageLinkCount: 0,
			remainingScriptCount: 0,
			remainingPackageLinkCount: 0,
			error: "Loaded asset could not be kept unparented for sanitization.",
		};
	}

	const firstScan = scanForbiddenImportedInstances(root);
	const firstScriptCount = countInstances(firstScan.scripts);
	const firstPackageLinkCount = countInstances(firstScan.packageLinks);

	// A forbidden root cannot be removed while preserving an import wrapper.
	// Destroy the whole load and fail closed.
	if (root.IsA("LuaSourceContainer") || root.IsA("PackageLink")) {
		const rootWasScript = root.IsA("LuaSourceContainer");
		const rootWasPackageLink = root.IsA("PackageLink");
		operations.destroy(root);
		return {
			success: false,
			removedScriptCount: firstScriptCount,
			removedPackageLinkCount: firstPackageLinkCount,
			remainingScriptCount: rootWasScript ? 1 : 0,
			remainingPackageLinkCount: rootWasPackageLink ? 1 : 0,
			error: "Loaded asset root is a forbidden executable or package-link instance.",
		};
	}

	let removedScriptCount = 0;
	for (const scriptInstance of firstScan.scripts) {
		if (operations.destroy(scriptInstance)) removedScriptCount++;
	}

	let removedPackageLinkCount = 0;
	for (const packageLink of firstScan.packageLinks) {
		if (operations.destroy(packageLink)) removedPackageLinkCount++;
	}

	// Mandatory second unlimited-depth scan. If any forbidden instance
	// survived, destroy the entire imported root and insert nothing.
	const verificationScan = scanForbiddenImportedInstances(root);
	const remainingScriptCount = countInstances(verificationScan.scripts);
	const remainingPackageLinkCount = countInstances(verificationScan.packageLinks);
	if (remainingScriptCount > 0 || remainingPackageLinkCount > 0) {
		operations.destroy(root);
		return {
			success: false,
			removedScriptCount,
			removedPackageLinkCount,
			remainingScriptCount,
			remainingPackageLinkCount,
			error: "Asset sanitization verification failed; the entire imported asset was destroyed.",
		};
	}

	return {
		success: true,
		removedScriptCount,
		removedPackageLinkCount,
		remainingScriptCount: 0,
		remainingPackageLinkCount: 0,
	};
}
