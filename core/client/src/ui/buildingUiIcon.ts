/**
 * Catalog icons live under `/icons/buildings/...` (own / white).
 * Build-menu UI uses black; enemy buildings on the map use orange;
 * ally buildings use blue.
 * Comm-status advanced view: online (teal) / offline (red).
 */
export type BuildingIconVariant =
  | "own"
  | "ally"
  | "enemy"
  | "ui"
  | "online"
  | "offline";

export function buildingIconSrc(
  catalogIcon: string,
  variant: BuildingIconVariant = "own",
): string {
  if (!catalogIcon.startsWith("/icons/buildings/")) return catalogIcon;
  if (variant === "enemy") {
    return catalogIcon.replace("/icons/buildings/", "/icons/buildings - orange/");
  }
  if (variant === "ally") {
    return catalogIcon.replace("/icons/buildings/", "/icons/buildings - blue/");
  }
  if (variant === "ui") {
    return catalogIcon.replace("/icons/buildings/", "/icons/buildings - black/");
  }
  if (variant === "online") {
    return catalogIcon.replace("/icons/buildings/", "/icons/buildings - online/");
  }
  if (variant === "offline") {
    return catalogIcon.replace("/icons/buildings/", "/icons/buildings - offline/");
  }
  return catalogIcon;
}

/** Build-menu / capital-pick UI: black variants. */
export function buildingUiIcon(catalogIcon: string): string {
  return buildingIconSrc(catalogIcon, "ui");
}
