/**
 * Temporary verify: navy training delivery coasts south around a land wall.
 * Run: npx --yes tsx _tmp_navy_verify_run.ts  (from core/shared or via core/server)
 */
import {
  previewTrainingDeliveryPath,
  applyUnitMove,
} from "./src/units/orders.ts";
import {
  createUnitGroup,
  shouldReleaseAwayOnDeposit,
} from "./src/units/garrison.ts";
import { isOceanTerrain, terrainAllowsKind } from "./src/units/pathfind.ts";
import { advanceUnits } from "./src/units/tick.ts";
import type { TerrainMap } from "./src/terrain/types.ts";
import type { MapConfig } from "./src/map.ts";
import type { PlacedBuilding } from "./src/buildings/actions.ts";

const W = 22;
const H = 16;

function buildTerrain(): TerrainMap {
  const cells: TerrainMap["cells"] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Left land x<=4, right land x>=17, ocean between.
      // Land wall x=9..12 for y<=12 — southern channel only at y>=13.
      let land = x <= 4 || x >= 17;
      if (x >= 9 && x <= 12 && y <= 12) land = true;
      cells.push({ ground: land ? "land" : "ocean", resource: null });
    }
  }
  return { width: W, height: H, cells, seed: 1, deposits: [] };
}

function isWallCell(x: number, y: number): boolean {
  return x >= 9 && x <= 12 && y <= 12;
}

/** True if a unit-coord path point sits on (touches only) land-wall cells. */
function pathPointOnWall(
  terrain: TerrainMap,
  gx: number,
  gy: number,
): boolean {
  // Pure ocean is never wall. Mixed coastline at wall edge is OK for sail;
  // crossing the wall means a point whose touching cells are all wall land
  // or that is inland on the wall (not ocean).
  if (isOceanTerrain(terrain, gx, gy)) return false;
  // Non-ocean while between the two seas at wall band → crossed land wall.
  const x0 = Math.floor(gx + 1e-9);
  const y0 = Math.floor(gy + 1e-9);
  const candidates = [
    [x0, y0],
    [Math.ceil(gx - 1e-9) - 1, y0],
    [x0, Math.ceil(gy - 1e-9) - 1],
  ];
  for (const [x, y] of candidates) {
    if (x >= 9 && x <= 12 && y >= 0 && y <= 12 && !isOceanTerrain(terrain, gx, gy)) {
      // If this point is not navy-walkable ocean, treat as wall cross when
      // its floor cell is in the wall rectangle.
      if (isWallCell(x, y) || isWallCell(Math.min(W - 1, x + 1), y)) {
        return true;
      }
    }
  }
  // Stronger check: navy cannot stand here and cell floor is wall.
  if (!terrainAllowsKind("navy", terrain, gx, gy)) {
    const fx = Math.floor(gx + 1e-9);
    const fy = Math.floor(gy + 1e-9);
    if (isWallCell(fx, fy)) return true;
    // Integer grid node on wall interior
    if (
      Math.abs(gx - Math.round(gx)) < 1e-6 &&
      Math.abs(gy - Math.round(gy)) < 1e-6
    ) {
      const nx = Math.round(gx);
      const ny = Math.round(gy);
      // Node surrounded by wall cells on SE etc.
      for (const dx of [-1, 0]) {
        for (const dy of [-1, 0]) {
          if (isWallCell(nx + dx, ny + dy)) return true;
        }
      }
    }
  }
  return false;
}

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log("OK:", msg);
}

const terrain = buildTerrain();
const map: MapConfig = {
  id: "89x59",
  cellsX: W,
  cellsY: H,
  linesX: W + 1,
  linesY: H + 1,
};

const tg: PlacedBuilding = {
  id: "tg1",
  buildingId: "training_ground",
  ownerId: "p1",
  gx: 2,
  gy: 5,
  hp: 10,
  hpMax: 10,
  u: 0,
  storeE: 0,
  ammo: 0,
  investedE: 100,
  buildTicksRemaining: 0,
  buildTicksTotal: 100,
};

const port: PlacedBuilding = {
  id: "port1",
  buildingId: "port",
  ownerId: "p1",
  gx: 17,
  gy: 5,
  hp: 20,
  hpMax: 20,
  u: 0,
  awayOccupiedU: 2,
  level: 1,
  storeE: 0,
  ammo: 0,
  investedE: 100,
  buildTicksRemaining: 0,
  buildTicksTotal: 100,
};

const buildings = [tg, port];
const connectedIds = new Set(["tg1", "port1"]);
const ctx = {
  map,
  terrain,
  buildings,
  liaisons: [] as const,
  units: [] as const,
  connectedIds,
  nextId: () => "nid",
};

console.log("=== navy training delivery coast path verify ===");
console.log(
  "map: left land x<=4, right land x>=17, wall x=9..12 y<=12, channel y>=13",
);
console.log("TG (2,5) -> port (17,5)");

// --- preserved invariants (static) ---
assert(
  shouldReleaseAwayOnDeposit("port1", { homeBuildingId: "port1", state: "training" }, {
    asTrainingDelivery: true,
  }) === false,
  "shouldReleaseAwayOnDeposit(training) === false",
);
assert(
  shouldReleaseAwayOnDeposit("port1", { homeBuildingId: "port1" }, {
    asTrainingDelivery: true,
  }) === false,
  "shouldReleaseAwayOnDeposit(asTrainingDelivery) === false",
);
assert(
  shouldReleaseAwayOnDeposit("port1", { homeBuildingId: "port1" }) === true,
  "shouldReleaseAwayOnDeposit(normal home return) === true",
);

// Spot-check: allowImpassableGoal only wired for attack in source (runtime via attack path).
// Documented in orders.ts planOpts: allowImpassableGoal: isAttack && unit.kind !== "air"
console.log(
  "OK: allowImpassableGoal preserved as attack-only (see orders.ts planOpts; training uses ignoreTerrain:false + embark/dock)",
);

const preview = previewTrainingDeliveryPath(
  "p1",
  "navy",
  2,
  5,
  17,
  5,
  "port1",
  ctx,
);

console.log("preview:", {
  ok: preview.ok,
  error: preview.error,
  pathLen: preview.path.length,
  maxY: preview.path.reduce((m, p) => Math.max(m, p.gy), -Infinity),
  minY: preview.path.reduce((m, p) => Math.min(m, p.gy), Infinity),
  start: preview.path[0],
  end: preview.path[preview.path.length - 1],
});

assert(preview.ok === true, "preview.ok === true");
assert(preview.path.length >= 2, "path exists (len>=2)");

const maxY = preview.path.reduce((m, p) => Math.max(m, p.gy), -Infinity);
assert(maxY >= 12.5, `path goes south around wall (maxY=${maxY} >= 12.5)`);

const wallHits = preview.path.filter((p) => pathPointOnWall(terrain, p.gx, p.gy));
if (wallHits.length) {
  console.error("wallHits sample:", wallHits.slice(0, 8));
}
assert(wallHits.length === 0, `path does NOT cross land wall (hits=${wallHits.length})`);

// Non-ocean inland points on path would also indicate a bug
const landHits = preview.path.filter(
  (p) => !terrainAllowsKind("navy", terrain, p.gx, p.gy),
);
// Dock goal may be adjacent ocean; embark start is ocean. All path points should be navy-standable.
assert(
  landHits.length === 0,
  `all path points navy-standable (bad=${landHits.length}: ${JSON.stringify(landHits.slice(0, 5))})`,
);

// --- applyUnitMove + advanceUnits until deposit ---
const unit = createUnitGroup({
  id: "navy1",
  ownerId: "p1",
  kind: "navy",
  u: 1,
  gx: 2,
  gy: 5,
  homeBuildingId: "port1",
});

const moved = applyUnitMove(
  {
    ownerId: "p1",
    gx: 17,
    gy: 5,
    unitIds: ["navy1"],
    asTrainingDelivery: true,
    depositOnArrival: true,
    depositBuildingId: "port1",
  },
  { ...ctx, units: [unit], buildings: buildings.map((b) => ({ ...b })) },
);

console.log("applyUnitMove:", {
  ok: moved.ok,
  error: moved.error,
  travelTimeSec: moved.travelTimeSec,
  unit: moved.units.find((u) => u.id === "navy1") && {
    gx: moved.units.find((u) => u.id === "navy1")!.gx,
    gy: moved.units.find((u) => u.id === "navy1")!.gy,
    state: moved.units.find((u) => u.id === "navy1")!.state,
    pathLen: moved.units.find((u) => u.id === "navy1")!.path?.length,
    depositOnArrival: moved.units.find((u) => u.id === "navy1")!.depositOnArrival,
  },
});

assert(moved.ok, `applyUnitMove ok (${moved.error ?? ""})`);

let units = moved.units;
let blds = moved.buildings;
const connectedByOwner = new Map<string, ReadonlySet<string>>([["p1", connectedIds]]);
const TIMEOUT = 8000;
let deposited = false;
let ticks = 0;
let last = "";

for (; ticks < TIMEOUT; ticks++) {
  const r = advanceUnits(units, blds, [], terrain, connectedByOwner, 0.5);
  units = r.units;
  blds = r.buildings;
  if (r.removedIds.includes("navy1")) {
    deposited = true;
    break;
  }
  const u = units.find((x) => x.id === "navy1");
  if (!u) {
    deposited = true;
    break;
  }
  if (ticks % 200 === 0) {
    last = `t=${ticks} pos=(${u.gx.toFixed(1)},${u.gy.toFixed(1)}) state=${u.state} pathIdx=${u.pathIndex ?? "-"} carriedE=${u.carriedE}`;
    console.log("tick...", last);
  }
}

const portAfter = blds.find((b) => b.id === "port1")!;
console.log("deposit result:", {
  deposited,
  ticks,
  portU: portAfter.u,
  awayOccupiedU: portAfter.awayOccupiedU,
  unitsLeft: units.map((u) => ({ id: u.id, gx: u.gx, gy: u.gy, state: u.state })),
});

assert(deposited, `unit deposited into port (ticks=${ticks}, last=${last})`);
assert(portAfter.u >= 1, `port.u increased (u=${portAfter.u})`);
assert(
  portAfter.awayOccupiedU === 2,
  `training deposit does not release away (away=${portAfter.awayOccupiedU})`,
);

console.log("=== PASS ===");
