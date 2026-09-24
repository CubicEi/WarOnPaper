import type { UnitKind, UnitState } from "./catalog.js";

/**
 * Runtime unit group (同一栋建筑派出的单位是一组).
 * Server-authoritative; clients receive filtered snapshots.
 */
export interface UnitGroup {
  id: string;
  ownerId: string;
  kind: UnitKind;
  /** Current U count in this group. */
  u: number;
  /** Grid coords, snapped to 0.2. */
  gx: number;
  gy: number;
  /**
   * Per-U carried supply fill (air stays 0).
   * Move spends `distance / duPerE` per U; resupply tops up from supply_station storeE.
   */
  carriedE: number;
  state: UnitState;
  /** Building this group deployed from (air home / return target). */
  homeBuildingId: string;
  /**
   * Waypoints for current move (including current position as path[0] optional).
   * Empty when idle.
   */
  path?: Array<{ gx: number; gy: number }>;
  /** Index of next waypoint in `path` (moving toward path[pathIndex]). */
  pathIndex?: number;
  /**
   * When true, on reaching the end of the path deposit U into a building at
   * the destination (if any) and despawn. Used by training delivery.
   */
  depositOnArrival?: boolean;
  /** Prefer this building when depositing (training delivery / air return / retreat). */
  depositBuildingId?: string;
  /**
   * Set when a retreat home has started. Blocks other orders until the group
   * is deposited back into `homeBuildingId`.
   */
  retreating?: boolean;
  /**
   * Air forced retreat / task return: after arriving, optionally fly back to
   * `returnGx/returnGy` (直线返回出发地骨架).
   */
  returnGx?: number;
  returnGy?: number;
  /**
   * After finishing the current path, enter `blockading` (封锁).
   * Cleared if movement is interrupted before arrival.
   */
  pendingBlockade?: boolean;
  /**
   * After finishing the current path, resupply from a supply_station.
   * Cleared if movement is interrupted before arrival.
   */
  pendingSupply?: boolean;
  /** Prefer this supply_station instance when `pendingSupply` resolves. */
  supplyBuildingId?: string;
  /**
   * Seconds accumulated toward the next blockade upkeep / combat pulse (5s).
   * Only meaningful while `state === "blockading"`.
   */
  blockadeTimerSec?: number;
  /** After path finishes: engage this enemy unit group. */
  pendingAttackUnitId?: string;
  /** After path finishes: siege this enemy building. */
  pendingAttackBuildingId?: string;
  /** Active unit-vs-unit fight target. */
  fightTargetUnitId?: string;
  /** Active siege target building. */
  siegeBuildingId?: string;
  /** Timer toward next unit-vs-unit combat round (5s). */
  combatTimerSec?: number;
  /** Timer toward next siege pulse (5s). */
  siegeTimerSec?: number;
  /** Cumulative HP damage dealt this siege (for air >50% destroy). */
  siegeDamageDealt?: number;
  /** Cumulative HP damage dealt by air units this siege. */
  siegeAirDamageDealt?: number;
  /** After path finishes: enter holding for this building. */
  pendingHoldBuildingId?: string;
  /** Building currently held (驻守). */
  holdBuildingId?: string;
  /** Timer toward next hold upkeep pulse (5s). */
  holdTimerSec?: number;
  /**
   * Mutual-defense responder: building being defended, and home to return to.
   */
  mutualDefenseForBuildingId?: string;
  mutualDefenseHomeBuildingId?: string;
  /**
   * 航母（navy_carrier）上搭载的空军 U；上限 CARRIER_AIR_CAPACITY（3）。
   */
  embarkedAirU?: number;
  /** 机库空军所属机场（损毁时释放 awayOccupied）. */
  embarkedAirHomeBuildingId?: string;
  /**
   * 防空炮对空军的持续减 U 交战状态（§7.3）。
   * 离开范围后清除；弹药在进入时一次性扣 2。
   */
  aaEngagement?: {
    buildingId: string;
    /** U when engagement started（进入前 U）. */
    entryU: number;
    /** Fractional U damage accumulated since last whole-U drain. */
    damageAcc: number;
  };
  /**
   * 进攻敌方联络线的一段（1–1.414 Du）。
   * elapsedSec < 0：正在赶往该段；≥ 0：已到达并开始拆除计时。
   */
  liaisonCut?: {
    liaisonId: string;
    ax: number;
    ay: number;
    bx: number;
    by: number;
    durationSec: number;
    elapsedSec: number;
  };
  /** Present on viewer-filtered snapshots. */
  visionLevel?: "satellite" | "direct";
  /**
   * Enemy direct vision: strip u / HP-equivalent. Own and server keep full `u`.
   * When masked, `u` is 0 in the snapshot copy.
   */
  strengthHidden?: boolean;
}

export interface UnitMoveSource {
  /** Placed building instance id to deploy from. */
  buildingId: string;
  /** U to pull from that building (≥ 1). */
  u: number;
}

export interface UnitMoveRequest {
  ownerId: string;
  /** Target snapped to 0.2. */
  gx: number;
  gy: number;
  /** Deploy from buildings (creates new groups). */
  sources?: readonly UnitMoveSource[];
  /** Already-fielded unit group ids. */
  unitIds?: readonly string[];
  /**
   * Internal / training: mark state as training and deposit into building on arrival.
   */
  asTrainingDelivery?: boolean;
  depositOnArrival?: boolean;
  /** Building instance id to deposit into on arrival (training). */
  depositBuildingId?: string;
  /** 封锁：到达后进入 blockading，扣费由 apply 结果返回. */
  asBlockade?: boolean;
  /** 补给：到达补给站后从 storeE 补携行，扣 1O（由 apply 结果返回）. */
  asSupply?: boolean;
  /** 目标补给站 instance id（asSupply 时必填）. */
  supplyBuildingId?: string;
  /** 进攻：到达后交战/攻城. */
  attackTargetUnitId?: string;
  attackTargetBuildingId?: string;
  /** 驻守：到达后进入 holding. */
  asHold?: boolean;
  holdBuildingId?: string;
}
