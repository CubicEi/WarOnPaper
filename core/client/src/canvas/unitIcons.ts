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

function variantSrc(catalogSrc: string, enemy: boolean): string {
  if (!enemy) return catalogSrc;
  return catalogSrc.replace("/icons/symbol/units/", "/icons/symbol/units - orange/");
}

export function getUnitIcon(
  kind: UnitKind,
  state: UnitState,
  enemy: boolean,
): HTMLImageElement | null {
  const def = UNIT_BY_KIND[kind];
  const moving = isMovingState(state);
  const src = variantSrc(moving ? def.iconMoving : def.iconIdle, enemy);
  return load(src);
}
