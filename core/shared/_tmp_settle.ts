/**
 * Probe: air arrives at home with depositOnArrival but settleIdle
 * pushes off center first — verify deposit still works when depositBuildingId
 * is missing (rely on dest-by-position) vs present.
 */
import { advanceUnits } from "./src/units/tick.ts";
import { deployFromBuilding } from "./src/units/garrison.ts";
import type { UnitGroup } from "./src/units/types.ts";

const airport = {
  id: "ap1",
  buildingId: "airport" as const,
  ownerId: "p1",
  gx: 10,
  gy: 10,
  hp: 30,
  hpMax: 30,
  u: 4,
  awayOccupiedU: 2,
  level: 1,
  storeE: 0,
  ammo: 0,
  investedE: 100,
  buildTicksRemaining: 0,
  buildTicksTotal: 100,
};

function run(label: string, unit: UnitGroup) {
  let buildings = [{ ...airport }];
  let units = [unit];
  console.log(label, "start", {
    u: units[0],
    bU: buildings[0].u,
    away: buildings[0].awayOccupiedU,
  });
  for (let i = 0; i < 5; i++) {
    const r = advanceUnits(
      units,
      buildings,
      [],
      null,
      new Map([["p1", new Set(["ap1"])]]),
      1,
    );
    units = r.units;
    buildings = r.buildings;
    console.log(label, "tick", i, {
      removed: r.removedIds,
      units: units.map((u) => ({
        gx: u.gx,
        gy: u.gy,
        state: u.state,
        deposit: u.depositOnArrival,
        retreating: u.retreating,
      })),
      bU: buildings[0]!.u,
      away: buildings[0]!.awayOccupiedU,
    });
    if (r.removedIds.length || units.length === 0) break;
  }
}

const base = deployFromBuilding({ ...airport, u: 6, awayOccupiedU: undefined } as never, 2, "a1");
if ("error" in base) throw new Error(base.error);

// Case 1: at building center, depositOnArrival, depositBuildingId set (retreat-like)
run("withId", {
  ...base.unit,
  gx: 10,
  gy: 10,
  state: "moving",
  path: [
    { gx: 10, gy: 10 },
    { gx: 10, gy: 10 },
  ],
  pathIndex: 2, // already past end → settle
  depositOnArrival: true,
  depositBuildingId: "ap1",
  retreating: true,
  homeBuildingId: "ap1",
});

// Case 2: at building center, depositOnArrival, NO depositBuildingId, NOT retreating
// (broken home fallback after being pushed off center)
run("noId", {
  ...base.unit,
  id: "a2",
  gx: 10,
  gy: 10,
  state: "moving",
  path: [
    { gx: 10, gy: 10 },
    { gx: 10, gy: 10 },
  ],
  pathIndex: 2,
  depositOnArrival: true,
  depositBuildingId: undefined,
  retreating: false,
  homeBuildingId: "ap1",
  returnGx: undefined,
  returnGy: undefined,
});

// Case 3: like tryStartAirReturn when already at home — depositBuildingId set via home
run("airReturnSameCell", {
  ...base.unit,
  id: "a3",
  gx: 10,
  gy: 10,
  state: "idle",
  returnGx: 10,
  returnGy: 10,
  homeBuildingId: "ap1",
});
