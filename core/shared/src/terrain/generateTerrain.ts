import { MAP_SIZES, type MapConfig, type MapSizeId } from "../map.js";
import type { TerrainCell, TerrainDeposit, TerrainMap } from "./types.js";

export interface GenerateTerrainOptions {
  /** Default 89×59. */
  map?: MapConfig | MapSizeId;
  /** Omit for random seed. */
  seed?: number;
  /** Target land fraction of all cells (rest ocean). Default 0.58. */
  landRatio?: number;
  /** Mountain fraction of land cells. Default 0.12. */
  mountainRatio?: number;
  /** Forest fraction of non-mountain land. Default 0.154. */
  forestRatio?: number;
}

function resolveMap(map?: MapConfig | MapSizeId): MapConfig {
  if (!map) return MAP_SIZES["89x59"];
  if (typeof map === "string") return MAP_SIZES[map];
  return map;
}

/** FNV-1a 32-bit → unsigned seed. */
export function hashStringToSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Resolve init/debug seed input for generateTerrain.
 * Empty / null / undefined → undefined (caller uses random).
 * Finite number or integer string → uint32; other strings → hash.
 */
export function parseTerrainSeed(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return value >>> 0;
  }
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  if (!t) return undefined;
  if (/^[+-]?\d+$/.test(t)) {
    const n = Number(t);
    if (Number.isSafeInteger(n)) return n >>> 0;
    return hashStringToSeed(t);
  }
  return hashStringToSeed(t);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function randFloat(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

/** Integer hash → [0,1) */
function hash2(x: number, y: number, seed: number): number {
  let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ seed;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise2(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smoothstep(x - x0);
  const fy = smoothstep(y - y0);
  const v00 = hash2(x0, y0, seed);
  const v10 = hash2(x0 + 1, y0, seed);
  const v01 = hash2(x0, y0 + 1, seed);
  const v11 = hash2(x0 + 1, y0 + 1, seed);
  const a = v00 + (v10 - v00) * fx;
  const b = v01 + (v11 - v01) * fx;
  return a + (b - a) * fy;
}

function fbm(x: number, y: number, seed: number, octaves = 4): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(x * freq, y * freq, seed + i * 1013);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

function idx(width: number, x: number, y: number): number {
  return y * width + x;
}

function neighbors4(x: number, y: number, w: number, h: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (x > 0) out.push([x - 1, y]);
  if (x < w - 1) out.push([x + 1, y]);
  if (y > 0) out.push([x, y - 1]);
  if (y < h - 1) out.push([x, y + 1]);
  return out;
}

function isWater(cell: TerrainCell): boolean {
  return cell.ground === "ocean";
}

function floodToOcean(cell: TerrainCell): void {
  cell.ground = "ocean";
  cell.resource = null;
}

/**
 * Rivers/water must be ≥1 cell wide (4-connected).
 * Forbids 2×2 checkerboards where water only touches at a corner.
 * Fix: turn one land/mountain cell into ocean so the channel has an edge.
 */
function enforceWaterMinWidth(cells: TerrainCell[], width: number, height: number, rng: () => number): void {
  let guard = 0;
  while (guard++ < width * height) {
    let fixed = 0;
    for (let y = 0; y < height - 1; y++) {
      for (let x = 0; x < width - 1; x++) {
        const a = cells[idx(width, x, y)];
        const b = cells[idx(width, x + 1, y)];
        const c = cells[idx(width, x, y + 1)];
        const d = cells[idx(width, x + 1, y + 1)];
        const wa = isWater(a);
        const wb = isWater(b);
        const wc = isWater(c);
        const wd = isWater(d);

        // Diagonal water only: A—D water, B·C land  OR  B—C water, A·D land
        if (wa && wd && !wb && !wc) {
          if (rng() < 0.5) floodToOcean(b);
          else floodToOcean(c);
          fixed++;
        } else if (wb && wc && !wa && !wd) {
          if (rng() < 0.5) floodToOcean(a);
          else floodToOcean(d);
          fixed++;
        }
      }
    }
    if (fixed === 0) break;
  }
}

/**
 * Generate terrain per rules §2.1:
 * ocean / land / mountain, plus oil (<1%), uranium (<1‰, ≤2 cells), forest (per-cell reserve).
 * Water channels are 4-connected and at least one cell wide (no diagonal-only rivers).
 *
 * @example
 * const terrain = generateTerrain({ map: "89x59", seed: 42 });
 */
export function generateTerrain(options: GenerateTerrainOptions = {}): TerrainMap {
  const mapCfg = resolveMap(options.map);
  const width = mapCfg.cellsX;
  const height = mapCfg.cellsY;
  const seed = options.seed ?? (Math.random() * 0xffffffff) >>> 0;
  const rng = mulberry32(seed);
  const landRatio = options.landRatio ?? 0.58;
  const mountainRatio = options.mountainRatio ?? 0.12;
  const forestRatio = options.forestRatio ?? 0.154;
  const total = width * height;

  const cells: TerrainCell[] = Array.from({ length: total }, () => ({
    ground: "ocean" as const,
    resource: null,
  }));

  // --- Continents (fbm + radial falloff toward edges → ocean rim) ---
  const scale = 1 / Math.max(width, height);
  const scores: number[] = new Array(total);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = x * scale * 3.2;
      const ny = y * scale * 3.2;
      const n = fbm(nx, ny, seed);
      const dx = (x / (width - 1)) * 2 - 1;
      const dy = (y / (height - 1)) * 2 - 1;
      const edge = Math.max(Math.abs(dx), Math.abs(dy));
      const falloff = Math.pow(Math.max(0, 1 - edge * 1.05), 1.35);
      scores[idx(width, x, y)] = n * 0.72 + falloff * 0.28 + randFloat(rng, -0.02, 0.02);
    }
  }

  const sorted = scores.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  const landCount = Math.floor(total * landRatio);
  for (let i = 0; i < landCount; i++) {
    cells[sorted[i].i].ground = "land";
  }

  // --- Mountains on high inland noise ---
  const landCells: number[] = [];
  for (let i = 0; i < total; i++) {
    if (cells[i].ground === "land") landCells.push(i);
  }
  const mountainTarget = Math.floor(landCells.length * mountainRatio);
  const mountainScore = landCells.map((i) => {
    const x = i % width;
    const y = (i / width) | 0;
    const elev = fbm(x * scale * 6, y * scale * 6, seed + 77);
    return { i, elev };
  });
  mountainScore.sort((a, b) => b.elev - a.elev);
  for (let i = 0; i < mountainTarget; i++) {
    cells[mountainScore[i].i].ground = "mountain";
  }

  // Water ≥1 cell wide, no corner-only river connections
  enforceWaterMinWidth(cells, width, height, rng);

  // --- Forest on non-mountain land (after water fix) ---
  const forestCandidates: number[] = [];
  for (let i = 0; i < total; i++) {
    if (cells[i].ground === "land") forestCandidates.push(i);
  }
  const forestTarget = Math.floor(forestCandidates.length * forestRatio);
  const forestScore = forestCandidates.map((i) => {
    const x = i % width;
    const y = (i / width) | 0;
    return { i, s: fbm(x * scale * 5, y * scale * 5, seed + 191) };
  });
  forestScore.sort((a, b) => b.s - a.s);
  for (let i = 0; i < forestTarget; i++) {
    const ci = forestScore[i].i;
    const reserve = randInt(rng, 12, 20);
    cells[ci].resource = {
      kind: "forest",
      reserve,
      reserveMax: reserve,
    };
  }

  const deposits: TerrainDeposit[] = [];
  let depositId = 1;

  const isNonMountain = (x: number, y: number) => {
    const c = cells[idx(width, x, y)];
    return c.ground !== "mountain";
  };

  const isNonMountainNoForest = (x: number, y: number) => {
    const c = cells[idx(width, x, y)];
    return c.ground !== "mountain" && c.resource?.kind !== "forest";
  };

  // --- Oil fields: total area < 1%, avoid forest ---
  const oilBudget = Math.floor(total * 0.01) - 1; // strictly < 1%
  let oilUsed = 0;
  let oilGuard = 0;
  while (oilUsed < oilBudget && oilGuard++ < 500) {
    const remain = oilBudget - oilUsed;
    if (remain < 2) break;
    const size = Math.min(remain, randInt(rng, 3, 10));
    const sx = randInt(rng, 0, width - 1);
    const sy = randInt(rng, 0, height - 1);
    if (!isNonMountainNoForest(sx, sy)) continue;

    const blob: Array<{ x: number; y: number }> = [{ x: sx, y: sy }];
    const seen = new Set<number>([idx(width, sx, sy)]);
    while (blob.length < size) {
      const base = blob[randInt(rng, 0, blob.length - 1)];
      const nbs = neighbors4(base.x, base.y, width, height).filter(
        ([nx, ny]) => isNonMountainNoForest(nx, ny) && !seen.has(idx(width, nx, ny)),
      );
      if (nbs.length === 0) break;
      const [nx, ny] = nbs[randInt(rng, 0, nbs.length - 1)];
      seen.add(idx(width, nx, ny));
      blob.push({ x: nx, y: ny });
    }
    if (blob.length < 2) continue;

    const n = blob.length;
    const reserve = randInt(rng, 15, 25) * n + randInt(rng, -30, 20);
    const id = depositId++;
    for (const { x, y } of blob) {
      cells[idx(width, x, y)].resource = {
        kind: "oil",
        reserve,
        reserveMax: reserve,
        depositId: id,
      };
    }
    deposits.push({ id, kind: "oil", cells: blob, reserve, reserveMax: reserve });
    oilUsed += n;
  }

  // --- Uranium: total area < 1‰, each deposit ≤ 2 cells, avoid forest ---
  const uraBudget = Math.max(0, Math.floor(total * 0.001) - 1); // strictly < 1‰
  let uraUsed = 0;
  let uraGuard = 0;
  while (uraUsed < uraBudget && uraGuard++ < 400) {
    const remain = uraBudget - uraUsed;
    if (remain < 1) break;
    const size = Math.min(2, remain, rng() < 0.55 ? 1 : 2);
    const sx = randInt(rng, 0, width - 1);
    const sy = randInt(rng, 0, height - 1);
    if (!isNonMountainNoForest(sx, sy)) continue;

    const blob: Array<{ x: number; y: number }> = [{ x: sx, y: sy }];
    if (size === 2) {
      const nbs = neighbors4(sx, sy, width, height).filter(([nx, ny]) => isNonMountainNoForest(nx, ny));
      if (nbs.length === 0) {
        // single cell only
      } else {
        const [nx, ny] = nbs[randInt(rng, 0, nbs.length - 1)];
        blob.push({ x: nx, y: ny });
      }
    }

    const n = blob.length;
    const reserve = randInt(rng, 100, 150) * n;
    const id = depositId++;
    for (const { x, y } of blob) {
      cells[idx(width, x, y)].resource = {
        kind: "uranium",
        reserve,
        reserveMax: reserve,
        depositId: id,
      };
    }
    deposits.push({ id, kind: "uranium", cells: blob, reserve, reserveMax: reserve });
    uraUsed += n;
  }

  return { seed, width, height, cells, deposits };
}
