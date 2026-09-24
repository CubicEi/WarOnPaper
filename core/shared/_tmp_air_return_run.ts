import { advanceUnits } from "./src/units/tick.ts";
import { applyUnitStop, applyUnitMove } from "./src/units/orders.ts";
import { deployFromBuilding } from "./src/units/garrison.ts";

const map = { linesX: 40, linesY: 40, seed: 1 } as const;
const airportBase = {
  id: "ap1",
  buildingId: "airport" as const,
  ownerId: "p1",
  gx: 10,
  gy: 10,
  hp: 30,
  hpMax: 30,
  u: 6,
  level: 1,
  constructionProgress: 1,
};

function runRetreat() {
  const deployed = deployFromBuilding({ ...airportBase }, 2, "air1");
  if ("error" in deployed) {
    console.log("deploy fail", deployed);
    return;
  }
  let buildings = [deployed.building];
  let units = [{ ...deployed.unit, gx: 12, gy: 12, state: "idle" as const }];
  console.log("A after deploy", { u: buildings[0]!.u, away: buildings[0]!.awayOccupiedU });

  const stop = applyUnitStop(
    "p1",
    ["air1"],
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
  console.log("B retreat", {
    ok: stop.ok,
    error: stop.error,
    unit: stop.units[0] && {
      state: stop.units[0].state,
      deposit: stop.units[0].depositOnArrival,
      depositId: stop.units[0].depositBuildingId,
      retreating: stop.units[0].retreating,
      path: stop.units[0].path,
      gx: stop.units[0].gx,
      gy: stop.units[0].gy,
    },
  });
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
    if (
      r.removedIds.length ||
      units.length === 0 ||
      (units[0] &&
        units[0].state === "idle" &&
        !units[0].depositOnArrival &&
        !units[0].retreating &&
        !units[0].path)
    ) {
      console.log("C after ticks", i, {
        removed: r.removedIds,
        unitsLeft: units.map((u) => ({
          id: u.id,
          u: u.u,
          gx: u.gx,
          gy: u.gy,
          state: u.state,
          deposit: u.depositOnArrival,
          retreating: u.retreating,
        })),
        buildingU: buildings[0]!.u,
        away: buildings[0]!.awayOccupiedU,
      });
      break;
    }
  }
}

function runAutoReturn() {
  const d2 = deployFromBuilding({ ...airportBase, u: 6, awayOccupiedU: undefined }, 2, "air2");
  if ("error" in d2) return;
  let buildings = [d2.building];
  let units = [
    { ...d2.unit, gx: 12, gy: 12, state: "idle" as const, returnGx: 10, returnGy: 10 },
  ];
  console.log("D auto-return start", {
    u: buildings[0]!.u,
    away: buildings[0]!.awayOccupiedU,
  });
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
    if (i < 3) {
      console.log(
        "E tick",
        i,
        units[0] && {
          state: units[0].state,
          deposit: units[0].depositOnArrival,
          depositId: units[0].depositBuildingId,
          path: units[0].path,
          gx: units[0].gx,
          gy: units[0].gy,
        },
      );
    }
    if (
      r.removedIds.length ||
      units.length === 0 ||
      (units[0] &&
        units[0].state === "idle" &&
        !units[0].depositOnArrival &&
        !units[0].path &&
        units[0].returnGx == null)
    ) {
      console.log("F auto-return done", i, {
        removed: r.removedIds,
        unitsLeft: units.map((u) => ({
          id: u.id,
          u: u.u,
          gx: u.gx,
          gy: u.gy,
          state: u.state,
        })),
        buildingU: buildings[0]!.u,
        away: buildings[0]!.awayOccupiedU,
      });
      break;
    }
  }
}

function runMoveThenReturn() {
  const d3 = deployFromBuilding({ ...airportBase, u: 6, awayOccupiedU: undefined }, 2, "air3");
  if ("error" in d3) return;
  let buildings = [d3.building];
  let units = [d3.unit];
  const move = applyUnitMove(
    {
      ownerId: "p1",
      toGx: 12,
      toGy: 12,
      unitIds: ["air3"],
    },
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
  const u0 = move.units.find((u) => u.id === "air3");
  console.log("G move", {
    ok: move.ok,
    error: move.error,
    unit: u0 && {
      state: u0.state,
      returnGx: u0.returnGx,
      returnGy: u0.returnGy,
      path: u0.path,
      gx: u0.gx,
      gy: u0.gy,
    },
  });
  units = move.units;
  buildings = move.buildings;
  for (let i = 0; i < 400; i++) {
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
    const u = units.find((x) => x.id === "air3");
    if (i % 20 === 0) {
      console.log(
        "H tick",
        i,
        u && {
          state: u.state,
          gx: u.gx,
          gy: u.gy,
          ret: [u.returnGx, u.returnGy],
          deposit: u.depositOnArrival,
          pathLen: u.path?.length,
        },
      );
    }
    if (!u || r.removedIds.includes("air3")) {
      console.log("I move+return done", i, {
        removed: r.removedIds,
        buildingU: buildings[0]!.u,
        away: buildings[0]!.awayOccupiedU,
        leftover: units.filter((x) => x.id === "air3"),
      });
      break;
    }
    if (u.state === "idle" && !u.depositOnArrival && u.returnGx == null && !u.path) {
      console.log("I stuck idle", i, {
        u: { gx: u.gx, gy: u.gy, state: u.state },
        buildingU: buildings[0]!.u,
        away: buildings[0]!.awayOccupiedU,
      });
      break;
    }
  }
}

runRetreat();
runAutoReturn();
runMoveThenReturn();
