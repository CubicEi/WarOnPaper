import { BUILDING_BY_ID } from "@wop/shared";
import { buildingIconSrc, type BuildingIconVariant } from "../ui/buildingUiIcon";

const cache = new Map<string, HTMLImageElement | null>();

/** Load building icon for canvas; returns null until decoded. */
export function getBuildingIcon(
  buildingId: string,
  variant: BuildingIconVariant = "own",
): HTMLImageElement | null {
  const def = BUILDING_BY_ID[buildingId];
  if (!def) return null;
  const src = buildingIconSrc(def.icon, variant);
  if (cache.has(src)) return cache.get(src) ?? null;

  const img = new Image();
  cache.set(src, null);
  img.onload = () => cache.set(src, img);
  img.onerror = () => cache.set(src, null);
  img.src = src;
  return null;
}
