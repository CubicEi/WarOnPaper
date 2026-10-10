/** Building catalog from rules §7. Icon paths use assets PNG filenames. */

import { durationSecToTicksCeil } from "../time.js";

export type BuildingCategory =
  | "settlement"
  | "command"
  | "military"
  | "transport"
  | "maritime"
  | "energy";

/** `<>` small · `<+>` medium · `◈` large */
export type BuildingSize = "small" | "medium" | "large";

export interface BuildingDef {
  id: string;
  name: string;
  category: BuildingCategory;
  /** Prerequisite building id; null = buildable from empty (空地). */
  prereq: string | null;
  /** Upgrade level cost from prereq (+N); null if not an upgrade. */
  upgradeLevels: number | null;
  hp?: number;
  /** Garrison / capacity U; omit when not applicable. */
  u?: number;
  /** 补给站等：储能上限 E；信息框显示绿色能源条。 */
  storeEMax?: number;
  /** 防空炮等：弹药上限（发）；信息框显示蓝色弹药条。 */
  ammoMax?: number;
  /** 臼炮系装填一次的能源消耗（E）。 */
  reloadE?: number;
  /** 单次攻击伤害 H。Infinity 表示无限（核导弹）。 */
  h?: number;
  /** 对单位的单次伤害（按单位 HP 折算减 U）。仅臼炮。 */
  unitH?: number;
  /** 补给站部署一步存入的能源（E）。 */
  deployStepE?: number;
  /** 工作半径 R（Du）。打开信息框时画出范围圈。 */
  workR?: number;
  size?: BuildingSize;
  /** Direct power production P (E/s when connected). */
  p?: number;
  /** Organization bonus added every 10 seconds. */
  orgBonus?: number;
  /** Raw resource output Raw-P (needs matching refinery to become E). */
  rawP?: number;
  /** Must sit on this resource kind to produce Raw-P. */
  requiresResource?: import("../terrain/types.js").ResourceKind;
  /** Which refinery converts this building's Raw-P → E. */
  refineVia?: "thermal" | "uranium";
  /** 其它 / 属性 / 功能说明 */
  notes?: string;
  flags?: {
    seaOnly?: boolean;
    lineBuild?: boolean;
    relocateOnly?: boolean;
    unique?: boolean;
    /** Skip size-based power drain (e.g. lines). */
    noPowerDrain?: boolean;
  };
  icon: string;
}

export const SIZE_LABEL: Record<BuildingSize, string> = {
  small: "<>",
  medium: "<+>",
  large: "◈",
};

export const SIZE_NAME: Record<BuildingSize, string> = {
  small: "小型",
  medium: "中型",
  large: "大型",
};

export const CATEGORY_LABEL: Record<BuildingCategory, string> = {
  settlement: "聚落",
  command: "指挥通信",
  military: "兵力",
  transport: "交通",
  maritime: "海上",
  energy: "能源",
};

/** 行动表：升级/建造 −10 E / 级 */
export const BUILD_E_PER_LEVEL = 10;

export function formatBuildDuration(sec: number): string {
  if (sec <= 0) return "立即完成";
  if (Number.isInteger(sec)) return `${sec} 秒`;
  return `${sec.toFixed(1)} 秒`;
}

export const BUILDINGS: BuildingDef[] = [
  // 7.1 聚落
  { id: "outpost", name: "哨站", category: "settlement", prereq: null, upgradeLevels: 2, hp: 2, u: 1, size: "small", icon: "/icons/buildings/settlement/outpost.png" },
  { id: "bunker", name: "碉堡", category: "settlement", prereq: "outpost", upgradeLevels: 2, hp: 4, u: 2, size: "small", icon: "/icons/buildings/settlement/bunker.png" },
  { id: "camp", name: "营地", category: "settlement", prereq: "bunker", upgradeLevels: 2, hp: 6, u: 3, size: "small", icon: "/icons/buildings/settlement/camp.png" },
  { id: "stronghold", name: "据点", category: "settlement", prereq: "camp", upgradeLevels: 4, hp: 10, u: 5, size: "small", icon: "/icons/buildings/settlement/stronghold.png" },
  { id: "commander", name: "指挥所", category: "settlement", prereq: "stronghold", upgradeLevels: 5, hp: 15, u: 8, size: "medium", orgBonus: 1, notes: "O +1", icon: "/icons/buildings/settlement/commander.png" },
  { id: "base", name: "基地", category: "settlement", prereq: "commander", upgradeLevels: 10, hp: 25, u: 12, size: "medium", icon: "/icons/buildings/settlement/base.png" },
  { id: "town", name: "市镇", category: "settlement", prereq: "base", upgradeLevels: 15, hp: 40, u: 15, size: "large", icon: "/icons/buildings/settlement/town.png" },
  { id: "city", name: "都市", category: "settlement", prereq: "town", upgradeLevels: 25, hp: 65, u: 15, size: "large", icon: "/icons/buildings/settlement/city.png" },
  { id: "metropolis", name: "首府", category: "settlement", prereq: "city", upgradeLevels: 35, hp: 100, u: 20, size: "large", notes: "可迁都（50 O）", icon: "/icons/buildings/settlement/metropolis.png" },
  { id: "capital", name: "首都", category: "settlement", prereq: null, upgradeLevels: null, hp: 120, u: 30, size: "large", p: 4, orgBonus: 3, notes: "P +4，O +3；仅迁都", flags: { relocateOnly: true }, icon: "/icons/buildings/settlement/capital.png" },

  // 7.2 指挥通信
  { id: "boardcast", name: "电台", category: "command", prereq: "outpost", upgradeLevels: 3, hp: 2, size: "small", workR: 6, notes: "R 6", icon: "/icons/buildings/command/boardcast.png" },
  { id: "radar", name: "雷达", category: "command", prereq: "boardcast", upgradeLevels: 5, hp: 5, size: "small", workR: 8, notes: "R 8", icon: "/icons/buildings/command/radar.png" },
  { id: "advanced_commander", name: "高级指挥所", category: "command", prereq: "commander", upgradeLevels: 10, hp: 20, u: 10, size: "medium", orgBonus: 2, notes: "O +2", icon: "/icons/buildings/command/advanced_commander.png" },
  { id: "boardcast_station", name: "广播站", category: "command", prereq: "advanced_commander", upgradeLevels: 10, hp: 15, u: 5, size: "medium", notes: "连接所有电台", icon: "/icons/buildings/command/boardcast_station.png" },
  { id: "regional_commander", name: "区域司令部", category: "command", prereq: "advanced_commander", upgradeLevels: 15, hp: 30, u: 12, size: "large", orgBonus: 3, notes: "O +3", icon: "/icons/buildings/command/regional_commander.png" },
  { id: "warzone_commander", name: "战区司令部", category: "command", prereq: "regional_commander", upgradeLevels: 25, hp: 50, u: 15, size: "large", orgBonus: 5, notes: "O +5", icon: "/icons/buildings/command/warzone_commander.png" },
  { id: "central_commander", name: "总司令部", category: "command", prereq: "warzone_commander", upgradeLevels: 40, hp: 75, u: 20, size: "large", orgBonus: 8, notes: "O +8；我方限一个", flags: { unique: true }, icon: "/icons/buildings/command/central_commander.png" },

  // 7.3 兵力
  { id: "port", name: "港口", category: "military", prereq: "camp", upgradeLevels: 9, hp: 12, u: 4, size: "large", workR: 8, notes: "须建在海岸线；U 4，R 8；可建造航母（容纳 3U 空军，500E）", icon: "/icons/buildings/military/port.png" },
  { id: "gun", name: "臼炮", category: "military", prereq: "camp", upgradeLevels: 4, hp: 8, size: "medium", workR: 5, ammoMax: 10, reloadE: 80, h: 2, unitH: 2, notes: "H 2 / 对单位 2，R 5，80E装填1发", icon: "/icons/buildings/military/gun.png" },
  { id: "anti-air_gun", name: "防空炮", category: "military", prereq: "gun", upgradeLevels: 5, hp: 12, size: "medium", workR: 5, ammoMax: 8, reloadE: 100, notes: "R 5；装填 100E。拦截导弹（不含臼炮）；对空军造成持续减 U", icon: "/icons/buildings/military/anti-air_gun.png" },
  { id: "missile", name: "导弹", category: "military", prereq: "gun", upgradeLevels: 5, hp: 10, size: "medium", workR: 8, ammoMax: 5, reloadE: 200, h: 5, notes: "H 5，R 8，200E装填1发", icon: "/icons/buildings/military/missile.png" },
  { id: "advenced_missile", name: "远程导弹", category: "military", prereq: "missile", upgradeLevels: 10, hp: 15, size: "medium", workR: 10, ammoMax: 5, reloadE: 600, h: 10, notes: "H 10，R 10，600E装填1发", icon: "/icons/buildings/military/advanced_missile.png" },
  { id: "nuke_missile", name: "核导弹", category: "military", prereq: "advenced_missile", upgradeLevels: 20, hp: 25, size: "large", workR: 15, ammoMax: 2, reloadE: 5000, h: Number.POSITIVE_INFINITY, notes: "H ∞，R 15；污染 R = 2；5000E装填1发；装填须已接入通信且正在开采的铀矿机与正在工作的铀工厂", icon: "/icons/buildings/military/nuke_missile.png" },
  { id: "barracks", name: "兵营", category: "military", prereq: "stronghold", upgradeLevels: 3, hp: 12, u: 8, size: "medium", notes: "Umax 8", icon: "/icons/buildings/military/barracks.png" },
  { id: "armor_barracks", name: "装甲营", category: "military", prereq: "base", upgradeLevels: 8, hp: 25, u: 12, size: "medium", notes: "Umax 12，容纳装甲单位", icon: "/icons/buildings/military/armor-barracks.png" },
  { id: "training_ground", name: "训练场", category: "military", prereq: "base", upgradeLevels: 2, hp: 20, size: "medium", notes: "步兵 25E、装甲 50E、海军 75E、空军 125E / U；用时 = E/20 秒", icon: "/icons/buildings/military/training_ground.png" },
  { id: "airport", name: "机场", category: "military", prereq: "base", upgradeLevels: 25, hp: 40, u: 8, size: "large", workR: 10, notes: "U 8，R 10", icon: "/icons/buildings/military/airport.png" },

  // 7.4 交通
  { id: "railway_station", name: "车站", category: "transport", prereq: "camp", upgradeLevels: 6, hp: 10, size: "medium", notes: "铁路起终点", icon: "/icons/buildings/transport/railway_station.png" },

  // 7.5 海上
  { id: "artificial_island", name: "人工岛", category: "maritime", prereq: null, upgradeLevels: 20, size: "large", notes: "不可摧毁；不可被选为攻击目标；可建造中型及以下建筑", flags: { seaOnly: true }, icon: "/icons/buildings/maritime/artificial_island.png" },

  // 7.6 能源
  { id: "supply_station", name: "补给站", category: "energy", prereq: "bunker", upgradeLevels: 1, hp: 4, size: "small", storeEMax: 50, deployStepE: 5, notes: "Emax 50；部署 5E", icon: "/icons/buildings/energy/supply_station.png" },
  { id: "lumber_mill", name: "伐木场", category: "energy", prereq: "camp", upgradeLevels: 2, hp: 6, size: "small", rawP: 1, requiresResource: "forest", refineVia: "thermal", notes: "Raw-P 1；须建在林地", icon: "/icons/buildings/energy/lumber_mill.png" },
  { id: "oil_well", name: "油井", category: "energy", prereq: "camp", upgradeLevels: 6, hp: 10, size: "medium", rawP: 2, requiresResource: "oil", refineVia: "thermal", notes: "Raw-P 2；须建在油田", icon: "/icons/buildings/energy/oil_well.png" },
  { id: "thermal_factory", name: "火力发电厂", category: "energy", prereq: "stronghold", upgradeLevels: 3, hp: 10, size: "medium", notes: "炼制伐木、石油等", icon: "/icons/buildings/energy/thermal_factory.png" },
  { id: "uranium_miner", name: "铀矿机", category: "energy", prereq: "stronghold", upgradeLevels: 5, hp: 10, size: "large", rawP: 3, requiresResource: "uranium", refineVia: "uranium", notes: "Raw-P 3；须建在铀矿", icon: "/icons/buildings/energy/uranium_miner.png" },
  { id: "uranium_factory", name: "铀工厂", category: "energy", prereq: "base", upgradeLevels: 10, hp: 20, size: "large", notes: "加工铀", icon: "/icons/buildings/energy/uranium_factory.png" },
];

export const BUILDING_BY_ID: Record<string, BuildingDef> = Object.fromEntries(
  BUILDINGS.map((b) => [b.id, b]),
);

/**
 * 从空地一路升到该建筑时，累计投入的等级（沿 prereq 链求和 upgradeLevels）。
 * 规则 §6：直接建造目标等级所需总 E = 累计等级 × 10。
 */
export function getInvestedLevels(buildingId: string | null): number {
  if (buildingId == null) return 0;
  let total = 0;
  let id: string | null = buildingId;
  const seen = new Set<string>();
  while (id) {
    if (seen.has(id)) break;
    seen.add(id);
    const b: BuildingDef | undefined = BUILDING_BY_ID[id];
    if (!b) break;
    total += b.upgradeLevels ?? 0;
    id = b.prereq;
  }
  return total;
}

/**
 * 本次建造/升级消耗的 E。
 * 规则：E =（直接建造目标所需总 E）−（当前已投入 E）
 *      = (目标累计等级 − 当前累计等级) × 10
 */
export function getBuildEnergyCost(
  target: BuildingDef,
  fromBuildingId: string | null = null,
): number {
  const delta =
    getInvestedLevels(target.id) - getInvestedLevels(fromBuildingId);
  return Math.max(0, delta) * BUILD_E_PER_LEVEL;
}

/**
 * 建造/升级耗时（秒）。
 * - 建造：小型立即完成；中型/大型为 E/10
 * - 升级：耗时 E/10；不足 1 秒立即完成
 */
export function getBuildDurationSec(
  building: BuildingDef,
  opts: { fromBuildingId: string | null },
): number {
  const fromEmpty = opts.fromBuildingId == null;
  const e = getBuildEnergyCost(building, opts.fromBuildingId);
  if (fromEmpty) {
    if (building.size === "small" || building.size == null) return 0;
    return e / BUILD_E_PER_LEVEL;
  }
  const t = e / BUILD_E_PER_LEVEL;
  return t < 1 ? 0 : t;
}

export interface BuildTreeNode {
  building: BuildingDef;
  children: BuildTreeNode[];
}

export type GroundContext = "land" | "ocean" | "any";

/** Build-tree filtering options (e.g. platform limits like the artificial island). */
export interface BuildTreeOptions {
  /** Largest allowed building size (inclusive). Default: no limit. */
  maxSize?: BuildingSize;
  /** Exclude sea-only buildings (e.g. when building on an island platform). */
  excludeSeaOnly?: boolean;
}

const SIZE_RANK: Record<BuildingSize, number> = { small: 0, medium: 1, large: 2 };

function withinMaxSize(b: BuildingDef, maxSize?: BuildingSize): boolean {
  if (!maxSize) return true;
  const size = b.size ?? "small";
  return SIZE_RANK[size] <= SIZE_RANK[maxSize];
}

function isPlaceableRoot(b: BuildingDef, ground: GroundContext): boolean {
  if (b.flags?.relocateOnly || b.flags?.lineBuild) return false;
  if (b.prereq !== null) return false;
  if (b.flags?.seaOnly) return ground === "ocean" || ground === "any";
  // Resource-dependent buildings can be on ocean/land - actual resource check server-side
  if (b.requiresResource) return true;
  if (ground === "ocean") return false;
  return true;
}

export function getUpgradeTargets(
  currentId: string | null,
  ground: GroundContext = "land",
  options?: BuildTreeOptions,
): BuildingDef[] {
  return BUILDINGS.filter((b) => {
    if (b.flags?.relocateOnly || b.flags?.lineBuild) return false;
    if (options?.excludeSeaOnly && b.flags?.seaOnly) return false;
    if (!withinMaxSize(b, options?.maxSize)) return false;
    if (currentId === null) return isPlaceableRoot(b, ground);
    if (b.prereq !== currentId) return false;
    if (b.flags?.seaOnly && ground === "land") return false;
    return true;
  });
}

export function getBuildTree(
  currentId: string | null,
  ground: GroundContext = "land",
  options?: BuildTreeOptions,
): BuildTreeNode[] {
  const roots = getUpgradeTargets(currentId, ground, options);

  const buildNode = (b: BuildingDef): BuildTreeNode => ({
    building: b,
    children: getUpgradeTargets(b.id, ground, options).map(buildNode),
  });

  return roots.map(buildNode);
}

export function isSettlementMainline(b: BuildingDef): boolean {
  return b.category === "settlement" && !b.flags?.relocateOnly;
}

export interface SettlementSpineSeg {
  building: BuildingDef;
  branches: BuildTreeNode[];
}

export interface SettlementSpine {
  originBranches: BuildTreeNode[];
  spine: SettlementSpineSeg[];
}

export function extractSettlementSpine(roots: BuildTreeNode[]): SettlementSpine | null {
  const settlementRoots = roots.filter((r) => isSettlementMainline(r.building));
  const originBranches = roots.filter((r) => !isSettlementMainline(r.building));
  if (settlementRoots.length === 0) return null;

  let current: BuildTreeNode | undefined = settlementRoots[0];
  const extras = settlementRoots.slice(1);
  const spine: SettlementSpineSeg[] = [];

  while (current) {
    const next: BuildTreeNode | undefined = current.children.find((c) =>
      isSettlementMainline(c.building),
    );
    const branches = current.children.filter((c) => c !== next);
    spine.push({ building: current.building, branches });
    current = next;
  }

  return {
    originBranches: [...originBranches, ...extras],
    spine,
  };
}

/**
 * 发射冷却（秒）= 装填单发 E 成本 / 30。
 * 用于火箭军建筑与防空炮。
 */
export function launchCooldownSec(reloadE: number): number {
  if (!(reloadE > 0)) return 0;
  return reloadE / 30;
}

/** 发射冷却 tick 数（至少 1，当 reloadE > 0）。 */
export function launchCooldownTicks(reloadE: number): number {
  return durationSecToTicksCeil(launchCooldownSec(reloadE));
}

/** 是否仍处于发射冷却中（截止 tick 不含）。 */
export function isLaunchCoolingDown(
  building: { fireCooldownUntilTick?: number | null },
  tick: number,
): boolean {
  return (building.fireCooldownUntilTick ?? 0) > tick;
}

/** 写入发射冷却截止 tick；无 reloadE 时原样返回。 */
export function withLaunchCooldown<T extends { buildingId: string; fireCooldownUntilTick?: number }>(
  building: T,
  tick: number,
): T {
  const reloadE = BUILDING_BY_ID[building.buildingId]?.reloadE ?? 0;
  const cd = launchCooldownTicks(reloadE);
  if (cd <= 0) return building;
  return { ...building, fireCooldownUntilTick: tick + cd };
}
