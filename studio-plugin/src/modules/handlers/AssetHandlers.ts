import Utils from "../Utils";
import Recording from "../Recording";
import {
	sanitizeLoadedAsset,
	scanForbiddenImportedInstances,
	type AssetSanitizationOperations,
	type ImportedAssetInstance,
} from "../AssetSanitizationPolicy";

const AssetService = game.GetService("AssetService");
const ChangeHistoryService = game.GetService("ChangeHistoryService");
const Selection = game.GetService("Selection");

const { getInstancePath, getInstanceByPath } = Utils;
const { beginRecording, finishRecording } = Recording;

const THIRD_PARTY_ASSET_SETTING_HINT =
	'\nTo load public Creator Store assets that you do not own, enable "Allow Loading Third Party Assets" in Game Settings > Security.';

function destroyImportedRoot(root: Instance) {
	pcall(() => {
		root.Destroy();
	});
}

function formatAssetLoadFailure(assetId: number, loadError: unknown): string {
	const [settingReadable, allowInsertFreeAssets] = pcall(() => {
		return (AssetService as unknown as { AllowInsertFreeAssets: boolean }).AllowInsertFreeAssets;
	});
	const settingHint = settingReadable && allowInsertFreeAssets === true
		? ""
		: THIRD_PARTY_ASSET_SETTING_HINT;
	return `Failed to load asset ${assetId}: ${tostring(loadError)}${settingHint}`;
}

const sanitizationOperations: AssetSanitizationOperations = {
	forceUnparent: (root: ImportedAssetInstance) => {
		const instance = root as Instance;
		const [unparentedOk] = pcall(() => {
			instance.Parent = undefined;
		});
		return unparentedOk && instance.Parent === undefined;
	},
	destroy: (instance: ImportedAssetInstance) => {
		const [destroyed] = pcall(() => {
			(instance as Instance).Destroy();
		});
		return destroyed;
	},
};

function insertAsset(requestData: Record<string, unknown>) {
	const assetId = requestData.assetId as number;
	const parentPath = (requestData.parentPath as string) ?? "game.Workspace";
	const position = requestData.position as { x: number; y: number; z: number } | undefined;

	if (!assetId) {
		return { error: "assetId is required" };
	}

	const parentInstance = getInstanceByPath(parentPath);
	if (!parentInstance) {
		return { error: `Parent instance not found: ${parentPath}` };
	}

	const recordingId = beginRecording(`Insert asset ${assetId}`);

	let wrapperModel: Instance | undefined;
	const insertedInstances: Instance[] = [];
	const [insertSuccess, insertResult] = pcall(() => {
		const [loadSuccess, loadResult] = pcall(() => {
			return (AssetService as unknown as { LoadAssetAsync(id: number): Instance }).LoadAssetAsync(assetId);
		});
		if (!loadSuccess || !loadResult) {
			error(formatAssetLoadFailure(assetId, loadResult), 0);
		}
		const loadedWrapper = loadResult as Instance;
		wrapperModel = loadedWrapper;

		const sanitization = sanitizeLoadedAsset(loadedWrapper, sanitizationOperations);
		if (!sanitization.success) {
			error(sanitization.error ?? "Asset sanitization failed.", 0);
		}

		const children = loadedWrapper.GetChildren();

		// Position while every sanitized child is still contained by the
		// unparented wrapper. Nothing reaches the DataModel before verification.
		if (position) {
			const pos = new Vector3(position.x ?? 0, position.y ?? 0, position.z ?? 0);
			for (const inst of children) {
				if (inst.IsA("BasePart")) {
					inst.Position = pos;
				} else if (inst.IsA("Model")) {
					if (inst.PrimaryPart) {
						inst.PivotTo(new CFrame(pos));
					} else {
						const firstPart = inst.FindFirstChildWhichIsA("BasePart", true);
						if (firstPart) {
							inst.PivotTo(new CFrame(pos));
						}
					}
				}
			}
		}

		// This is the first point at which imported content is parented into
		// Studio. Both unlimited-depth scans have already passed.
		for (const child of children) {
			child.Parent = parentInstance;
			insertedInstances.push(child);
		}

		pcall(() => {
			Selection.Set(insertedInstances);
		});

		const resultInstances = insertedInstances.map((inst) => ({
			name: inst.Name,
			className: inst.ClassName,
			path: getInstancePath(inst),
		}));

		return {
			success: true,
			assetId,
			parentPath,
			insertedCount: insertedInstances.size(),
			instances: resultInstances,
			sanitization: {
				removedScriptCount: sanitization.removedScriptCount,
				removedPackageLinkCount: sanitization.removedPackageLinkCount,
				verifiedClean: true,
			},
		};
	});

	if (!insertSuccess) {
		// Roll back any partially-parented children if a later operation failed.
		for (const inserted of insertedInstances) {
			pcall(() => {
				inserted.Destroy();
			});
		}
	}

	if (wrapperModel) {
		pcall(() => {
			wrapperModel!.Destroy();
		});
	}

	finishRecording(recordingId, insertSuccess);

	if (!insertSuccess) {
		return { error: `Failed to insert asset ${assetId}: ${tostring(insertResult)}` };
	}

	return insertResult;
}

function previewAsset(requestData: Record<string, unknown>) {
	const assetId = requestData.assetId as number;
	const includeProperties = (requestData.includeProperties as boolean) ?? true;
	const maxDepth = (requestData.maxDepth as number) ?? 10;

	if (!assetId) {
		return { error: "assetId is required" };
	}

	const [loadSuccess, wrapperModel] = pcall(() => {
		return (AssetService as unknown as { LoadAssetAsync(id: number): Instance }).LoadAssetAsync(assetId);
	});

	if (!loadSuccess || !wrapperModel) {
		return { error: formatAssetLoadFailure(assetId, wrapperModel) };
	}

	// Previewed assets never enter the DataModel.
	const [unparentedOk] = pcall(() => {
		(wrapperModel as Instance).Parent = undefined;
	});
	if (!unparentedOk || (wrapperModel as Instance).Parent !== undefined) {
		destroyImportedRoot(wrapperModel as Instance);
		return { error: `Failed to keep asset ${assetId} unparented for preview` };
	}

	// Security and visual-capability tracking always scan the full descendant
	// hierarchy. maxDepth only affects the display tree below.
	let totalInstances = 0;
	const classCounts: Record<string, number> = {};
	let hasAnimations = false;
	let hasSounds = false;
	let hasParticles = false;
	let hasVfx = false;
	let hasDecalsOrTextures = false;
	let hasMeshes = false;
	let hasLights = false;
	let hasAttachments = false;

	function recordSummary(instance: Instance) {
		totalInstances++;
		const className = instance.ClassName;
		classCounts[className] = (classCounts[className] ?? 0) + 1;

		if (className === "Animation" || className === "AnimationController" || className === "Animator") hasAnimations = true;
		if (instance.IsA("Sound")) hasSounds = true;
		if (
			instance.IsA("ParticleEmitter") ||
			className === "Fire" ||
			className === "Smoke" ||
			className === "Sparkles"
		) {
			hasParticles = true;
			hasVfx = true;
		}
		if (instance.IsA("Beam") || instance.IsA("Trail")) hasVfx = true;
		if (instance.IsA("Decal") || instance.IsA("Texture")) hasDecalsOrTextures = true;
		if (instance.IsA("MeshPart") || instance.IsA("SpecialMesh")) hasMeshes = true;
		if (instance.IsA("Light")) hasLights = true;
		if (instance.IsA("Attachment")) hasAttachments = true;
	}

	recordSummary(wrapperModel as Instance);
	for (const descendant of (wrapperModel as Instance).GetDescendants()) {
		recordSummary(descendant);
	}
	const forbiddenScan = scanForbiddenImportedInstances(wrapperModel as Instance);

	function buildHierarchy(instance: Instance, depth: number): Record<string, unknown> {
		const className = instance.ClassName;

		const node: Record<string, unknown> = {
			name: instance.Name,
			className,
		};

		if (includeProperties) {
			const props: Record<string, unknown> = {};

			if (instance.IsA("BasePart")) {
				props.size = { x: instance.Size.X, y: instance.Size.Y, z: instance.Size.Z };
				props.position = { x: instance.Position.X, y: instance.Position.Y, z: instance.Position.Z };
				props.material = tostring(instance.Material);
				props.color = `${instance.Color.R}, ${instance.Color.G}, ${instance.Color.B}`;
				props.transparency = instance.Transparency;
				props.anchored = instance.Anchored;
			}

			if (instance.IsA("MeshPart")) {
				const meshPart = instance as MeshPart;
				props.meshId = meshPart.MeshId;
				props.textureId = meshPart.TextureID;
			}

			if (instance.IsA("Model")) {
				const model = instance as Model;
				if (model.PrimaryPart) {
					props.primaryPart = model.PrimaryPart.Name;
				}
			}

			if (className === "Decal" || className === "Texture") {
				const [ok, texId] = pcall(() => (instance as unknown as { Texture: string }).Texture);
				if (ok) props.texture = texId;
			}

			if (instance.IsA("Sound")) {
				props.soundId = (instance as Sound).SoundId;
			}

			// Only include props if there are any
			let hasProps = false;
			for (const _ of pairs(props)) {
				hasProps = true;
				break;
			}
			if (hasProps) {
				node.properties = props;
			}
		}

		if (depth < maxDepth) {
			const childNodes: Record<string, unknown>[] = [];
			for (const child of instance.GetChildren()) {
				childNodes.push(buildHierarchy(child, depth + 1));
			}
			if (childNodes.size() > 0) {
				node.children = childNodes;
			}
		} else {
			const childCount = instance.GetChildren().size();
			if (childCount > 0) {
				node.childCount = childCount;
				node.truncated = true;
			}
		}

		return node;
	}

	const [previewSuccess, previewResult] = pcall(() => {
		const hierarchyRoots: Record<string, unknown>[] = [];
		for (const child of (wrapperModel as Instance).GetChildren()) {
			hierarchyRoots.push(buildHierarchy(child, 0));
		}

		return {
			success: true,
			assetId,
			hierarchy: hierarchyRoots,
			summary: {
				totalInstances,
				classCounts,
				hasScripts: forbiddenScan.scripts.size() > 0,
				scriptCount: forbiddenScan.scripts.size(),
				hasPackageLinks: forbiddenScan.packageLinks.size() > 0,
				packageLinkCount: forbiddenScan.packageLinks.size(),
				hasAnimations,
				hasSounds,
				hasParticles,
				hasVfx,
				hasDecalsOrTextures,
				hasMeshes,
				hasLights,
				hasAttachments,
				securityScanDepth: "unlimited",
				scriptSourceExposed: false,
				insertPolicy: "All LuaSourceContainer and PackageLink instances are stripped and verified before insertion.",
			},
		};
	});

	pcall(() => {
		(wrapperModel as Instance).Destroy();
	});

	if (!previewSuccess) {
		return { error: `Failed to preview asset ${assetId}: ${tostring(previewResult)}` };
	}

	return previewResult;
}

export = {
	insertAsset,
	previewAsset,
};
