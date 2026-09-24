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

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL", msg);
    process.exit(1);
  }
  console.log("OK", msg);
}

// 1) deposit without depositBuildingId (previously stuck)
{
  const d = deployFromBuilding({ ...airport }, 2, "a1");
  if ("error" in d) throw new Error(d.error);
  let buildings = [d.building];
  let units = [
    {
      ...d.unit,
      gx: 10,
      gy: 10,
      state: "moving" as const,
      path: [
        { gx: 10, gy: 10 },
        { gx: 10, gy: 10 },
      ],
      pathIndex: 2,
      depositOnArrival: true,
      homeBuildingId: "ap1",
    },
  ];
  const r = advanceUnits(units, buildings, [], null, new Map([["p1", new Set(["ap1"])]]), 1);
  assert(r.removedIds.includes("a1"), "noId deposit removes air");
  assert(r.buildings[0]!.u === 6, "noId deposit restores garrison");
}

// 2) move then auto-return
{
  const d = deployFromBuilding({ ...airport }, 2, "a2");
  if ("error" in d) throw new Error(d.error);
  let buildings = [d.building];
  let units = [{ ...d.unit, gx: 9.8, gy: 9.8 }];
  const move = applyUnitMove(
    { ownerId: "p1", gx: 12, gy: 12, unitIds: ["a2"] },
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
  assert(move.ok, "move ok");
  units = move.units;
  buildings = move.buildings;
  let done = false;
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
    if (!units.find((u) => u.id === "a2")) {
      done = true;
      assert(buildings[0]!.u === 6, "auto-return restored garrison");
      break;
    }
  }
  assert(done, "auto-return completed");
}

// 3) move onto home airport → direct deposit
{
  const d = deployFromBuilding({ ...airport }, 2, "a3");
  if ("error" in d) throw new Error(d.error);
  let buildings = [d.building];
  let units = [{ ...d.unit, gx: 12, gy: 12 }];
  const move = applyUnitMove(
    { ownerId: "p1", gx: 10, gy: 10, unitIds: ["a3"] },
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
  assert(move.ok, "home move ok");
  const u = move.units.find((x) => x.id === "a3");
  assert(!!u?.depositOnArrival || !u, "home move deposits or already deposited");
  units = move.units;
  buildings = move.buildings;
  for (let i = 0; i < 200; i++) {
    const r = advanceUnits(
      units,
      buildings,
      [],
      null,
      new Map([["p1", new Set(["ap1"])]]),
      0.5,
    );
    units = r.units;
    buildings = r.buildings;
    if (!units.find((x) => x.id === "a3")) break;
  }
  assert(!units.find((x) => x.id === "a3"), "home move deposited");
  assert(buildings[0]!.u === 6, "home move restored garrison");
}

// 4) air stop forces return
{
  const d = deployFromBuilding({ ...airport }, 2, "a4");
  if ("error" in d) throw new Error(d.error);
  let buildings = [d.building];
  let units = [{ ...d.unit, gx: 12, gy: 12, state: "idle" as const }];
  const stop = applyUnitStop(
    "p1",
    ["a4"],
    units,
    {
      buildings,
      connectedIds: new Set(["ap1"]),
      terrain: null as never,
      liaisons: [],
      map: map as never,
    },
    { retreat: false },
  );
  assert(stop.ok, "air stop ok");
  assert(!!stop.buildings, "air stop returns buildings");
  units = stop.units;
  buildings = stop.buildings ?? buildings;
  for (let i = 0; i < 200; i++) {
    const r = advanceUnits(
      units,
      buildings,
      [],
      null,
      new Map([["p1", new Set(["ap1"])]]),
      0.5,
    );
    units = r.units;
    buildings = r.buildings;
    if (!units.find((x) => x.id === "a4")) break;
  }
  assert(!units.find((x) => x.id === "a4"), "air stop deposited");
  assert(buildings[0]!.u === 6, "air stop restored garrison");
}

// 5) retreat
{
  const d = deployFromBuilding({ ...airport }, 2, "a5");
  if ("error" in d) throw new Error(d.error);
  let buildings = [d.building];
  let units = [{ ...d.unit, gx: 12, gy: 12 }];
  const stop = applyUnitStop(
    "p1",
    ["a5"],
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
  assert(stop.ok, "retreat ok");
  units = stop.units;
  buildings = stop.buildings ?? buildings;
  for (let i = 0; i < 200; i++) {
    const r = advanceUnits(
      units,
      buildings,
      [],
      null,
      new Map([["p1", new Set(["ap1"])]]),
      0.5,
    );
    units = r.units;
    buildings = r.buildings;
    if (!units.find((x) => x.id === "a5")) break;
  }
  assert(!units.find((x) => x.id === "a5"), "retreat deposited");
}

console.log("all air-return checks passed");
