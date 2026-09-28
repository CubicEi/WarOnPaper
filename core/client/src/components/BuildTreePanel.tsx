import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type CSSProperties,
} from "react";
import {
  extractSettlementSpine,
  SIZE_NAME,
  getBuildEnergyCost,
  getBuildDurationSec,
  formatBuildDuration,
  type BuildTreeNode,
  type BuildingDef,
  type SettlementSpineSeg,
} from "@wop/shared";
import { buildingUiIcon } from "../ui/buildingUiIcon";

interface Props {
  roots: BuildTreeNode[];
  currentLabel: string;
  /** null = 空地，用于区分建造 / 升级耗时规则 */
  currentBuildingId?: string | null;
  /** When true, reverse BFS hide (~0.5s) before the overlay unmounts. */
  exiting?: boolean;
  onSelect?: (building: BuildingDef) => void;
}

type Axis = "horizontal" | "vertical";

/** Cell pitch — keeps relative node spacing fixed. */
const CELL_X = 80;
const CELL_Y = 92;
/** Minimum gap along the spine between settlement nodes (in cell units). */
const MIN_SPINE_GAP = 1.25;
/** Extra blank leaf slots between different parents' forests on the same side. */
const PARENT_FOREST_GAP = 1;

type GraphNode = {
  id: string;
  building: BuildingDef | null;
  label: string;
  spine: boolean;
};

type Edge = { from: string; to: string };

type WirePath = { key: string; d: string; revealIndex: number };

type Pos = { x: number; y: number };

/** Whole-tree reveal/hide finishes in this window (last node delay + anim). */
export const BUILD_TREE_REVEAL_MS = 500;
/** Per-node fade duration — keep in sync with `.spine-node-reveal/hide` in styles.css. */
const REVEAL_ANIM_MS = 360;

/**
 * BFS order from `__origin__` so the tree gradually appears along edges.
 * Index 0 = current building / empty land; children follow tree adjacency.
 */
function computeRevealOrder(nodes: GraphNode[], edges: Edge[]): Map<string, number> {
  const children = new Map<string, string[]>();
  for (const e of edges) {
    const list = children.get(e.from) ?? [];
    if (!list.includes(e.to)) list.push(e.to);
    children.set(e.from, list);
  }

  const order = new Map<string, number>();
  const queue: string[] = ["__origin__"];
  order.set("__origin__", 0);

  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const child of children.get(id) ?? []) {
      if (order.has(child)) continue;
      order.set(child, order.size);
      queue.push(child);
    }
  }

  for (const n of nodes) {
    if (!order.has(n.id)) order.set(n.id, order.size);
  }
  return order;
}

const LONG_CHAIN_ROOT_IDS = new Set([
  "gun",
  "boardcast",
  "advanced_commander",
]);

function isLongChain(node: BuildTreeNode): boolean {
  return LONG_CHAIN_ROOT_IDS.has(node.building.id);
}

function useLongerAxis(): Axis {
  const [axis, setAxis] = useState<Axis>(() =>
    typeof window !== "undefined" && window.innerWidth >= window.innerHeight
      ? "horizontal"
      : "vertical",
  );

  useEffect(() => {
    const update = () => {
      setAxis(window.innerWidth >= window.innerHeight ? "horizontal" : "vertical");
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return axis;
}

function splitBranches(branches: BuildTreeNode[]): {
  pos: BuildTreeNode[];
  neg: BuildTreeNode[];
} {
  const longOnes = branches.filter(isLongChain);
  const shortOnes = branches.filter((b) => !isLongChain(b));
  const pos: BuildTreeNode[] = [...longOnes];
  const neg: BuildTreeNode[] = [];

  if (longOnes.length === 0) {
    shortOnes.forEach((b, i) => {
      (i % 2 === 0 ? pos : neg).push(b);
    });
  } else {
    shortOnes.forEach((b, i) => {
      (i % 2 === 0 ? neg : pos).push(b);
    });
  }

  return { pos, neg };
}

/** Tidy subtree; does not emit edges (edges come from catalog prereq). */
function layoutSubtree(
  node: BuildTreeNode,
  depth: number,
  nextLeaf: { n: number },
  slots: Map<string, { depth: number; slot: number }>,
): { lo: number; hi: number } {
  if (node.children.length === 0) {
    const slot = nextLeaf.n++;
    slots.set(node.building.id, { depth, slot });
    return { lo: slot, hi: slot };
  }

  let lo = Infinity;
  let hi = -Infinity;
  for (const child of node.children) {
    const r = layoutSubtree(child, depth + 1, nextLeaf, slots);
    lo = Math.min(lo, r.lo);
    hi = Math.max(hi, r.hi);
  }
  const slot = (lo + hi) / 2;
  slots.set(node.building.id, { depth, slot });
  return { lo, hi };
}

function buildGraph(
  currentLabel: string,
  originBranches: BuildTreeNode[],
  spine: SettlementSpineSeg[],
): { nodes: GraphNode[]; edges: Edge[] } {
  const nodes: GraphNode[] = [
    { id: "__origin__", building: null, label: currentLabel, spine: true },
  ];

  for (const seg of spine) {
    nodes.push({
      id: seg.building.id,
      building: seg.building,
      label: seg.building.name,
      spine: true,
    });
  }

  const addTreeNodes = (node: BuildTreeNode) => {
    nodes.push({
      id: node.building.id,
      building: node.building,
      label: node.building.name,
      spine: false,
    });
    for (const c of node.children) addTreeNodes(c);
  };

  for (const b of originBranches) addTreeNodes(b);
  for (const seg of spine) {
    for (const b of seg.branches) addTreeNodes(b);
  }

  const ids = new Set(nodes.map((n) => n.id));
  const edges: Edge[] = [];

  // Spine chain
  if (spine.length > 0) {
    edges.push({ from: "__origin__", to: spine[0].building.id });
    for (let i = 0; i < spine.length - 1; i++) {
      edges.push({ from: spine[i].building.id, to: spine[i + 1].building.id });
    }
  }

  // Forest roots attached to current / empty origin
  for (const r of originBranches) {
    edges.push({ from: "__origin__", to: r.building.id });
  }

  // Upgrade edges strictly from catalog prereq
  for (const n of nodes) {
    if (!n.building) continue;
    const pre = n.building.prereq;
    if (pre && ids.has(pre)) edges.push({ from: pre, to: n.id });
  }

  return { nodes, edges };
}

/**
 * Fixed relative layout with global packing per side (no cross-parent overlap):
 * - horizontal: spine on y=0, branches grow ±y, packed by global leaf slots on x
 * - vertical: spine on x=0, branches grow ±x, packed by global leaf slots on y
 */
function computePositions(
  axis: Axis,
  originBranches: BuildTreeNode[],
  spine: SettlementSpineSeg[],
): { positions: Map<string, Pos>; width: number; height: number } {
  const positions = new Map<string, Pos>();
  const isH = axis === "horizontal";

  type ParentGroup = { parentId: string; roots: BuildTreeNode[] };
  const spineParents: { parentId: string }[] = [
    { parentId: "__origin__" },
    ...spine.map((s) => ({ parentId: s.building.id })),
  ];

  const groupsFor = (side: "pos" | "neg"): ParentGroup[] => {
    const groups: ParentGroup[] = [];
    const { pos: oPos, neg: oNeg } = splitBranches(originBranches);
    groups.push({ parentId: "__origin__", roots: side === "pos" ? oPos : oNeg });
    for (const seg of spine) {
      const { pos, neg } = splitBranches(seg.branches);
      groups.push({ parentId: seg.building.id, roots: side === "pos" ? pos : neg });
    }
    return groups.filter((g) => g.roots.length > 0);
  };

  const posSign: 1 | -1 = isH ? -1 : 1;
  const negSign: 1 | -1 = isH ? 1 : -1;

  const ownedPos = new Map<string, string[]>();
  const ownedNeg = new Map<string, string[]>();

  const layoutSideOwned = (
    groups: ParentGroup[],
    sign: 1 | -1,
    ownedOut: Map<string, string[]>,
  ): Map<string, number> => {
    const parentIdeal = new Map<string, number>();
    if (groups.length === 0) return parentIdeal;

    const nextLeaf = { n: 0 };
    const slots = new Map<string, { depth: number; slot: number }>();

    for (const g of groups) {
      const ids: string[] = [];
      const collect = (n: BuildTreeNode) => {
        ids.push(n.building.id);
        n.children.forEach(collect);
      };
      g.roots.forEach(collect);
      ownedOut.set(g.parentId, ids);

      const childSlots: number[] = [];
      for (const root of g.roots) {
        layoutSubtree(root, 1, nextLeaf, slots);
        const s = slots.get(root.building.id);
        if (s) childSlots.push(s.slot);
      }
      if (childSlots.length > 0) {
        parentIdeal.set(
          g.parentId,
          (Math.min(...childSlots) + Math.max(...childSlots)) / 2,
        );
      }
      nextLeaf.n += PARENT_FOREST_GAP;
    }

    for (const [id, s] of slots) {
      const along = s.slot;
      const away = s.depth * sign;
      if (isH) positions.set(id, { x: along, y: away });
      else positions.set(id, { x: away, y: along });
    }

    return parentIdeal;
  };

  const idealPos = layoutSideOwned(groupsFor("pos"), posSign, ownedPos);
  const idealNeg = layoutSideOwned(groupsFor("neg"), negSign, ownedNeg);

  const spineAlong: number[] = [];
  for (let i = 0; i < spineParents.length; i++) {
    const id = spineParents[i].parentId;
    const a = idealPos.get(id);
    const b = idealNeg.get(id);
    let ideal: number | null = null;
    if (a != null && b != null) ideal = (a + b) / 2;
    else if (a != null) ideal = a;
    else if (b != null) ideal = b;

    if (i === 0) {
      spineAlong.push(ideal ?? 0);
    } else {
      const minNext = spineAlong[i - 1] + MIN_SPINE_GAP;
      spineAlong.push(ideal != null ? Math.max(minNext, ideal) : minNext);
    }
  }

  for (let i = 0; i < spineParents.length; i++) {
    const id = spineParents[i].parentId;
    const along = spineAlong[i];
    const idealA = idealPos.get(id);
    const idealB = idealNeg.get(id);

    if (idealA != null) {
      const delta = along - idealA;
      if (Math.abs(delta) > 1e-6) {
        for (const nid of ownedPos.get(id) ?? []) {
          const p = positions.get(nid);
          if (!p) continue;
          if (isH) positions.set(nid, { x: p.x + delta, y: p.y });
          else positions.set(nid, { x: p.x, y: p.y + delta });
        }
      }
    }
    if (idealB != null) {
      const delta = along - idealB;
      if (Math.abs(delta) > 1e-6) {
        for (const nid of ownedNeg.get(id) ?? []) {
          const p = positions.get(nid);
          if (!p) continue;
          if (isH) positions.set(nid, { x: p.x + delta, y: p.y });
          else positions.set(nid, { x: p.x, y: p.y + delta });
        }
      }
    }

    if (isH) positions.set(id, { x: along, y: 0 });
    else positions.set(id, { x: 0, y: along });
  }

  separateOverlaps(positions, isH);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of positions.values()) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) {
    minX = maxX = minY = maxY = 0;
  }

  for (const [id, p] of positions) {
    positions.set(id, { x: p.x - minX, y: p.y - minY });
  }

  const width = (maxX - minX) * CELL_X + CELL_X;
  const height = (maxY - minY) * CELL_Y + CELL_Y;

  return { positions, width, height };
}

/** Push nodes apart on each iso-line so centers stay ≥ 1 cell apart. */
function separateOverlaps(positions: Map<string, Pos>, isH: boolean): void {
  const MIN = 1;

  const bucketKey = (p: Pos) =>
    isH ? Math.round(p.y * 1000) / 1000 : Math.round(p.x * 1000) / 1000;

  const buckets = new Map<number, string[]>();
  for (const [id, p] of positions) {
    const k = bucketKey(p);
    const list = buckets.get(k) ?? [];
    list.push(id);
    buckets.set(k, list);
  }

  for (const ids of buckets.values()) {
    if (ids.length < 2) continue;
    ids.sort((a, b) => {
      const pa = positions.get(a)!;
      const pb = positions.get(b)!;
      return isH ? pa.x - pb.x : pa.y - pb.y;
    });

    for (let i = 1; i < ids.length; i++) {
      const prev = positions.get(ids[i - 1])!;
      const cur = positions.get(ids[i])!;
      if (isH) {
        const need = prev.x + MIN;
        if (cur.x < need) positions.set(ids[i], { x: need, y: cur.y });
      } else {
        const need = prev.y + MIN;
        if (cur.y < need) positions.set(ids[i], { x: cur.x, y: need });
      }
    }
  }
}

function toPx(pos: Pos): { left: number; top: number } {
  return {
    left: pos.x * CELL_X,
    top: pos.y * CELL_Y,
  };
}

function BuildingInfoPanel({
  building,
  fromBuildingId,
}: {
  building: BuildingDef;
  fromBuildingId: string | null;
}) {
  const energy = getBuildEnergyCost(building, fromBuildingId);
  const duration = getBuildDurationSec(building, { fromBuildingId });

  return (
    <div className="build-info-panel" role="dialog" aria-label={`${building.name} 信息`}>
      <div className="build-info-title">{building.name}</div>
      <div className="build-info-rows">
        {building.hp != null && (
          <div className="build-info-row">
            <span>HP</span>
            <span>{building.hp}</span>
          </div>
        )}
        <div className="build-info-row">
          <span>建造消耗</span>
          <span>{energy} E</span>
        </div>
        <div className="build-info-row">
          <span>所需时间</span>
          <span>{formatBuildDuration(duration)}</span>
        </div>
        {building.u != null && (
          <div className="build-info-row">
            <span>驻军单位</span>
            <span>{building.u}</span>
          </div>
        )}
        {building.size != null && (
          <div className="build-info-row">
            <span>规模</span>
            <span>{SIZE_NAME[building.size]}</span>
          </div>
        )}
        {building.flags?.unique && (
          <div className="build-info-row">
            <span>限制</span>
            <span>我方限一个</span>
          </div>
        )}
        {building.flags?.seaOnly && (
          <div className="build-info-row">
            <span>地形</span>
            <span>仅海上</span>
          </div>
        )}
      </div>
      {building.notes && (
        <div className="build-info-notes">
          <div className="build-info-notes-label">功能</div>
          <div className="build-info-notes-body">{building.notes}</div>
        </div>
      )}
    </div>
  );
}

function BuildingCard({
  building,
  spine,
  anchorId,
  selected,
  fromBuildingId,
  onOpen,
  onBuild,
}: {
  building: BuildingDef;
  spine?: boolean;
  anchorId: string;
  selected: boolean;
  fromBuildingId: string | null;
  onOpen: (building: BuildingDef) => void;
  onBuild: (building: BuildingDef) => void;
}) {
  return (
    <div className={`build-tree-card-wrap${selected ? " is-selected" : ""}`}>
      <button
        type="button"
        className={`build-tree-card${spine ? " build-tree-card-spine" : ""}${selected ? " is-dimmed" : ""}`}
        data-anchor={anchorId}
        title={
          building.upgradeLevels != null
            ? `${building.name} +${building.upgradeLevels}`
            : building.name
        }
        onClick={(e) => {
          e.stopPropagation();
          if (selected) {
            console.info("[wop:build-tree] confirm build", building.id, building.name);
            onBuild(building);
          } else {
            console.info("[wop:build-tree] select", building.id, building.name);
            onOpen(building);
          }
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          console.info("[wop:build-tree] double-click build", building.id, building.name);
          onBuild(building);
        }}
      >
        <span className="build-tree-card-icon">
          <img src={buildingUiIcon(building.icon)} alt="" draggable={false} />
          {selected && <span className="build-tree-card-build-hint">点击建造</span>}
        </span>
        <span className="build-tree-card-meta">
          <span className="build-tree-card-name">{building.name}</span>
          {building.upgradeLevels != null && (
            <span className="build-tree-card-cost">+{building.upgradeLevels}</span>
          )}
        </span>
      </button>
      {selected && (
        <div onClick={(e) => e.stopPropagation()}>
          <BuildingInfoPanel building={building} fromBuildingId={fromBuildingId} />
        </div>
      )}
    </div>
  );
}

function OriginCard({ label, anchorId }: { label: string; anchorId: string }) {
  return (
    <div
      className="build-tree-card build-tree-card-origin"
      data-anchor={anchorId}
      title={label}
    >
      <span className="build-tree-card-icon build-tree-card-icon-origin" />
      <span className="build-tree-card-meta">
        <span className="build-tree-card-name">{label}</span>
      </span>
    </div>
  );
}

/** Shorten segment so it stops at the icon circle, not the center. */
function clipToIcon(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  radius = 24,
): { x1: number; y1: number; x2: number; y2: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < radius * 2 + 1) return { x1, y1, x2, y2 };
  const ux = dx / len;
  const uy = dy / len;
  return {
    x1: x1 + ux * radius,
    y1: y1 + uy * radius,
    x2: x2 - ux * radius,
    y2: y2 - uy * radius,
  };
}

function SettlementSpineView({
  currentLabel,
  originBranches,
  spine,
  axis,
  fromBuildingId,
  exiting = false,
  onSelect,
}: {
  currentLabel: string;
  originBranches: BuildTreeNode[];
  spine: SettlementSpineSeg[];
  axis: Axis;
  fromBuildingId: string | null;
  exiting?: boolean;
  onSelect?: (building: BuildingDef) => void;
}) {
  const { nodes, edges } = useMemo(
    () => buildGraph(currentLabel, originBranches, spine),
    [currentLabel, originBranches, spine],
  );

  const revealOrder = useMemo(
    () => computeRevealOrder(nodes, edges),
    [nodes, edges],
  );
  const revealMaxIndex = useMemo(() => {
    let max = 0;
    for (const i of revealOrder.values()) if (i > max) max = i;
    return max;
  }, [revealOrder]);
  /** Enter: origin→leaves. Exit: leaves→origin (reverse BFS). */
  const staggerDelayMs = (index: number) => {
    if (revealMaxIndex <= 0) return 0;
    const span = BUILD_TREE_REVEAL_MS - REVEAL_ANIM_MS;
    const orderIndex = exiting ? revealMaxIndex - index : index;
    return (orderIndex / revealMaxIndex) * span;
  };
  const phaseClass = exiting ? "spine-hide" : "spine-reveal";

  const layout = useMemo(
    () => computePositions(axis, originBranches, spine),
    [axis, originBranches, spine],
  );

  const canvasRef = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<WirePath[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const measure = useCallback(() => {
    const root = canvasRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const centers = new Map<string, { x: number; y: number }>();

    root.querySelectorAll<HTMLElement>("[data-anchor]").forEach((el) => {
      const id = el.dataset.anchor;
      if (!id) return;
      const icon = el.querySelector(".build-tree-card-icon") ?? el;
      const r = icon.getBoundingClientRect();
      centers.set(id, {
        x: r.left + r.width / 2 - rootRect.left + root.scrollLeft,
        y: r.top + r.height / 2 - rootRect.top + root.scrollTop,
      });
    });

    const R = 24;
    const next: WirePath[] = [];
    const seen = new Set<string>();
    for (const e of edges) {
      const key = `${e.from}->${e.to}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const a = centers.get(e.from);
      const b = centers.get(e.to);
      if (!a || !b) continue;

      const x1 = a.x;
      const y1 = a.y;
      const x2 = b.x;
      const y2 = b.y;
      const revealIndex = revealOrder.get(e.to) ?? 0;

      if (Math.abs(x1 - x2) < 0.5 || Math.abs(y1 - y2) < 0.5) {
        const c = clipToIcon(x1, y1, x2, y2, R);
        next.push({
          key,
          d: `M ${c.x1} ${c.y1} L ${c.x2} ${c.y2}`,
          revealIndex,
        });
        continue;
      }

      const cx = axis === "horizontal" ? x2 : x1;
      const cy = axis === "horizontal" ? y1 : y2;
      const from = clipToIcon(x1, y1, cx, cy, R);
      const to = clipToIcon(cx, cy, x2, y2, R);
      next.push({
        key,
        d: `M ${from.x1} ${from.y1} L ${cx} ${cy} L ${to.x2} ${to.y2}`,
        revealIndex,
      });
    }
    setPaths(next);
  }, [edges, axis, revealOrder]);

  useLayoutEffect(() => {
    measure();
    const root = canvasRef.current;
    if (!root) return;

    const ro = new ResizeObserver(() => measure());
    ro.observe(root);
    const imgs = root.querySelectorAll("img");
    imgs.forEach((img) => {
      if (!img.complete) img.addEventListener("load", measure);
    });

    return () => {
      ro.disconnect();
      imgs.forEach((img) => img.removeEventListener("load", measure));
    };
  }, [measure, layout.width, layout.height, nodes, selectedId]);

  const isH = axis === "horizontal";

  const handleBuild = useCallback(
    (building: BuildingDef) => {
      onSelect?.(building);
      setSelectedId(null);
    },
    [onSelect],
  );

  return (
    <div
      className={`spine-dock spine-dock-${isH ? "h" : "v"}`}
      onClick={() => setSelectedId(null)}
    >
      <div
        ref={canvasRef}
        className="spine-canvas"
        style={{ width: layout.width, height: layout.height }}
      >
        <svg
          className="spine-wires"
          width={layout.width}
          height={layout.height}
          aria-hidden
        >
          {paths.map((p) => (
            <path
              key={p.key}
              d={p.d}
              className={`spine-wire ${phaseClass}`}
              style={
                {
                  "--reveal-delay": `${staggerDelayMs(p.revealIndex)}ms`,
                } as CSSProperties
              }
            />
          ))}
        </svg>

        {nodes.map((n) => {
          const cell = layout.positions.get(n.id);
          if (!cell) return null;
          const { left, top } = toPx(cell);
          const selected = selectedId === n.id;
          const revealIndex = revealOrder.get(n.id) ?? 0;
          return (
            <div
              key={n.id}
              className={`spine-node ${phaseClass}${selected ? " is-selected" : ""}`}
              style={
                {
                  left,
                  top,
                  width: CELL_X,
                  height: CELL_Y,
                  "--reveal-delay": `${staggerDelayMs(revealIndex)}ms`,
                } as CSSProperties
              }
            >
              {n.building ? (
                <BuildingCard
                  building={n.building}
                  spine={n.spine}
                  anchorId={n.id}
                  selected={selected}
                  fromBuildingId={fromBuildingId}
                  onOpen={(b) => setSelectedId(b.id)}
                  onBuild={handleBuild}
                />
              ) : (
                <OriginCard label={n.label} anchorId={n.id} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ForestFallback({
  roots,
  currentLabel,
  axis,
  fromBuildingId,
  exiting,
  onSelect,
}: {
  roots: BuildTreeNode[];
  currentLabel: string;
  axis: Axis;
  fromBuildingId: string | null;
  exiting?: boolean;
  onSelect?: (building: BuildingDef) => void;
}) {
  return (
    <SettlementSpineView
      currentLabel={currentLabel}
      originBranches={roots}
      spine={[]}
      axis={axis}
      fromBuildingId={fromBuildingId}
      exiting={exiting}
      onSelect={onSelect}
    />
  );
}

export function BuildTreePanel({
  roots,
  currentLabel,
  currentBuildingId = null,
  exiting = false,
  onSelect,
}: Props) {
  const axis = useLongerAxis();
  const settlement = useMemo(() => extractSettlementSpine(roots), [roots]);

  return (
    <div
      className={`build-tree-panel${settlement ? ` build-tree-panel-spine-${axis === "horizontal" ? "h" : "v"}` : ""}${exiting ? " is-exiting" : ""}`}
    >
      <div
        className={`build-tree-root-label${exiting ? " is-hiding" : ""}`}
      >
        从「{currentLabel}」可建造 / 升级
      </div>
      {roots.length === 0 ? (
        <div className="build-tree-empty">此处没有可建造的建筑</div>
      ) : settlement ? (
        <SettlementSpineView
          currentLabel={currentLabel}
          originBranches={settlement.originBranches}
          spine={settlement.spine}
          axis={axis}
          fromBuildingId={currentBuildingId}
          exiting={exiting}
          onSelect={onSelect}
        />
      ) : (
        <ForestFallback
          roots={roots}
          currentLabel={currentLabel}
          axis={axis}
          fromBuildingId={currentBuildingId}
          exiting={exiting}
          onSelect={onSelect}
        />
      )}
    </div>
  );
}
