/**
 * 敌方进攻联络线：一次只拆一段（正交 1 Du，对角 √2 ≈ 1.414 Du）。
 * 耗时与建造该段相同（E/10 秒，不足 1 秒立即完成）。服务端权威结算。
 */

import type { TerrainMap } from "../terrain/types.js";
import { roadRailTerrainSurchargeE } from "../terrain/placement.js";
import type { GridNode, LiaisonKind, PlacedLiaison } from "../buildings/liaison.js";
import {
  distancePointToSegment,
  pathLengthDu,
  previewLiaisonCostForLength,
  segmentKey,
  segmentLengthDu,
  splitPathRemovingSegments,
  withLiaisonTerrainSurcharge,
} from "../buildings/liaison.js";
import { attackOrganizationCost } from "./combat.js";
import { snapToUnitCoord } from "./garrison.js";
import { applyUnitMove, type MoveApplyResult, type MoveContext } from "./orders.js";
import type { UnitGroup, UnitMoveRequest } from "./types.js";

/** 到达判定：含反堆叠挪位（默认最远 2 Du）。 */
const LIAISON_CUT_ARRIVE_DU = 2.25;

export interface LiaisonSegmentTarget {
  liaisonId: string;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export interface LiaisonCutTickResult {
  units: UnitGroup[];
  liaisons: PlacedLiaison[];
}

function node(gx: number, gy: number): GridNode {
  return { gx, gy };
}

function cutDurationSec(
  kind: LiaisonKind,
  a: GridNode,
  b: GridNode,
  terrain: TerrainMap | null,
): number {
  const len = segmentLengthDu(a, b);
  const base = previewLiaisonCostForLength(kind, len);
  const surcharge =
    terrain && (kind === "road" || kind === "railway")
      ? roadRailTerrainSurchargeE(terrain, [a, b], kind)
      : 0;
  const cost = withLiaisonTerrainSurcharge(base, surcharge);
  return cost.durationTicks <= 0 ? 0 : cost.durationSec;
}

function findSegmentOnLine(
  line: PlacedLiaison,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { index: number; a: GridNode; b: GridNode } | null {
  const want = segmentKey(node(ax, ay), node(bx, by));
  for (let i = 1; i < line.nodes.length; i++) {
    const a = line.nodes[i - 1]!;
    const b = line.nodes[i]!;
    if (segmentKey(a, b) === want) return { index: i - 1, a, b };
  }
  return null;
}

function findCutSegment(
  lines: readonly PlacedLiaison[],
  cut: { liaisonId: string; ax: number; ay: number; bx: number; by: number },
): { line: PlacedLiaison; index: number; a: GridNode; b: GridNode } | null {
  const origin = lines.find((l) => l.id === cut.liaisonId);
  const pool = origin ? lines.filter((l) => l.ownerId === origin.ownerId) : lines;
  const preferred = pool.find((l) => l.id === cut.liaisonId);
  const ordered = preferred ? [preferred, ...pool.filter((l) => l.id !== preferred.id)] : pool;
  for (const line of ordered) {
    const hit = findSegmentOnLine(line, cut.ax, cut.ay, cut.bx, cut.by);
    if (hit) return { line, ...hit };
  }
  return null;
}

function cloneLine(line: PlacedLiaison): PlacedLiaison {
  return { ...line, nodes: line.nodes.map((n) => ({ ...n })) };
}

/** 从折线去掉一段；剩余部分按长度分摊 investedE。整段被拆光则删除该线。 */
export function removeLiaisonSegment(
  linesIn: readonly PlacedLiaison[],
  liaisonId: string,
  segmentIndex: number,
  nextId: () => string,
): { lines: PlacedLiaison[]; removed: boolean } {
  const lines = linesIn.map(cloneLine);
  const idx = lines.findIndex((l) => l.id === liaisonId);
  if (idx < 0) return { lines, removed: false };
  const line = lines[idx]!;
  if (segmentIndex < 0 || segmentIndex + 1 >= line.nodes.length) {
    return { lines, removed: false };
  }
  const a = line.nodes[segmentIndex]!;
  const b = line.nodes[segmentIndex + 1]!;
  const total = pathLengthDu(line.nodes);
  const frags = splitPathRemovingSegments(line.nodes, new Set([segmentKey(a, b)]));
  lines.splice(idx, 1);
  let at = idx;
  for (let i = 0; i < frags.length; i++) {
    const frag = frags[i]!;
    const fragLen = pathLengthDu(frag);
    const invested =
      total > 1e-9 ? Math.max(0, Math.floor((line.investedE * fragLen) / total)) : 0;
    lines.splice(at, 0, {
      id: i === 0 ? line.id : nextId(),
      kind: line.kind,
      ownerId: line.ownerId,
      nodes: frag.map((n) => ({ ...n })),
      investedE: invested,
      buildTicksRemaining: line.buildTicksRemaining,
      buildTicksTotal: line.buildTicksTotal,
      visionLevel: line.visionLevel,
    });
    at += 1;
  }
  return { lines, removed: true };
}

function idleAfterCut(unit: UnitGroup): UnitGroup {
  const cutting =
    unit.state === "fighting" && !unit.fightTargetUnitId && !unit.siegeBuildingId;
  if (!cutting) return { ...unit, liaisonCut: undefined };
  return {
    ...unit,
    state: "idle",
    liaisonCut: undefined,
    combatTimerSec: undefined,
    fightTargetUnitId: undefined,
  };
}

/**
 * 下令进攻敌方一段联络线：先调动到该段中点，到达后按建造耗时拆除。
 */
export function applyLiaisonAttack(
  req: UnitMoveRequest,
  ctx: MoveContext,
  target: LiaisonSegmentTarget,
): MoveApplyResult {
  const fail = (error: string): MoveApplyResult => ({
    ok: false,
    error,
    organizationCost: 0,
    energyCost: 0,
    buildings: ctx.buildings.map((b) => ({ ...b })),
    units: ctx.units.map((u) => ({ ...u, path: u.path?.map((p) => ({ ...p })) })),
    travelTimeSec: 0,
  });

  const line = ctx.liaisons.find((l) => l.id === target.liaisonId);
  if (!line) return fail("联络线不存在");
  if (line.ownerId === req.ownerId) return fail("不能进攻己方联络线");
  if ((line.buildTicksRemaining ?? 0) > 0) {
    return fail("联络线建造或升级中，不能作为进攻目标");
  }
  const seg = findSegmentOnLine(line, target.ax, target.ay, target.bx, target.by);
  if (!seg) return fail("只能进攻联络线上的一段");
  const len = segmentLengthDu(seg.a, seg.b);
  if (len + 1e-6 < 1 || len > Math.SQRT2 + 1e-6) {
    return fail("只能进攻 1–1.414 Du 的联络线");
  }

  const durationSec = cutDurationSec(line.kind, seg.a, seg.b, ctx.terrain);
  const mid = snapToUnitCoord((seg.a.gx + seg.b.gx) / 2, (seg.a.gy + seg.b.gy) / 2);
  const moved = applyUnitMove(
    {
      ...req,
      gx: mid.gx,
      gy: mid.gy,
      attackTargetUnitId: undefined,
      attackTargetBuildingId: undefined,
      asBlockade: false,
      asSupply: false,
      asTrainingDelivery: false,
      asHold: false,
    },
    ctx,
  );
  if (!moved.ok) return moved;

  const before = new Set(ctx.units.map((u) => u.id));
  const requested = new Set(req.unitIds ?? []);
  const cut = {
    liaisonId: line.id,
    ax: seg.a.gx,
    ay: seg.a.gy,
    bx: seg.b.gx,
    by: seg.b.gy,
    durationSec,
    elapsedSec: -1,
  };
  const units = moved.units.map((u) => {
    const involved = !before.has(u.id) || requested.has(u.id);
    if (!involved || u.ownerId !== req.ownerId) return u;
    return { ...u, liaisonCut: { ...cut } };
  });
  const kinds = units
    .filter((u) => u.liaisonCut && u.ownerId === req.ownerId && (!before.has(u.id) || requested.has(u.id)))
    .map((u) => u.kind);

  return {
    ...moved,
    units,
    organizationCost: attackOrganizationCost(kinds),
  };
}

function groupKey(cut: NonNullable<UnitGroup["liaisonCut"]>): string {
  return `${cut.ax},${cut.ay}-${cut.bx},${cut.by}`;
}

/**
 * 推进联络线拆除。elapsedSec < 0 的单位仍在行军；到达且靠近该段后开始计时。
 * 同一段共享一个计时，到时只拆除这一段。
 */
export function advanceLiaisonCuts(
  unitsIn: readonly UnitGroup[],
  liaisonsIn: readonly PlacedLiaison[],
  dtSec: number,
  nextId: () => string,
): LiaisonCutTickResult {
  const units: UnitGroup[] = unitsIn.map((u) => ({
    ...u,
    path: u.path?.map((p) => ({ ...p })),
    liaisonCut: u.liaisonCut ? { ...u.liaisonCut } : undefined,
  }));
  let liaisons = liaisonsIn.map(cloneLine);

  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    const cut = u.liaisonCut;
    if (!cut || cut.elapsedSec >= 0 || u.u <= 0) continue;
    if (u.state === "moving" || u.state === "training") continue;
    const seg = findCutSegment(liaisons, cut);
    const near =
      !!seg &&
      distancePointToSegment(u.gx, u.gy, seg.a, seg.b) <= LIAISON_CUT_ARRIVE_DU;
    const attackable =
      !!seg && seg.line.buildTicksRemaining <= 0 && seg.line.ownerId !== u.ownerId;
    if (u.state === "idle" && near && attackable) {
      units[i] = {
        ...u,
        state: "fighting",
        fightTargetUnitId: undefined,
        combatTimerSec: undefined,
        siegeBuildingId: undefined,
        siegeTimerSec: undefined,
        pendingAttackUnitId: undefined,
        pendingAttackBuildingId: undefined,
        path: undefined,
        pathIndex: undefined,
        liaisonCut: { ...cut, elapsedSec: 0 },
      };
    } else {
      units[i] = { ...u, liaisonCut: undefined };
    }
  }

  const groups = new Map<string, number[]>();
  for (let i = 0; i < units.length; i++) {
    const cut = units[i]!.liaisonCut;
    if (!cut) continue;
    const key = groupKey(cut);
    const list = groups.get(key) ?? [];
    list.push(i);
    groups.set(key, list);
  }

  for (const idxs of groups.values()) {
    const sample = units[idxs[0]!]!.liaisonCut!;
    const seg = findCutSegment(liaisons, sample);
    if (!seg || seg.line.buildTicksRemaining > 0) {
      for (const i of idxs) units[i] = idleAfterCut(units[i]!);
      continue;
    }

    let maxElapsed = -1;
    for (const i of idxs) {
      const cut = units[i]!.liaisonCut!;
      if (cut.elapsedSec < 0) continue;
      cut.elapsedSec += dtSec;
      if (cut.elapsedSec > maxElapsed) maxElapsed = cut.elapsedSec;
    }
    if (maxElapsed < 0) continue;

    if (maxElapsed + 1e-9 >= sample.durationSec) {
      const removed = removeLiaisonSegment(liaisons, seg.line.id, seg.index, nextId);
      liaisons = removed.lines;
      for (const i of idxs) units[i] = idleAfterCut(units[i]!);
      continue;
    }

    for (const i of idxs) {
      const cut = units[i]!.liaisonCut!;
      if (cut.elapsedSec < 0) continue;
      units[i] = { ...units[i]!, liaisonCut: { ...cut, elapsedSec: maxElapsed } };
    }
  }

  return {
    units: units.filter((u) => u.u > 0),
    liaisons,
  };
}
