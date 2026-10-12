/**
 * Own / ally liaison "逐步建成" animation (client-only, no protocol change).
 * Build front walks nodes[0] → nodes[n-1] (stroke order); each segment's share of
 * the server build time is proportional to its own E (base share + terrain surcharge).
 */

import type { PlacedLiaison, TerrainMap } from "@wop/shared";
import {
  TICK_MS,
  previewLiaisonCostForLength,
  roadRailTerrainSurchargeE,
  segmentLengthDu,
} from "@wop/shared";

/** Last seen server progress for one line; `at` = performance.now() on change. */
export interface LiaisonBuildAnchor {
  remaining: number;
  total: number;
  at: number;
}

const weightCache = new Map<string, { sig: string; cum: number[] }>();

function lineSig(line: PlacedLiaison, terrain: TerrainMap | null | undefined): string {
  return (
    `${line.kind}|${terrain ? 1 : 0}|` +
    line.nodes.map((n) => `${n.gx},${n.gy}`).join("-")
  );
}

/**
 * Cumulative per-segment E, normalized to 1 at the end.
 * Base E = ⌊L⌋ × costPerDu × 10 shared by segment length; road/railway add
 * `roadRailTerrainSurchargeE` of that single segment.
 */
function cumulativeSegmentWeights(
  line: PlacedLiaison,
  terrain: TerrainMap | null | undefined,
): number[] {
  const sig = lineSig(line, terrain);
  const hit = weightCache.get(line.id);
  if (hit && hit.sig === sig) return hit.cum;

  const lens: number[] = [];
  let totalLen = 0;
  for (let i = 1; i < line.nodes.length; i++) {
    const len = segmentLengthDu(line.nodes[i - 1]!, line.nodes[i]!);
    lens.push(len);
    totalLen += len;
  }
  const baseTotal = previewLiaisonCostForLength(line.kind, totalLen).energy;
  const weights = lens.map((len, i) => {
    const base = totalLen > 0 ? (baseTotal * len) / totalLen : 0;
    const surcharge =
      terrain && (line.kind === "road" || line.kind === "railway")
        ? roadRailTerrainSurchargeE(terrain, [line.nodes[i]!, line.nodes[i + 1]!], line.kind)
        : 0;
    return base + surcharge;
  });
  let sum = weights.reduce((s, w) => s + w, 0);
  // Degenerate (e.g. ⌊L⌋ = 0 with no surcharge): fall back to length.
  if (sum <= 0) {
    weights.splice(0, weights.length, ...lens);
    sum = totalLen;
  }
  const cum: number[] = [];
  let acc = 0;
  for (const w of weights) {
    acc += w;
    cum.push(sum > 0 ? acc / sum : 1);
  }
  weightCache.set(line.id, { sig, cum });
  return cum;
}

/** Drop cached weights for lines no longer present. */
export function pruneLiaisonWeightCache(liveIds: ReadonlySet<string>): void {
  for (const id of weightCache.keys()) {
    if (!liveIds.has(id)) weightCache.delete(id);
  }
}

/** Elapsed share of build time, interpolated at most one tick past the snapshot. */
export function liaisonBuildFraction(anchor: LiaisonBuildAnchor, now: number): number {
  if (anchor.total <= 0) return 1;
  const ahead = Math.min(1, Math.max(0, (now - anchor.at) / TICK_MS));
  const remaining = Math.max(0, anchor.remaining - ahead);
  return Math.min(1, Math.max(0, 1 - remaining / anchor.total));
}

/**
 * Time share → fractional segment index (2.4 = segments 0–1 built, 40% of segment 2).
 * Within a segment progress is linear in time (uniform E density).
 */
export function liaisonBuiltSegments(
  line: PlacedLiaison,
  fraction: number,
  terrain: TerrainMap | null | undefined,
): number {
  const cum = cumulativeSegmentWeights(line, terrain);
  if (cum.length === 0) return 0;
  if (fraction >= 1) return cum.length;
  let prev = 0;
  for (let i = 0; i < cum.length; i++) {
    const end = cum[i]!;
    if (fraction < end) {
      const span = end - prev;
      return i + (span > 0 ? (fraction - prev) / span : 0);
    }
    prev = end;
  }
  return cum.length;
}
