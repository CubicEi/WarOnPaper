/**
 * Catalog icons live under `/icons/buildings/...` (own / white).
 * Build-menu UI uses black; enemy buildings on the map use orange.
 */
export type BuildingIconVariant = "own" | "enemy" | "ui";

export function buildingIconSrc(
  catalogIcon: string,
  variant: BuildingIconVariant = "own",
): string {
  if (!catalogIcon.startsWith("/icons/buildings/")) return catalogIcon;
  if (variant === "enemy") {
    return catalogIcon.replace("/icons/buildings/", "/icons/buildings - orange/");
  }
  if (variant === "ui") {
    return catalogIcon.replace("/icons/buildings/", "/icons/buildings - black/");
  }
  return catalogIcon;
}

/** Build-menu / capital-pick UI: black variants. */
export function buildingUiIcon(catalogIcon: string): string {
  return buildingIconSrc(catalogIcon, "ui");
}
