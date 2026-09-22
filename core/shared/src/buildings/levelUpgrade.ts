/**
 * 指定建筑的线性等级升级（与 prereq 链「变种升级」独立）。
 *
 * 规则：
 * - 建成后为 1 级，最高 10 级（可升 9 次）。
 * - 从等级 L 升到 L+1 消耗 (L+1)⁵ E（升到 2 花 32E，升到 3 花 243E … 升到 10 花 100000E）。
 * - HP / R / Umax：level 1 = catalog 基值，level 10 = 5×基值，中间线性插值。
 * - 升 maxHp 时当前 hp 同步增加差额。
 */

import { BUILDING_BY_ID } from "./catalog.js";
import type { PlacedBuilding } from "./actions.js";

/** 可线性升级的建筑 kind。 */
export const LINEAR_UPGRADE_BUILDING_IDS = [
  "radar",
  "port",
  "barracks",
  "armor_barracks",
  "airport",
] as const;

export type LinearUpgradeBuildingId = (typeof LINEAR_UPGRADE_BUILDING_IDS)[number];

export const LINEAR_UPGRADE_MIN_LEVEL = 1;
export const LINEAR_UPGRADE_MAX_LEVEL = 10;
/** 满级相对 1 级的属性倍率（HP / R / Umax）。 */
export const LINEAR_UPGRADE_MAX_STAT_MULT = 5;

const LINEAR_UPGRADE_SET = new Set<string>(LINEAR_UPGRADE_BUILDING_IDS);

/**
 * 罗马数字 I–X（下标 0 未用）。
 * 用 ASCII 以便宋体/SimSun 实绘；Unicode Ⅰ–Ⅹ 常回退到符号字体呈粗描边感。
 */
export const ROMAN_LEVEL: readonly string[] = [
  "",
  "I",
  "II",
  "III",
  "IV",
  "V",
  "VI",
  "VII",
  "VIII",
  "IX",
  "X",
];

export function supportsLinearUpgrade(buildingId: string): boolean {
  return LINEAR_UPGRADE_SET.has(buildingId);
}

export function buildingLevel(building: Pick<PlacedBuilding, "level" | "buildingId">): number {
  if (!supportsLinearUpgrade(building.buildingId)) return LINEAR_UPGRADE_MIN_LEVEL;
  const raw = building.level ?? LINEAR_UPGRADE_MIN_LEVEL;
  return Math.max(
    LINEAR_UPGRADE_MIN_LEVEL,
    Math.min(LINEAR_UPGRADE_MAX_LEVEL, Math.floor(raw)),
  );
}

/** 从当前等级 L 升到 L+1 的 E 费用 = (L+1)⁵。 */
export function linearUpgradeCostE(fromLevel: number): number {
  const L = Math.floor(fromLevel);
  if (L < LINEAR_UPGRADE_MIN_LEVEL || L >= LINEAR_UPGRADE_MAX_LEVEL) return 0;
  const next = L + 1;
  return next ** 5;
}

/**
 * 线性倍率：level 1 → 1，level 10 → LINEAR_UPGRADE_MAX_STAT_MULT。
 * t = (level - 1) / (max - 1)
 */
export function linearStatMultiplier(level: number): number {
  const L = Math.max(
    LINEAR_UPGRADE_MIN_LEVEL,
    Math.min(LINEAR_UPGRADE_MAX_LEVEL, Math.floor(level)),
  );
  if (LINEAR_UPGRADE_MAX_LEVEL <= LINEAR_UPGRADE_MIN_LEVEL) return 1;
  const t = (L - LINEAR_UPGRADE_MIN_LEVEL) / (LINEAR_UPGRADE_MAX_LEVEL - LINEAR_UPGRADE_MIN_LEVEL);
  return 1 + t * (LINEAR_UPGRADE_MAX_STAT_MULT - 1);
}

export function scaleStatLinear(base: number, level: number): number {
  return base * linearStatMultiplier(level);
}

/** HP / Umax 用四舍五入整数，至少为基值在 level1 时的值。 */
export function scaleIntStatLinear(base: number, level: number): number {
  if (base <= 0) return 0;
  return Math.max(1, Math.round(scaleStatLinear(base, level)));
}

export function catalogBaseHp(buildingId: string): number {
  return BUILDING_BY_ID[buildingId]?.hp ?? 0;
}

export function catalogBaseU(buildingId: string): number {
  return BUILDING_BY_ID[buildingId]?.u ?? 0;
}

export function catalogBaseWorkR(buildingId: string): number | undefined {
  return BUILDING_BY_ID[buildingId]?.workR;
}

export function effectiveHpMax(
  building: Pick<PlacedBuilding, "buildingId" | "level" | "hpMax">,
): number {
  const base = catalogBaseHp(building.buildingId);
  if (!supportsLinearUpgrade(building.buildingId) || base <= 0) {
    return building.hpMax > 0 ? building.hpMax : base;
  }
  return scaleIntStatLinear(base, buildingLevel(building));
}

export function effectiveUmax(
  building: Pick<PlacedBuilding, "buildingId" | "level">,
): number {
  const base = catalogBaseU(building.buildingId);
  if (base <= 0) return 0;
  if (!supportsLinearUpgrade(building.buildingId)) return base;
  return scaleIntStatLinear(base, buildingLevel(building));
}

export function effectiveWorkR(
  building: Pick<PlacedBuilding, "buildingId" | "level">,
): number | undefined {
  const base = catalogBaseWorkR(building.buildingId);
  if (base == null || base <= 0) return base;
  if (!supportsLinearUpgrade(building.buildingId)) return base;
  return scaleStatLinear(base, buildingLevel(building));
}

export function romanLevelLabel(level: number): string {
  const L = Math.floor(level);
  if (L < 1 || L > 10) return String(L);
  return ROMAN_LEVEL[L] ?? String(L);
}

export interface LinearUpgradePreview {
  fromLevel: number;
  toLevel: number;
  energy: number;
  /** Next level HP / R / Umax after upgrade. */
  nextHpMax: number;
  nextWorkR?: number;
  nextUmax: number;
  canUpgrade: boolean;
  reason?: string;
}

export function previewLinearUpgrade(
  building: PlacedBuilding,
): LinearUpgradePreview | null {
  if (!supportsLinearUpgrade(building.buildingId)) return null;
  const fromLevel = buildingLevel(building);
  const toLevel = fromLevel + 1;
  const energy = linearUpgradeCostE(fromLevel);
  const nextHpMax = scaleIntStatLinear(catalogBaseHp(building.buildingId), toLevel);
  const baseR = catalogBaseWorkR(building.buildingId);
  const nextWorkR =
    baseR != null && baseR > 0 ? scaleStatLinear(baseR, toLevel) : undefined;
  const nextUmax = scaleIntStatLinear(catalogBaseU(building.buildingId) || 0, toLevel);

  if (fromLevel >= LINEAR_UPGRADE_MAX_LEVEL) {
    return {
      fromLevel,
      toLevel: fromLevel,
      energy: 0,
      nextHpMax: effectiveHpMax(building),
      nextWorkR: effectiveWorkR(building),
      nextUmax: effectiveUmax(building),
      canUpgrade: false,
      reason: "已满级",
    };
  }
  return {
    fromLevel,
    toLevel,
    energy,
    nextHpMax,
    nextWorkR,
    nextUmax,
    canUpgrade: true,
  };
}

/**
 * 应用一级线性升级（不扣费；调用方负责扣 E）。
 * maxHp 增加时当前 hp 同步增加差额。
 */
export function applyLinearUpgrade(building: PlacedBuilding): PlacedBuilding | null {
  if (!supportsLinearUpgrade(building.buildingId)) return null;
  const fromLevel = buildingLevel(building);
  if (fromLevel >= LINEAR_UPGRADE_MAX_LEVEL) return null;
  const cost = linearUpgradeCostE(fromLevel);
  const toLevel = fromLevel + 1;
  const oldHpMax = effectiveHpMax(building);
  const newHpMax = scaleIntStatLinear(catalogBaseHp(building.buildingId), toLevel);
  const hpDelta = Math.max(0, newHpMax - oldHpMax);
  return {
    ...building,
    level: toLevel,
    hpMax: newHpMax,
    hp: building.hp + hpDelta,
    investedE: building.investedE + cost,
  };
}
