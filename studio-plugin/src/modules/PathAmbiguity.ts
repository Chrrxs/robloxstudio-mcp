import type { PathAmbiguity, PathResolution, PathTree } from "../types";

// Canonical instance paths address children by name, so siblings that share a
// name produce identical paths. This module resolves paths while reporting the
// first ambiguous segment, and marks emitted paths that cannot identify one
// instance. It is written against an injected tree so it can run outside Studio.

function findNamedChild<T extends defined>(tree: PathTree<T>, parent: T, name: string): [T | undefined, number] {
	let first: T | undefined;
	let count = 0;
	for (const child of tree.getChildren(parent)) {
		if (tree.getName(child) === name) {
			if (first === undefined) first = child;
			count++;
		}
	}
	return [first, count];
}

// Mirrors Utils.getInstanceByPath: the root segment prefers service lookup and
// later segments take the first child with a matching name. The resolved
// instance is returned even when ambiguous, so callers decide whether to refuse.
function resolvePath<T extends defined>(tree: PathTree<T>, parts: string[]): PathResolution<T> {
	if (parts.size() === 0) return { instance: tree.root };

	let ambiguity: PathAmbiguity | undefined;
	let current = tree.getService(parts[0]);
	if (current === undefined) {
		const [first, count] = findNamedChild(tree, tree.root, parts[0]);
		current = first;
		if (count > 1) {
			ambiguity = { segment: parts[0], parentPath: tree.getPath(tree.root), matchCount: count };
		}
	}

	for (let i = 1; i < parts.size(); i++) {
		if (current === undefined) break;
		const [first, count] = findNamedChild(tree, current, parts[i]);
		if (count > 1 && ambiguity === undefined) {
			ambiguity = { segment: parts[i], parentPath: tree.getPath(current), matchCount: count };
		}
		current = first;
	}

	return { instance: current, ambiguity };
}

// Returns a checker for one request. Sibling name counts and verdicts are
// cached per node, so marking many results under one parent stays linear.
function createAmbiguityChecker<T extends defined>(tree: PathTree<T>): (node: T) => boolean {
	const nameCounts = new Map<T, Map<string, number>>();
	const verdicts = new Map<T, boolean>();

	function countNamed(parent: T, name: string): number {
		let counts = nameCounts.get(parent);
		if (counts === undefined) {
			counts = new Map<string, number>();
			for (const child of tree.getChildren(parent)) {
				const childName = tree.getName(child);
				counts.set(childName, (counts.get(childName) ?? 0) + 1);
			}
			nameCounts.set(parent, counts);
		}
		return counts.get(name) ?? 0;
	}

	function segmentIsAmbiguous(node: T, parent: T): boolean {
		const name = tree.getName(node);
		if (parent === tree.root) {
			if (tree.isRootService(node)) return false;
			// A root segment that names a service resolves to that service,
			// never to this child.
			const service = tree.getService(name);
			if (service !== undefined && service !== node) return true;
		}
		return countNamed(parent, name) > 1;
	}

	return (node: T): boolean => {
		const visited: T[] = [];
		let result = false;
		let current = node;
		while (current !== tree.root) {
			const cached = verdicts.get(current);
			if (cached !== undefined) {
				result = cached;
				break;
			}
			const parent = tree.getParent(current);
			if (parent === undefined) break;
			visited.push(current);
			if (segmentIsAmbiguous(current, parent)) {
				result = true;
				break;
			}
			current = parent;
		}
		for (const visitedNode of visited) verdicts.set(visitedNode, result);
		return result;
	};
}

export = {
	resolvePath,
	createAmbiguityChecker,
};
