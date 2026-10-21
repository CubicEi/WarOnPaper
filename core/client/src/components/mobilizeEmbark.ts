import type { EmbarkedSortieSource, UnitGroup } from "@wop/shared";

/** Synthetic mobilize unit id for carrier hangar rows (not a real unit group id). */
export const EMBARK_MOBILIZE_PREFIX = "embark:";

export function embarkMobilizeRowKey(carrierId: string, homeBuildingId: string): string {
  return `${carrierId}|${homeBuildingId}`;
}

export function embarkMobilizeId(rowKey: string): string {
  return `${EMBARK_MOBILIZE_PREFIX}${rowKey}`;
}

export function parseEmbarkMobilizeId(
  id: string,
): { carrierId: string; homeBuildingId: string } | null {
  if (!id.startsWith(EMBARK_MOBILIZE_PREFIX)) return null;
  const rest = id.slice(EMBARK_MOBILIZE_PREFIX.length);
  const pipe = rest.indexOf("|");
  if (pipe < 0) return null;
  return {
    carrierId: rest.slice(0, pipe),
    homeBuildingId: rest.slice(pipe + 1),
  };
}

export function embarkedUForRow(
  units: readonly UnitGroup[],
  carrierId: string,
  homeBuildingId: string,
): number {
  const carrier = units.find((u) => u.id === carrierId);
  if (!carrier) return 0;
  const row = carrier.embarkedAirByHome?.find(
    (e) => e.homeBuildingId === homeBuildingId,
  );
  if (row) return row.u;
  if (carrier.embarkedAirHomeBuildingId === homeBuildingId) {
    return carrier.embarkedAirU ?? 0;
  }
  return 0;
}

export function splitMobilizeUnitIds(
  unitIds: readonly string[],
  units: readonly UnitGroup[],
): {
  fieldUnitIds: string[];
  embarkedSources: EmbarkedSortieSource[];
} {
  const fieldUnitIds: string[] = [];
  const embarkedSources: EmbarkedSortieSource[] = [];
  for (const id of unitIds) {
    const parsed = parseEmbarkMobilizeId(id);
    if (!parsed) {
      fieldUnitIds.push(id);
      continue;
    }
    const u = embarkedUForRow(units, parsed.carrierId, parsed.homeBuildingId);
    if (u > 0) {
      embarkedSources.push({
        carrierId: parsed.carrierId,
        homeBuildingId: parsed.homeBuildingId,
        u,
      });
    }
  }
  return { fieldUnitIds, embarkedSources };
}
