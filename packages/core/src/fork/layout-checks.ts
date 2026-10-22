// ui_layout report: one line per GUI element plus the problems an agent would
// otherwise need a screenshot to spot. Checks compare siblings and parents
// only, skip hidden elements, and are capped.

export interface LayoutNode {
  path: string;
  className: string;
  /** Index of the parent node, -1 for the root. */
  parent: number;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  hidden?: boolean;
  clips?: boolean;
  textFits?: boolean;
  truncates?: boolean;
}

const CONTAINERS = new Set(['ScreenGui', 'BillboardGui', 'SurfaceGui', 'PlayerGui', 'StarterGui', 'Folder']);
const MAX_ISSUES = 20;
const MAX_SIBLINGS_COMPARED = 60;
/** Sub-pixel rounding in AbsolutePosition is not a layout bug. */
const TOLERANCE_PX = 1;

function isBox(node: LayoutNode | undefined): node is LayoutNode {
  return !!node && !CONTAINERS.has(node.className) && !node.hidden && node.w > 0 && node.h > 0;
}

function overflow(child: LayoutNode, parent: LayoutNode): number {
  return Math.max(
    parent.x - child.x,
    parent.y - child.y,
    child.x + child.w - (parent.x + parent.w),
    child.y + child.h - (parent.y + parent.h),
  );
}

function contains(outer: LayoutNode, inner: LayoutNode): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

/** Problems found in the layout, most useful first. */
export function layoutIssues(nodes: readonly LayoutNode[]): string[] {
  const issues: string[] = [];
  const children = new Map<number, LayoutNode[]>();
  // An element sticking out of its parent also overlaps its siblings; report the cause once.
  const outside = new Set<LayoutNode>();
  for (const node of nodes) {
    if (node.hidden) continue;
    if (node.textFits === false) issues.push(`! ${node.path} text ${node.truncates ? 'truncated' : 'clipped'}`);
    const parent = nodes[node.parent];
    if (isBox(node) && isBox(parent)) {
      const by = overflow(node, parent);
      if (by > TOLERANCE_PX) {
        issues.push(`! ${node.path} outside ${parent.path} by ${by}px${parent.clips ? ' (clipped)' : ''}`);
        outside.add(node);
      }
    }
    if (isBox(node)) {
      const siblings = children.get(node.parent) ?? [];
      siblings.push(node);
      children.set(node.parent, siblings);
    }
  }
  for (const siblings of children.values()) {
    const compared = siblings.slice(0, MAX_SIBLINGS_COMPARED);
    for (let i = 0; i < compared.length; i++) {
      for (let j = i + 1; j < compared.length; j++) {
        const a = compared[i];
        const b = compared[j];
        if (outside.has(a) || outside.has(b)) continue;
        const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        // Full containment is usually deliberate (backgrounds, overlays); partial overlap rarely is.
        if (w > TOLERANCE_PX && h > TOLERANCE_PX && !contains(a, b) && !contains(b, a)) {
          issues.push(`! ${a.path} overlaps ${b.path} by ${w}x${h}`);
        }
      }
    }
  }
  if (issues.length <= MAX_ISSUES) return issues;
  return [...issues.slice(0, MAX_ISSUES), `! … ${issues.length - MAX_ISSUES} more issues`];
}

function nodeLine(node: LayoutNode): string {
  const geometry = CONTAINERS.has(node.className) ? '' : ` ${node.x},${node.y} ${node.w}x${node.h} z${node.z}`;
  return `${node.path} ${node.className}${geometry}${node.hidden ? ' hidden' : ''}`;
}

export function layoutReport(nodes: readonly LayoutNode[], total: number, limit: number): string[] {
  const issues = layoutIssues(nodes);
  const lines = [...(issues.length > 0 ? issues : ['no layout issues']), ...nodes.slice(0, limit).map(nodeLine)];
  const shown = Math.min(limit, nodes.length);
  if (total > shown) lines.push(`… ${shown} of ${total} elements; raise limit or narrow gui_path`);
  return lines;
}
