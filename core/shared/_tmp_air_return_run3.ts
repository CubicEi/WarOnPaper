import { advanceUnits } from "./src/units/tick.ts";
import { applyUnitStop, applyUnitMove } from "./src/units/orders.ts";
import { deployFromBuilding } from "./src/units/garrison.ts";

const map = { linesX: 40, linesY: 40, seed: 1 } as const;
const airport = {
  id: "ap1",
  buildingId: "airport" as const,
  ownerId: "p1",
  gx: 10,
  gy: 10,
  hp: 30,
  hpMax: 30,
  u: 6,
  level: 1,
  storeE: 0,
  ammo: 0,
  investedE: 100,
  buildTicksRemaining: 0,
  buildTicksTotal: 100,
};

const deployed = deployFromBuilding(airport as never, 2, "air3");
if ("error" in deployed) throw new Error(deployed.error);
let buildings = [deployed.building];
let units = [{ ...deployed.unit, gx: 9.8, gy: 9.8 }];

const move = applyUnitMove(
  { ownerId: "p1", gx: 12, gy: 12, unitIds: ["air3"] },
  {
    buildings,
    units,
    connectedIds: new Set(["ap1"]),
    terrain: null as never,
    liaisons: [],
    map: map as never,
    nextId: () => "x",
  },
);
console.log("move", {
  ok: move.ok,
  error: move.error,
  unit: move.units.find((u) => u.id === "air3"),
});
if (!move.ok) process.exit(1);
units = move.units;
buildings = move.buildings;

for (let i = 0; i < 500; i++) {
  const r = advanceUnits(
    units,
    buildings,
    [],
    null,
    new Map([["p1", new Set(["ap1"])]]),
    0.2,
  );
  units = r.units;
  buildings = r.buildings;
  const u = units.find((x) => x.id === "air3");
  if (i < 8 || i % 30 === 0) {
    console.log("tick", i, {
      removed: r.removedIds,
      u: u && {
        state: u.state,
        gx: +u.gx.toFixed(3),
        gy: +u.gy.toFixed(3),
        ret: [u.returnGx, u.returnGy],
        deposit: u.depositOnArrival,
        depositId: u.depositBuildingId,
        pathLen: u.path?.length,
        idx: u.pathIndex,
      },
      bU: buildings[0]!.u,
      away: buildings[0]!.awayOccupiedU,
    });
  }
  if (!u) {
    console.log("DONE deposited", i, { bU: buildings[0]!.u, away: buildings[0]!.awayOccupiedU });
    process.exit(0);
  }
  if (u.state === "idle" && !u.depositOnArrival && u.returnGx == null && !u.path) {
    console.log("STUCK", i, {
      u: { gx: u.gx, gy: u.gy, state: u.state, home: u.homeBuildingId },
      bU: buildings[0]!.u,
      away: buildings[0]!.awayOccupiedU,
    });
    // try retreat from stuck
    const stop = applyUnitStop(
      "p1",
      ["air3"],
      units,
      {
        buildings,
        connectedIds: new Set(["ap1"]),
        terrain: null as never,
        liaisons: [],
        map: map as never,
      },
      { retreat: true },
    );
    console.log("retreat from stuck", stop.ok, stop.error, stop.units[0]);
    units = stop.units;
    buildings = stop.buildings ?? buildings;
    for (let j = 0; j < 200; j++) {
      const r2 = advanceUnits(units, buildings, [], null, new Map([["p1", new Set(["ap1"])]]), 0.2);
      units = r2.units;
      buildings = r2.buildings;
      if (r2.removedIds.length || !units.find((x) => x.id === "air3")) {
        console.log("retreat done", j, { removed: r2.removedIds, bU: buildings[0]!.u, away: buildings[0]!.awayOccupiedU });
        process.exit(0);
      }
    }
    console.log("retreat also stuck", units[0], buildings[0]);
    process.exit(1);
  }
}
console.log("timeout", units[0], buildings[0]);
process.exit(1);
