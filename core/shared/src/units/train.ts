import type { PlacedBuilding } from "../buildings/actions.js";
import { isBuildingComplete } from "../buildings/actions.js";
import { effectiveUmax } from "../buildings/levelUpgrade.js";
import { DT_SEC_PER_TICK, durationSecToTicks } from "../time.js";
import { unitKindFromBuilding, type UnitKind } from "./catalog.js";
import { occupiedGarrisonU } from "./garrison.js";
import type { UnitGroup } from "./types.js";

/** Trainable kinds (航母不走训练场). */
export type TrainableKind = "infantry" | "armor" | "navy" | "air";

/** 1U 训练 E 单价（相对初版 ×5）. */
export const TRAIN_E_PER_U: Record<TrainableKind, number> = {
  infantry: 25,
  armor: 50,
  navy: 75,
  air: 125,
};

/** 用时 = 总 E / TRAIN_DURATION_E_PER_SEC 秒. */
export const TRAIN_DURATION_E_PER_SEC = 20;

export const TRAINABLE_KINDS: readonly TrainableKind[] = [
  "infantry",
  "armor",
  "navy",
  "air",
];

export interface TrainingJob {
  id: string;
  kind: TrainableKind;
  /** U to produce and deliver. */
  u: number;
  targetBuildingId: string;
  ticksRemaining: number;
  ticksTotal: number;
}

export function isTrainableKind(kind: string): kind is TrainableKind {
  return (
    kind === "infantry" ||
    kind === "armor" ||
    kind === "navy" ||
    kind === "air"
  );
}

export function trainEnergyCost(kind: TrainableKind, u: number): number {
  if (u < 1) return 0;
  return TRAIN_E_PER_U[kind] * u;
}

export function trainDurationSec(kind: TrainableKind, u: number): number {
  return trainEnergyCost(kind, u) / TRAIN_DURATION_E_PER_SEC;
}

export function trainDurationTicks(kind: TrainableKind, u: number): number {
  const sec = trainDurationSec(kind, u);
  return sec < DT_SEC_PER_TICK ? 0 : durationSecToTicks(sec);
}

/** Whether this building can hold the given unit kind as garrison. */
export function buildingAcceptsUnitKind(
  buildingId: string,
  kind: UnitKind,
): boolean {
  return unitKindFromBuilding(buildingId) === kind;
}

export function garrisonCap(building: PlacedBuilding): number {
  return effectiveUmax(building);
}

/** Free slots = Umax − present − awayOccupied − (pending inbound handled separately). */
export function garrisonRoom(building: PlacedBuilding): number {
  const max = garrisonCap(building);
  if (max <= 0) return 0;
  return Math.max(0, max - occupiedGarrisonU(building));
}

/**
 * U already promised to `targetId` via training queue or in-transit delivery.
 */
export function pendingInboundU(
  targetId: string,
  buildings: readonly PlacedBuilding[],
  units: readonly UnitGroup[],
): number {
  let n = 0;
  for (const b of buildings) {
    for (const job of b.trainingQueue ?? []) {
      if (job.targetBuildingId === targetId) n += job.u;
    }
  }
  for (const u of units) {
    if (
      u.depositBuildingId === targetId &&
      (u.depositOnArrival || u.state === "training")
    ) {
      n += u.u;
    }
  }
  return n;
}

export function availableTrainingRoom(
  target: PlacedBuilding,
  buildings: readonly PlacedBuilding[],
  units: readonly UnitGroup[],
): number {
  return Math.max(0, garrisonRoom(target) - pendingInboundU(target.id, buildings, units));
}

export function isTrainingGround(buildingId: string): boolean {
  return buildingId === "training_ground";
}

/** Active / queued training kind on a training ground (all jobs must share it). */
export function trainingQueueKind(
  building: PlacedBuilding,
): TrainableKind | null {
  const q = building.trainingQueue;
  if (!q || q.length === 0) return null;
  return q[0]!.kind;
}

/** 0..1 progress of the head training job (0 = just started, 1 = done). */
export function trainingHeadProgress(building: PlacedBuilding): number {
  const head = building.trainingQueue?.[0];
  if (!head || head.ticksTotal <= 0) return 0;
  const done = head.ticksTotal - head.ticksRemaining;
  return Math.max(0, Math.min(1, done / head.ticksTotal));
}

export interface TrainingAllocation {
  targetBuildingId: string;
  u: number;
}

/**
 * Split `amount` U across targets in selection order, filling each target's
 * available room before moving to the next. Rejects (does not clamp) when
 * amount exceeds total free room or any target is invalid.
 */
export function allocateTrainingDeliveries(
  amount: number,
  targetIds: readonly string[],
  kind: TrainableKind,
  ownerId: string,
  buildings: readonly PlacedBuilding[],
  units: readonly UnitGroup[],
): { ok: true; allocations: TrainingAllocation[] } | { ok: false; error: string } {
  if (!isTrainableKind(kind)) {
    return { ok: false, error: "无法训练该兵种" };
  }
  const u = Math.floor(amount);
  if (!Number.isFinite(u) || u < 1) {
    return { ok: false, error: "训练数量至少为 1" };
  }
  if (targetIds.length === 0) {
    return { ok: false, error: "请选择至少一个目标建筑" };
  }

  const seen = new Set<string>();
  const orderedIds: string[] = [];
  for (const id of targetIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    orderedIds.push(id);
  }

  const rooms = new Map<string, number>();
  let totalRoom = 0;
  for (const tid of orderedIds) {
    const target = buildings.find((b) => b.id === tid);
    if (!target || target.ownerId !== ownerId) {
      return { ok: false, error: "目标建筑不存在或不属于你" };
    }
    if (!isBuildingComplete(target) && target.buildingId !== "capital") {
      return { ok: false, error: "目标建筑尚未建成" };
    }
    if (!buildingAcceptsUnitKind(target.buildingId, kind)) {
      return { ok: false, error: "目标建筑不能接收该兵种" };
    }
    if (garrisonCap(target) <= 0) {
      return { ok: false, error: "目标建筑没有驻军容量" };
    }
    const room = availableTrainingRoom(target, buildings, units);
    rooms.set(tid, room);
    totalRoom += room;
  }

  if (totalRoom < 1) {
    return { ok: false, error: "所选目标驻军已满" };
  }
  if (u > totalRoom) {
    return {
      ok: false,
      error: `目标空位不足（合计剩余 ${totalRoom} U，请求 ${u} U）`,
    };
  }

  // Greedy fill in selection order: each target gets min(remaining, its room).
  let remaining = u;
  const allocations: TrainingAllocation[] = [];
  for (const tid of orderedIds) {
    if (remaining <= 0) break;
    const room = rooms.get(tid) ?? 0;
    const take = Math.min(remaining, room);
    if (take > 0) {
      allocations.push({ targetBuildingId: tid, u: take });
      remaining -= take;
    }
  }
  if (remaining > 0 || allocations.length === 0) {
    return { ok: false, error: "无法按空位分配训练数量" };
  }
  return { ok: true, allocations };
}

export interface EnqueueTrainRequest {
  ownerId: string;
  sourceBuildingId: string;
  kind: TrainableKind;
  u: number;
  /**
   * Destination building ids. U is split by available room in this order
   * (one queue job per target with allocated U > 0).
   */
  targetBuildingIds?: readonly string[];
  /** @deprecated Prefer `targetBuildingIds`; still accepted as a single target. */
  targetBuildingId?: string;
  nextJobId: () => string;
}

export interface EnqueueTrainResult {
  ok: boolean;
  error?: string;
  energyCost: number;
  buildings: PlacedBuilding[];
  /** Per-target U after allocation (empty when rejected). */
  allocations?: TrainingAllocation[];
}

/**
 * Validate and append training job(s) to the source training ground queue.
 * Does not spend energy — caller deducts `energyCost`.
 * Same training ground may only train one kind at a time (queue must not mix kinds).
 *
 * Multi-target: one FIFO job per allocated target (same kind/timing formula per job's U).
 */
export function enqueueTraining(
  req: EnqueueTrainRequest,
  buildings: readonly PlacedBuilding[],
  units: readonly UnitGroup[],
): EnqueueTrainResult {
  const next = buildings.map((b) => ({
    ...b,
    trainingQueue: b.trainingQueue?.map((j) => ({ ...j })),
  }));

  const targetIds =
    req.targetBuildingIds && req.targetBuildingIds.length > 0
      ? [...req.targetBuildingIds]
      : req.targetBuildingId
        ? [req.targetBuildingId]
        : [];

  if (!isTrainableKind(req.kind)) {
    return { ok: false, error: "无法训练该兵种", energyCost: 0, buildings: next };
  }
  const amount = Math.floor(req.u);
  if (!Number.isFinite(amount) || amount < 1) {
    return { ok: false, error: "训练数量至少为 1", energyCost: 0, buildings: next };
  }

  const source = next.find((b) => b.id === req.sourceBuildingId);
  if (!source || source.ownerId !== req.ownerId) {
    return { ok: false, error: "训练场不存在或不属于你", energyCost: 0, buildings: next };
  }
  if (!isTrainingGround(source.buildingId)) {
    return { ok: false, error: "只能在训练场发起训练", energyCost: 0, buildings: next };
  }
  if (!isBuildingComplete(source)) {
    return { ok: false, error: "训练场尚未建成", energyCost: 0, buildings: next };
  }
  if (source.polluted) {
    return { ok: false, error: "污染区内建筑已失效，无法训练", energyCost: 0, buildings: next };
  }

  const existingKind = trainingQueueKind(source);
  if (existingKind != null && existingKind !== req.kind) {
    return {
      ok: false,
      error: `训练场正在训练${existingKind === "infantry" ? "步兵" : existingKind === "armor" ? "装甲" : existingKind === "navy" ? "海军" : "空军"}，不能混种`,
      energyCost: 0,
      buildings: next,
    };
  }

  const allocated = allocateTrainingDeliveries(
    amount,
    targetIds,
    req.kind,
    req.ownerId,
    next,
    units,
  );
  if (!allocated.ok) {
    return { ok: false, error: allocated.error, energyCost: 0, buildings: next };
  }

  const energyCost = trainEnergyCost(req.kind, amount);
  const jobs: TrainingJob[] = allocated.allocations.map((a) => {
    const ticks = trainDurationTicks(req.kind, a.u);
    return {
      id: req.nextJobId(),
      kind: req.kind,
      u: a.u,
      targetBuildingId: a.targetBuildingId,
      ticksRemaining: ticks,
      ticksTotal: ticks,
    };
  });
  source.trainingQueue = [...(source.trainingQueue ?? []), ...jobs];

  return {
    ok: true,
    energyCost,
    buildings: next,
    allocations: allocated.allocations,
  };
}

export interface CompletedTraining {
  sourceBuildingId: string;
  sourceGx: number;
  sourceGy: number;
  ownerId: string;
  job: TrainingJob;
}

/**
 * Advance training queues (FIFO: only the head of each queue ticks).
 * Returns completed jobs that should start delivery.
 */
export function advanceTrainingQueues(
  buildings: readonly PlacedBuilding[],
  ticks = 1,
): { buildings: PlacedBuilding[]; completed: CompletedTraining[] } {
  const next = buildings.map((b) => ({
    ...b,
    trainingQueue: b.trainingQueue?.map((j) => ({ ...j })),
  }));
  const completed: CompletedTraining[] = [];

  for (const b of next) {
    if (!isTrainingGround(b.buildingId)) continue;
    if (!isBuildingComplete(b)) continue;
    if (b.polluted) continue;
    const queue = b.trainingQueue;
    if (!queue || queue.length === 0) continue;

    let rem = ticks;
    while (rem > 0 && queue.length > 0) {
      const head = queue[0]!;
      if (head.ticksRemaining > rem) {
        head.ticksRemaining -= rem;
        rem = 0;
      } else {
        rem -= Math.max(0, head.ticksRemaining);
        head.ticksRemaining = 0;
        queue.shift();
        completed.push({
          sourceBuildingId: b.id,
          sourceGx: b.gx,
          sourceGy: b.gy,
          ownerId: b.ownerId,
          job: head,
        });
      }
    }
    if (queue.length === 0) b.trainingQueue = undefined;
  }

  return { buildings: next, completed };
}
