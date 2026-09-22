import type { MapConfig } from "../map.js";
import {
  BUILDING_BY_ID,
  getBuildDurationSec,
  getBuildEnergyCost,
  getInvestedLevels,
  BUILD_E_PER_LEVEL,
  type BuildingDef,
  type GroundContext,
} from "./catalog.js";
import { UNIT_OCCUPY_DEMOLISH_REFUND_RATE } from "../units/catalog.js";

/** Keep in sync with `TICK_HZ` in index (avoid circular import). */
const TICKS_PER_SEC = 15;

/** 行动表：升级 / 建造 −2 O / 建筑 */
export const BUILD_O_COST = 2;
/** 行动表：拆除 −1 O / 次 */
export const DEMOLISH_O_COST = 1;
/** 装填 / 补给站部署：每次操作 −1 O（与数量无关）。 */
export const HOLD_ACTION_O_COST = 1;
/** 规则 §⑦：已建成建筑拆除 E 返还比例（再乘剩余 HP / 最大 HP） */
export const DEMOLISH_E_REFUND_RATE = 0.8;
/** 正在建造的建筑拆除时，返还已投入 E 的比例，不按 HP 折算 */
export const DEMOLISH_CONSTRUCTION_E_REFUND_RATE = 0.9;
/** 规则 §⑦：刚完成修复后不可拆除的秒数 */
export const DEMOLISH_LOCK_AFTER_REPAIR_SEC = 60;

/** 规则 §⑨：标准修复 6 E 修复 1 HP（相对初版 ×6） */
export const REPAIR_E_PER_HP = 6;
/** 规则 §⑨：首都修复消耗 E 为标准 5 倍 */
export const REPAIR_CAPITAL_E_MULTIPLIER = 5;
/** 规则 §⑨：标准修复用时 = E / 10 秒 */
export const REPAIR_DURATION_DIVISOR = 10;
/** 规则 §⑨：首都修复用时 = E / 25 秒 */
export const REPAIR_CAPITAL_DURATION_DIVISOR = 25;
/** 建造中断后「继续建造」：用时 = 修复公式用时 × 此倍数 */
export const CONTINUE_BUILD_DURATION_MULTIPLIER = 2;

export interface PlacedBuilding {
  id: string;
  buildingId: string;
  ownerId: string;
  /** Integer grid node (格点). */
  gx: number;
  gy: number;
  hp: number;
  hpMax: number;
  /**
   * 线性等级（雷达 / 港口 / 兵营 / 装甲营 / 机场）：建成后为 1，最高 10。
   * 其它建筑可省略（视为 1，不参与线性升级）。
   */
  level?: number;
  /**
   * Present garrison U（在营）. Cap is effective Umax（含线性等级）。
   * 兵营 / 装甲营建成时为 0；多数聚落建筑建成时填满 Umax。
   * Occupied slots = `u + (awayOccupiedU ?? 0)` ≤ Umax.
   */
  u: number;
  /**
   * U fielded from this building still occupying Umax（外出占用）.
   * Released on return / combat loss / destruction of those groups.
   */
  awayOccupiedU?: number;
  /** 补给站当前储能（E）；上限见 catalog.storeEMax。默认 0。 */
  storeE: number;
  /** 防空导弹当前弹药（发）；上限见 catalog.ammoMax。默认 0。 */
  ammo: number;
  /**
   * 训练场补员队列（仅 training_ground）。FIFO：队首计时，完成后调动送达目标。
   */
  trainingQueue?: import("../units/train.js").TrainingJob[];
  /** Total E invested in build/upgrades so far. */
  investedE: number;
  /** Ticks left until construction finishes; 0 = complete. */
  buildTicksRemaining: number;
  buildTicksTotal: number;
  /**
   * Set when construction takes HP damage: stops build-tick HP overwrite,
   * requires「继续建造」(repair costs, 2× duration) to finish.
   */
  constructionHalted?: boolean;
  /** Server tick when last repair completed; null = never repaired. */
  repairedAtTick?: number | null;
  /** Ticks left until repair finishes; 0/undefined = not repairing. */
  repairTicksRemaining?: number;
  repairTicksTotal?: number;
  /** HP at the moment repair started (for linear interpolation). */
  repairHpBefore?: number;
  /** Total HP to restore over the repair duration. */
  repairHpRestore?: number;
  /**
   * While upgrading a small/medium building, satellite still shows this id.
   * Cleared when construction finishes. Server-only truth; stripped/applied in filters.
   */
  satelliteBuildingId?: string | null;
  /** Present on viewer-filtered snapshots: how the viewer sees this building. */
  visionLevel?: "satellite" | "direct";
  /** Own incomplete buildings: true when out of vision and not road/rail-linked. */
  buildPaused?: boolean;
  /**
   * Mutual defense partner building instance id（互防）.
   * One partner each; cleared when engagement ends or relation cancelled.
   */
  mutualDefensePartnerId?: string;
  /**
   * Captured via siege at HP 0: owner already switched; demolish refunds 50% investedE,
   * or repair from 0. Cleared when repair starts or building is demolished.
   */
  capturePending?: boolean;
  /**
   * True when the building node sits inside a nuclear pollution zone.
   * Polluted buildings do not work (comms / production / train / radar / fire…);
   * only demolish is allowed. Synced by the server from pollutionZones.
   */
  polluted?: boolean;
}

/** 规则：非格点吸附到最近节点。 */
export function snapToBuildNode(
  gx: number,
  gy: number,
  map: Pick<MapConfig, "linesX" | "linesY">,
): { gx: number; gy: number } {
  const nx = Math.round(gx);
  const ny = Math.round(gy);
  return {
    gx: Math.min(map.linesX - 1, Math.max(0, nx)),
    gy: Math.min(map.linesY - 1, Math.max(0, ny)),
  };
}

export function nodeKey(gx: number, gy: number): string {
  return `${gx},${gy}`;
}

export function findBuildingAt(
  buildings: readonly PlacedBuilding[],
  gx: number,
  gy: number,
): PlacedBuilding | undefined {
  return buildings.find((b) => b.gx === gx && b.gy === gy);
}

/**
 * Click hit-test: building at (bx,by) if click in [bx±0.2] × [by±0.2].
 * Prefers the nearest building when several overlap the box.
 */
export function findBuildingNear(
  buildings: readonly PlacedBuilding[],
  gx: number,
  gy: number,
  radius = 0.2,
): PlacedBuilding | undefined {
  let best: PlacedBuilding | undefined;
  let bestDist = Infinity;
  for (const b of buildings) {
    if (Math.abs(b.gx - gx) > radius || Math.abs(b.gy - gy) > radius) continue;
    const d = Math.hypot(b.gx - gx, b.gy - gy);
    if (d < bestDist) {
      bestDist = d;
      best = b;
    }
  }
  return best;
}

export function isBuildingComplete(b: PlacedBuilding): boolean {
  return b.buildTicksRemaining <= 0;
}

/** 兵营 / 装甲营：建成时驻军为 0，需另行补员。 */
export function buildingStartsEmptyGarrison(buildingId: string): boolean {
  return buildingId === "barracks" || buildingId === "armor_barracks";
}

/** 放置或刚完工时的初始驻军 U。 */
export function initialBuildingGarrisonU(buildingId: string, complete: boolean): number {
  const max = BUILDING_BY_ID[buildingId]?.u ?? 0;
  if (max <= 0) return 0;
  if (buildingStartsEmptyGarrison(buildingId)) return 0;
  return complete ? max : 0;
}

/** HP = HP上限 × 已用时 / 总用时（建造中）. */
export function constructionHp(
  hpMax: number,
  ticksRemaining: number,
  ticksTotal: number,
): number {
  if (ticksTotal <= 0) return hpMax;
  const elapsed = ticksTotal - ticksRemaining;
  return Math.max(0, Math.min(hpMax, (hpMax * elapsed) / ticksTotal));
}

export function durationSecToTicks(sec: number): number {
  if (sec <= 0) return 0;
  return Math.max(1, Math.round(sec * TICKS_PER_SEC));
}

/** 规则 §⑨：修复中 HP = 修复前 HP + 预计修复 HP × 已用时 / 总用时. */
export function repairHp(
  hpBefore: number,
  hpRestore: number,
  hpMax: number,
  ticksRemaining: number,
  ticksTotal: number,
): number {
  if (ticksTotal <= 0) return Math.min(hpMax, hpBefore + hpRestore);
  const elapsed = ticksTotal - ticksRemaining;
  return Math.max(0, Math.min(hpMax, hpBefore + (hpRestore * elapsed) / ticksTotal));
}

export function isRepairing(b: PlacedBuilding): boolean {
  return (b.repairTicksRemaining ?? 0) > 0;
}

/** Incomplete building halted by HP damage; needs「继续建造」. */
export function needsContinueBuild(b: PlacedBuilding): boolean {
  return b.buildTicksRemaining > 0 && !!b.constructionHalted;
}

/**
 * Pause repair / halt construction so tick HP interpolation cannot undo damage.
 * Call before (or as part of) any building HP reduction.
 */
export function interruptBuildOrRepairOnDamage<T extends PlacedBuilding>(b: T): T {
  const next: T = { ...b };
  if ((next.repairTicksRemaining ?? 0) > 0) {
    next.repairTicksRemaining = 0;
    next.repairTicksTotal = 0;
    next.repairHpBefore = undefined;
    next.repairHpRestore = undefined;
  }
  if (next.buildTicksRemaining > 0) {
    next.constructionHalted = true;
  }
  return next;
}

/** Apply building HP damage and interrupt in-progress build/repair. */
export function applyBuildingHpDamage<T extends PlacedBuilding>(
  b: T,
  damage: number,
): T {
  const interrupted = interruptBuildOrRepairOnDamage(b);
  const hp = Number.isFinite(damage)
    ? Math.max(0, interrupted.hp - damage)
    : 0;
  return { ...interrupted, hp };
}

/**
 * True when HP reaching 0 should remove the building (not occupy):
 * was under construction or under repair at the moment of the hit.
 */
export function buildingHpZeroShouldDestroy(
  wasConstructing: boolean,
  wasRepairing: boolean,
): boolean {
  return wasConstructing || wasRepairing;
}

export interface RepairCostPreview {
  /** E to consume (REPAIR_E_PER_HP / HP standard; ×5 for capital). */
  energy: number;
  /** HP to restore (= missing HP). */
  hpRestore: number;
  durationSec: number;
  /** 0 = immediate completion (< 1 秒). */
  durationTicks: number;
}

/** 规则 §⑨：修复消耗与用时。E = 缺失 HP × REPAIR_E_PER_HP（首都再 ×5）；用时 = E/10（首都 E/25）。 */
export function previewRepairCost(building: PlacedBuilding): RepairCostPreview {
  const missing = Math.max(0, building.hpMax - building.hp);
  const isCapital = building.buildingId === "capital";
  const energy = missing * (isCapital ? REPAIR_CAPITAL_E_MULTIPLIER : 1) * REPAIR_E_PER_HP;
  const divisor = isCapital ? REPAIR_CAPITAL_DURATION_DIVISOR : REPAIR_DURATION_DIVISOR;
  const durationSec = energy / divisor;
  const durationTicks = durationSec < 1 ? 0 : durationSecToTicks(durationSec);
  return { energy, hpRestore: missing, durationSec, durationTicks };
}

/** 建造中断后续建：费用同修复，用时 = 修复公式 × CONTINUE_BUILD_DURATION_MULTIPLIER。 */
export function previewContinueBuildCost(building: PlacedBuilding): RepairCostPreview {
  const base = previewRepairCost(building);
  const durationSec = base.durationSec * CONTINUE_BUILD_DURATION_MULTIPLIER;
  const durationTicks = durationSec < 1 ? 0 : durationSecToTicks(durationSec);
  return { ...base, durationSec, durationTicks };
}

/** Whether `ancestorId` appears on the prereq chain of `descendantId` (inclusive). */
export function isBuildingAncestor(
  ancestorId: string,
  descendantId: string,
): boolean {
  let id: string | null = descendantId;
  const seen = new Set<string>();
  while (id) {
    if (seen.has(id)) return false;
    seen.add(id);
    if (id === ancestorId) return true;
    id = BUILDING_BY_ID[id]?.prereq ?? null;
  }
  return false;
}

export function canPlaceBuildingDef(
  def: BuildingDef,
  ground: GroundContext,
): boolean {
  if (def.flags?.relocateOnly || def.flags?.lineBuild) return false;
  if (def.flags?.seaOnly) return ground === "ocean" || ground === "any";
  // Resource-dependent buildings (oil_well, uranium_miner, lumber_mill) can be built
  // on ocean or land - actual resource check happens server-side
  if (def.requiresResource) return true;
  if (ground === "ocean") return false;
  return true;
}

export interface BuildCostPreview {
  energy: number;
  organization: number;
  durationSec: number;
  durationTicks: number;
}

export function previewBuildCost(
  target: BuildingDef,
  fromBuildingId: string | null,
): BuildCostPreview {
  const energy = getBuildEnergyCost(target, fromBuildingId);
  const durationSec = getBuildDurationSec(target, { fromBuildingId });
  return {
    energy,
    organization: BUILD_O_COST,
    durationSec,
    durationTicks: durationSecToTicks(durationSec),
  };
}

/** Expected invested E after reaching `buildingId` from empty. */
export function investedEForBuilding(buildingId: string): number {
  return getInvestedLevels(buildingId) * BUILD_E_PER_LEVEL;
}

/**
 * 规划中（尚未消耗建造时间）：全额返还已投入 E。
 * 建造中：返还已投入 E 的 90%，不按当前 HP 折算。
 * 占领后 HP0（capturePending）：返还已投入 E 的 50%。
 * 已建成：E返还 = (剩余 HP / 最大 HP) × 已投入 E × 80%。
 */
export function demolishEnergyRefund(building: PlacedBuilding): number {
  if (building.investedE <= 0) return 0;
  if (building.capturePending && building.hp <= 0) {
    return building.investedE * UNIT_OCCUPY_DEMOLISH_REFUND_RATE;
  }
  if (!isBuildingComplete(building)) {
    const planned =
      building.buildTicksTotal > 0 &&
      building.buildTicksRemaining >= building.buildTicksTotal;
    if (planned) return building.investedE;
    return building.investedE * DEMOLISH_CONSTRUCTION_E_REFUND_RATE;
  }
  if (building.hpMax <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, building.hp / building.hpMax));
  return ratio * building.investedE * DEMOLISH_E_REFUND_RATE;
}

/** Ticks after repair during which demolish is forbidden. */
export function demolishLockTicksAfterRepair(tickHz = TICKS_PER_SEC): number {
  return DEMOLISH_LOCK_AFTER_REPAIR_SEC * tickHz;
}

export function isDemolishLockedByRepair(
  building: PlacedBuilding,
  currentTick: number,
  tickHz = TICKS_PER_SEC,
): boolean {
  const at = building.repairedAtTick;
  if (at == null) return false;
  return currentTick - at < demolishLockTicksAfterRepair(tickHz);
}
