import { planAirPath } from "./src/units/pathfind.ts";
import {
  isInsideAnyCircle,
  collectMovingUnitCoverage,
  collectAirportCoverage,
} from "./src/units/radio.ts";
import { applyUnitMove } from "./src/units/orders.ts";
import { deployFromBuilding } from "./src/units/garrison.ts";

const airport = {
  id: "ap1",
  buildingId: "airport",
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

const cov = collectAirportCoverage(airport as never, [airport as never], new Set(["ap1"]));
console.log("airport cov", cov);
console.log("plan direct", planAirPath(9.8, 9.8, 12, 12, cov));
console.log(
  "moving cov",
  collectMovingUnitCoverage(
    { kind: "air", ownerId: "p1", homeBuildingId: "ap1" },
    [airport as never],
    new Set(["ap1"]),
  ),
);

const deployed = deployFromBuilding(airport as never, 2, "air3");
if ("error" in deployed) throw new Error(deployed.error);
console.log("deployed building keys", Object.keys(deployed.building));
console.log("deployed buildTicks", deployed.building.buildTicksRemaining);
console.log(
  "cov after deploy",
  collectAirportCoverage(deployed.building, [deployed.building], new Set(["ap1"])),
);

const units = [{ ...deployed.unit, gx: 9.8, gy: 9.8 }];
const buildings = [deployed.building];
const unitCov = collectMovingUnitCoverage(units[0]!, buildings, new Set(["ap1"]));
console.log("unit cov", unitCov);
console.log("start in", isInsideAnyCircle(9.8, 9.8, unitCov));
console.log("end in", isInsideAnyCircle(12, 12, unitCov));
console.log("plan with unit cov", planAirPath(9.8, 9.8, 12, 12, unitCov));

const move = applyUnitMove(
  { ownerId: "p1", toGx: 12, toGy: 12, unitIds: ["air3"] },
  {
    buildings,
    units,
    connectedIds: new Set(["ap1"]),
    terrain: null as never,
    liaisons: [],
    map: { linesX: 40, linesY: 40, seed: 1 } as never,
    nextId: () => "x",
  },
);
console.log("move result", move.ok, move.error);
