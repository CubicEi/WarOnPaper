import { UNIT_BY_KIND, type UnitKind } from "./catalog.js";
import type { UnitGroup } from "./types.js";

export function hpPerU(kind: UnitKind): number {
  return UNIT_BY_KIND[kind].hp;
}

/** Full-HP array for `count` sub-units (non-carrier). */
export function fullUHp(kind: UnitKind, count: number): number[] {
  const max = hpPerU(kind);
  const n = Math.max(0, Math.floor(count));
  return Array.from({ length: n }, () => max);
}

/**
 * Ensure `uHp` matches current U count; missing slots default to full HP per U.
 */
export function normalizeUHp(
  u: number,
  kind: UnitKind,
  uHp?: number[],
): number[] {
  if (kind === "navy_carrier") return [];
  const max = hpPerU(kind);
  const count = Math.max(0, Math.floor(u));
  if (!uHp || uHp.length === 0) {
    return fullUHp(kind, count);
  }
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const v = i < uHp.length ? uHp[i]! : max;
    out.push(Math.max(0, Math.min(max, Math.round(v))));
  }
  return out;
}

export function totalUnitHp(unit: Pick<UnitGroup, "kind" | "u" | "uHp" | "hullHp">): number {
  if (unit.kind === "navy_carrier") {
    const max = hpPerU(unit.kind);
    return Math.max(0, unit.hullHp ?? max);
  }
  const slots = normalizeUHp(unit.u, unit.kind, unit.uHp);
  return slots.reduce((s, h) => s + h, 0);
}

export function maxUnitHpForU(kind: UnitKind, u: number): number {
  if (kind === "navy_carrier") return hpPerU(kind);
  return Math.max(0, Math.floor(u)) * hpPerU(kind);
}

/** HP denominator for inspect HUD: departure U × hp per U. */
export function departureMaxHp(unit: Pick<UnitGroup, "kind" | "u" | "departureU">): number {
  const u0 = unit.departureU ?? unit.u;
  return maxUnitHpForU(unit.kind, u0);
}

export function unitNeedsHpRepair(
  unit: Pick<UnitGroup, "kind" | "u" | "uHp" | "hullHp">,
): boolean {
  if (unit.kind === "navy_carrier") {
    const max = hpPerU(unit.kind);
    return (unit.hullHp ?? max) < max;
  }
  const max = hpPerU(unit.kind);
  const slots = normalizeUHp(unit.u, unit.kind, unit.uHp);
  return slots.some((h) => h < max);
}

/** Legacy aggregate U loss (garrison without per-slot HP). */
export function aggregateDamageU(
  u: number,
  kind: UnitKind,
  damage: number,
): number {
  const count = Math.max(0, Math.floor(u));
  if (count <= 0) return 0;
  const hp = hpPerU(kind);
  return Math.max(0, Math.floor((count * hp - Math.max(0, damage)) / hp));
}

/**
 * Apply `damage` point-hits: each hit picks a random sub-unit and −1 HP;
 * a sub-unit at 0 HP is removed (U − 1).
 */
export function applyRandomHpDamage(
  u: number,
  kind: UnitKind,
  damage: number,
  uHp?: number[],
  random: () => number = Math.random,
): { u: number; uHp: number[] } {
  if (kind === "navy_carrier") {
    return { u: Math.max(0, Math.floor(u)), uHp: [] };
  }
  let slots = normalizeUHp(u, kind, uHp);
  const hits = Math.max(0, Math.floor(damage));
  for (let d = 0; d < hits; d++) {
    if (slots.length === 0) break;
    const idx = Math.floor(random() * slots.length);
    slots[idx]--;
    if (slots[idx] <= 0) {
      slots.splice(idx, 1);
    }
  }
  return { u: slots.length, uHp: slots };
}

/** Repair 1 HP on the lowest-HP slot (ties: lowest index). */
/** Trim or pad `uHp` when U changes without per-hit damage (e.g. legacy aggregate loss). */
export function syncUHpToCount(
  kind: UnitKind,
  prevU: number,
  nextU: number,
  uHp?: number[],
): number[] | undefined {
  if (kind === "navy_carrier") return undefined;
  const n = Math.max(0, Math.floor(nextU));
  if (n <= 0) return [];
  const slots = normalizeUHp(prevU, kind, uHp);
  if (slots.length > n) return slots.slice(0, n);
  if (slots.length < n) {
    return [...slots, ...fullUHp(kind, n - slots.length)];
  }
  return slots;
}

export function repairWorstSubUnit(
  u: number,
  kind: UnitKind,
  uHp?: number[],
): { u: number; uHp: number[]; repaired: boolean } {
  if (kind === "navy_carrier") {
    return { u, uHp: [], repaired: false };
  }
  const max = hpPerU(kind);
  const slots = normalizeUHp(u, kind, uHp);
  if (slots.length === 0) return { u: 0, uHp: [], repaired: false };
  let worst = 0;
  for (let i = 1; i < slots.length; i++) {
    if (slots[i]! < slots[worst]!) worst = i;
  }
  if (slots[worst]! >= max) {
    return { u: slots.length, uHp: slots, repaired: false };
  }
  const next = [...slots];
  next[worst] = Math.min(max, next[worst]! + 1);
  return { u: next.length, uHp: next, repaired: true };
}
