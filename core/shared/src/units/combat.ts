import {
  UNIT_ATTACK_AIR_NAVY_O_COST,
  UNIT_ATTACK_LAND_O_COST,
  UNIT_BY_KIND,
  type UnitKind,
} from "./catalog.js";

/**
 * One unit-vs-unit combat round (规则交战公式).
 *
 * UA1 = floor((UA0 * HPA - dmgToA) / HPA)
 * UB1 = floor((UB0 * HPB - dmgToB) / HPB)
 *
 * 空军不受陆军/海军伤害：对方非空军时，对空军的伤害项为 0。
 * 单回合在同一 tick 内瞬时算完（≤2 tick 预算）。
 */
export function resolveCombatRound(
  ua0: number,
  kindA: UnitKind,
  ub0: number,
  kindB: UnitKind,
): { ua1: number; ub1: number } {
  const a0 = Math.max(0, Math.floor(ua0));
  const b0 = Math.max(0, Math.floor(ub0));
  if (a0 <= 0 || b0 <= 0) {
    return { ua1: a0, ub1: b0 };
  }

  const hpA = UNIT_BY_KIND[kindA].hp;
  const hpB = UNIT_BY_KIND[kindB].hp;
  const aIsAir = kindA === "air";
  const bIsAir = kindB === "air";

  // Damage term against a side is the opponent's U, unless the target is air
  // and the attacker is not air (空军无视陆海军).
  const dmgToA = aIsAir && !bIsAir ? 0 : b0;
  const dmgToB = bIsAir && !aIsAir ? 0 : a0;

  const ua1 = Math.max(0, Math.floor((a0 * hpA - dmgToA) / hpA));
  const ub1 = Math.max(0, Math.floor((b0 * hpB - dmgToB) / hpB));
  return { ua1, ub1 };
}

/** True when this kind deals no damage to air (陆/海军 vs 空军). */
export function cannotDamageAir(attackerKind: UnitKind): boolean {
  return attackerKind !== "air";
}

/** 单位对建筑：每节拍造成 U 点伤害。 */
export function siegeDamageFromUnits(u: number): number {
  return Math.max(0, Math.floor(u));
}

/** 建筑对单位：每节拍造成 ceil(U/3) 点伤害（按 U 数直接减编制）. */
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
