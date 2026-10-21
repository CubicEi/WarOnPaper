import {
  UNIT_ATTACK_AIR_NAVY_O_COST,
  UNIT_ATTACK_LAND_O_COST,
  UNIT_BY_KIND,
  type UnitKind,
} from "./catalog.js";
import {
  aggregateDamageU,
  applyRandomHpDamage,
  normalizeUHp,
} from "./unitHp.js";

/**
 * One unit-vs-unit combat round (规则交战公式).
 *
 * Field units track per-sub-unit HP; damage is applied as random 1-HP hits.
 * Garrison / anonymous stacks without `uHp` still use the legacy aggregate U formula.
 *
 * 空军不受陆军/海军伤害：对方非空军时，对空军的伤害项为 0。
 */
export function resolveCombatRound(
  ua0: number,
  kindA: UnitKind,
  ub0: number,
  kindB: UnitKind,
  hullHpA?: number,
  hullHpB?: number,
  uHpA?: number[],
  uHpB?: number[],
  random: () => number = Math.random,
): {
  ua1: number;
  ub1: number;
  hullHpA?: number;
  hullHpB?: number;
  uHpA?: number[];
  uHpB?: number[];
} {
  const a0 = Math.max(0, Math.floor(ua0));
  const b0 = Math.max(0, Math.floor(ub0));
  if (a0 <= 0 || b0 <= 0) {
    return {
      ua1: a0,
      ub1: b0,
      ...(kindA === "navy_carrier" ? { hullHpA: normalizedCarrierHullHp(hullHpA) } : {}),
      ...(kindB === "navy_carrier" ? { hullHpB: normalizedCarrierHullHp(hullHpB) } : {}),
      ...(kindA !== "navy_carrier" && a0 > 0
        ? { uHpA: normalizeUHp(a0, kindA, uHpA) }
        : {}),
      ...(kindB !== "navy_carrier" && b0 > 0
        ? { uHpB: normalizeUHp(b0, kindB, uHpB) }
        : {}),
    };
  }

  const aIsAir = kindA === "air";
  const bIsAir = kindB === "air";

  const dmgToA = aIsAir && !bIsAir ? 0 : b0;
  const dmgToB = bIsAir && !aIsAir ? 0 : a0;

  const nextA =
    kindA === "navy_carrier" || uHpA != null
      ? applyUnitDamage(a0, kindA, dmgToA, hullHpA, uHpA, random)
      : { u: aggregateDamageU(a0, kindA, dmgToA) };
  const nextB =
    kindB === "navy_carrier" || uHpB != null
      ? applyUnitDamage(b0, kindB, dmgToB, hullHpB, uHpB, random)
      : { u: aggregateDamageU(b0, kindB, dmgToB) };
  return {
    ua1: nextA.u,
    ub1: nextB.u,
    ...(nextA.hullHp != null ? { hullHpA: nextA.hullHp } : {}),
    ...(nextB.hullHp != null ? { hullHpB: nextB.hullHp } : {}),
    ...(nextA.uHp != null ? { uHpA: nextA.uHp } : {}),
    ...(nextB.uHp != null ? { uHpB: nextB.uHp } : {}),
  };
}

export interface UnitDamageResult {
  u: number;
  /** Present only for a carrier; older saves default to full hull HP. */
  hullHp?: number;
  /** Per-sub-unit HP for non-carriers when tracked. */
  uHp?: number[];
}

function normalizedCarrierHullHp(hullHp: number | undefined): number {
  const max = UNIT_BY_KIND.navy_carrier.hp;
  return Math.max(0, Math.min(max, hullHp ?? max));
}

/**
 * Apply raw HP damage. Carriers use hull HP; field units use random per-U hits
 * when `uHp` is provided, otherwise the legacy aggregate U formula.
 */
export function applyUnitDamage(
  u: number,
  kind: UnitKind,
  damage: number,
  hullHp?: number,
  uHp?: number[],
  random: () => number = Math.random,
): UnitDamageResult {
  const count = Math.max(0, Math.floor(u));
  if (kind === "navy_carrier") {
    const remainingHullHp = Math.max(
      0,
      normalizedCarrierHullHp(hullHp) - Math.max(0, damage),
    );
    return {
      u: remainingHullHp > 0 ? count : 0,
      hullHp: remainingHullHp,
    };
  }
  const hit = applyRandomHpDamage(count, kind, damage, uHp, random);
  return { u: hit.u, uHp: hit.uHp };
}

/** True when this kind deals no damage to air (陆/海军 vs 空军). */
export function cannotDamageAir(attackerKind: UnitKind): boolean {
  return attackerKind !== "air";
}

/** 单位对建筑：每节拍造成 U 点伤害。 */
export function siegeDamageFromUnits(u: number): number {
  return Math.max(0, Math.floor(u));
}

/** 建筑对单位：每节拍造成 ceil(U/3) 点 HP 伤害（随机落点，同野战 applyRandomHpDamage）. */
export function siegeDamageFromBuilding(u: number): number {
  return Math.ceil(Math.max(0, Math.floor(u)) / 3);
}

/** 进攻 O 花费：有空军/海军则 3，否则 2。 */
export function attackOrganizationCost(kinds: readonly UnitKind[]): number {
  for (const k of kinds) {
    if (k === "air" || k === "navy" || k === "navy_carrier") {
      return UNIT_ATTACK_AIR_NAVY_O_COST;
    }
  }
  return UNIT_ATTACK_LAND_O_COST;
}

export { hpPerU, totalUnitHp, departureMaxHp, normalizeUHp, fullUHp } from "./unitHp.js";
