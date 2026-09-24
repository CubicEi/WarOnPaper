import { advanceUnits } from "./src/units/tick.ts";
import { applyUnitMove } from "./src/units/orders.ts";
import { deployFromBuilding } from "./src/units/garrison.ts";
import { collectAirportCoverage } from "./src/units/radio.ts";
import { isBuildingComplete } from "./src/buildings/actions.ts";

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

console.log("complete", isBuildingComplete(airport as never));
console.log("cov", collectAirportCoverage(airport as never, [airport as never], new Set(["ap1"])));

const deployed = deployFromBuilding(airport as never, 2, "air3");
if ("error" in deployed) throw new Error(deployed.error);
let buildings = [deployed.building];
// Start beside airport like yieldOff would
let units = [{ ...deployed.unit, gx: 9.8, gy: 9.8 }];

const move = applyUnitMove(
  { ownerId: "p1", toGx: 12, toGy: 12, unitIds: ["air3"] },
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

for (let i = 0; i < 400; i++) {
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
  if (i < 5 || i % 25 === 0) {
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
    break;
  }
  if (u.state === "idle" && !u.depositOnArrival && u.returnGx == null && !u.path) {
    console.log("STUCK", i, {
      u: { gx: u.gx, gy: u.gy, state: u.state, home: u.homeBuildingId },
      bU: buildings[0]!.u,
      away: buildings[0]!.awayOccupiedU,
    });
    break;
  }
}
