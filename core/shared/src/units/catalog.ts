/** Unit kinds and per-1U stats (规则 §4.1 / §4.4 / §1.1). */

export type UnitKind = "infantry" | "armor" | "navy" | "navy_carrier" | "air";

/** 停留 / 移动 / 驻守 / 封锁 / 交战 / 训练途中 / 停港 */
export type UnitState =
  | "idle"
  | "moving"
  | "holding"
  | "blockading"
  | "fighting"
  | "training"
  | "docked";

export interface UnitKindDef {
  kind: UnitKind;
  name: string;
  hp: number;
  /** Base move speed Du/s (overridden by road/rail when applicable). */
  speedDuPerS: number;
  visionR: number;
  /** Max carried E; null = no supply (air). */
  carryEMax: number | null;
  /** Du per 1E of carried supply; null = no supply. */
  duPerE: number | null;
  /** Armor cannot enter mountain. */
  mountainBlocked: boolean;
  /** Infantry mountain speed factor (0.5). */
  mountainSpeedFactor: number;
  iconIdle: string;
  iconMoving: string;
}

export const UNIT_COORD_STEP = 0.2;

/** 行动表：调动 −1 O / 组（每个派出建筑一组，每个已派出单位组各 1O） */
export const UNIT_MOVE_O_COST = 1;
/** 行动表：停止行军 −20 E、−3 O */
export const UNIT_STOP_E_COST = 20;
export const UNIT_STOP_O_COST = 3;

/** 封锁：进入 −5 O、−2 E/单位；之后每 5 秒 −2 E/单位；交战半径 R=2 */
export const UNIT_BLOCKADE_O_COST = 5;
export const UNIT_BLOCKADE_ENTER_E_PER_U = 2;
export const UNIT_BLOCKADE_UPKEEP_E_PER_U = 2;
export const UNIT_BLOCKADE_INTERVAL_SEC = 5;
export const UNIT_BLOCKADE_RADIUS = 2;
/** 单位对单位回合间隔 5s（单回合在 2 tick 内瞬时结算） */
export const UNIT_COMBAT_ROUND_INTERVAL_SEC = 5;

/** 行动表：补给 −1 O / 次（从补给站 storeE 补携行） */
export const UNIT_SUPPLY_O_COST = 1;
/** 单位 vs 建筑攻城节拍 5s：单位造成 U 伤害，建筑造成 ceil(U/3) */
export const UNIT_SIEGE_INTERVAL_SEC = 5;

/** 港口建造航母：2000E；母舰容纳 5U 空军（规则 §7.3） */
export const CARRIER_BUILD_E = 2000;
export const CARRIER_AIR_CAPACITY = 5;
export const CARRIER_SORTIE_RADIUS_DU = 8;
/** 机场空军部署上舰：−5 O / 次 */
export const CARRIER_DEPLOY_O_COST = 5;
/** 停港修舰：每 2 秒恢复 1 点舰体 HP */
export const CARRIER_DOCK_REPAIR_INTERVAL_SEC = 2;
/** 新建航母船体编制（海军 U） */
export const CARRIER_HULL_U = 1;

/** 进攻：陆军 2O；空军 / 海军 3O（一次命令） */
export const UNIT_ATTACK_LAND_O_COST = 2;
export const UNIT_ATTACK_AIR_NAVY_O_COST = 3;

/**
 * 驻守：进入 −5 O、−1 E/单位；之后每 5 秒 −1 E/单位。
 * （计划/实现口径；行动表若写 −3 O 以本常量为准。）
 */
export const UNIT_HOLD_O_COST = 5;
export const UNIT_HOLD_ENTER_E_PER_U = 1;
export const UNIT_HOLD_UPKEEP_E_PER_U = 1;
export const UNIT_HOLD_INTERVAL_SEC = 5;

/** 互防：建立 −2 O / 次 */
export const UNIT_MUTUAL_DEFENSE_O_COST = 2;

/** 占领后拆除：返还投入 E 的 50% */
export const UNIT_OCCUPY_DEMOLISH_REFUND_RATE = 0.5;

/** 公路 / 铁路移速盖过基础移速（§7.4）；光缆不加速。 */
export const ROAD_MOVE_SPEED = 0.8;
export const RAIL_MOVE_SPEED = 2;

export const UNIT_BY_KIND: Record<UnitKind, UnitKindDef> = {
  infantry: {
    kind: "infantry",
    name: "步兵",
    hp: 1,
    speedDuPerS: 0.25,
    visionR: 2,
    carryEMax: 5,
    duPerE: 15,
    mountainBlocked: false,
    mountainSpeedFactor: 0.5,
    iconIdle: "/icons/symbol/units/infantry_unit.png",
    iconMoving: "/icons/symbol/units/infantry_unit_moving.png",
  },
  armor: {
    kind: "armor",
    name: "装甲",
    hp: 3,
    speedDuPerS: 0.35,
    visionR: 4,
    carryEMax: 5,
    duPerE: 5,
    mountainBlocked: true,
    mountainSpeedFactor: 1,
    iconIdle: "/icons/symbol/units/armor_unit.png",
    iconMoving: "/icons/symbol/units/armor_unit_moving.png",
  },
  navy: {
    kind: "navy",
    name: "海军",
    hp: 2,
    speedDuPerS: 0.5,
    visionR: 4,
    carryEMax: 10,
    duPerE: 2,
    mountainBlocked: false,
    mountainSpeedFactor: 1,
    iconIdle: "/icons/symbol/units/navy_unit.png",
    iconMoving: "/icons/symbol/units/navy_unit_moving.png",
  },
  /** 母舰：单艘舰体 10HP；0.4 Du/s；港口 2000E 建造；容纳 5U 空军。 */
  navy_carrier: {
    kind: "navy_carrier",
    name: "母舰",
    hp: 10,
    speedDuPerS: 0.4,
    visionR: 4,
    carryEMax: 20,
    duPerE: 2,
    mountainBlocked: false,
    mountainSpeedFactor: 1,
    iconIdle: "/icons/symbol/units/navy_unit_with_carrier.png",
    iconMoving: "/icons/symbol/units/navy_unit_with_carrier_moving.png",
  },
  air: {
    kind: "air",
    name: "空军",
    hp: 3,
    speedDuPerS: 3,
    visionR: 8,
    carryEMax: null,
    duPerE: null,
    mountainBlocked: false,
    mountainSpeedFactor: 1,
    /** 无单独停留剪影资源时复用同一图标。 */
    iconIdle: "/icons/symbol/units/aircraft_unit.png",
    iconMoving: "/icons/symbol/units/aircraft_unit.png",
  },
};

/** Infer deploy kind from the source building. */
export function unitKindFromBuilding(buildingId: string): UnitKind | null {
  switch (buildingId) {
    case "armor_barracks":
      return "armor";
    case "port":
      return "navy";
    case "airport":
      return "air";
    case "barracks":
    case "outpost":
    case "bunker":
    case "camp":
    case "stronghold":
    case "commander":
    case "base":
    case "town":
    case "city":
    case "metropolis":
    case "capital":
    case "advanced_commander":
    case "boardcast_station":
    case "regional_commander":
    case "warzone_commander":
    case "central_commander":
    case "supply_station":
      return "infantry";
    default:
      return null;
  }
}

/**
 * 市镇及更高级聚落与首都：驻军不离城（计划后做 / §聚落）。
 * 不出现在选单位列表，也不能执行离开建筑的命令。
 */
export function garrisonLockedInBuilding(buildingId: string): boolean {
  return (
    buildingId === "town" ||
    buildingId === "city" ||
    buildingId === "metropolis" ||
    buildingId === "capital"
  );
}

export function isCarrierKind(kind: UnitKind): boolean {
  return kind === "navy_carrier";
}
