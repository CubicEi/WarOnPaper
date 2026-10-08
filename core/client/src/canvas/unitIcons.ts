import type { UnitKind } from "@wop/shared";
import { UNIT_BY_KIND, isMovingState } from "@wop/shared";
import type { UnitState } from "@wop/shared";

const cache = new Map<string, HTMLImageElement | null>();

function load(src: string): HTMLImageElement | null {
  if (cache.has(src)) return cache.get(src) ?? null;
  const img = new Image();
  cache.set(src, null);
  img.onload = () => cache.set(src, img);
  img.onerror = () => cache.set(src, null);
  img.src = src;
  return null;
}

export type UnitIconRelation = "own" | "ally" | "enemy";

function variantSrc(catalogSrc: string, relation: UnitIconRelation): string {
  if (relation === "enemy") {
    return catalogSrc.replace(
      "/icons/symbol/units/",
      "/icons/symbol/units - orange/",
    );
  }
  if (relation === "ally") {
    return catalogSrc.replace(
      "/icons/symbol/units/",
      "/icons/symbol/units - blue/",
    );
  }
  return catalogSrc;
}

export function getUnitIcon(
  kind: UnitKind,
  state: UnitState,
  enemyOrRelation: boolean | UnitIconRelation = false,
): HTMLImageElement | null {
  const def = UNIT_BY_KIND[kind];
  const moving = isMovingState(state);
  const relation: UnitIconRelation =
    typeof enemyOrRelation === "boolean"
      ? enemyOrRelation
        ? "enemy"
        : "own"
      : enemyOrRelation;
  const src = variantSrc(moving ? def.iconMoving : def.iconIdle, relation);
  return load(src);
}
