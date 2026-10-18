import assert from "node:assert/strict";
import test from "node:test";
import { applyUnitDamage, resolveCombatRound } from "../dist/units/combat.js";
import {
  applyCarrierDeploy,
  applyCarrierSortie,
  applyUnitStop,
} from "../dist/units/orders.js";
import { advanceUnits } from "../dist/units/tick.js";
import {
  applyBuildCarrier,
  applyCarrierSortieLaunch,
  applyEmbarkAir,
  carrierAirRoom,
} from "../dist/units/carrier.js";
import {
  CARRIER_AIR_CAPACITY,
  CARRIER_BUILD_E,
  CARRIER_DEPLOY_O_COST,
  CARRIER_DOCK_REPAIR_INTERVAL_SEC,
  UNIT_BY_KIND,
  UNIT_STOP_E_COST,
  UNIT_STOP_O_COST,
} from "../dist/units/catalog.js";
import { canUnitStop } from "../dist/units/occupy.js";
import { MAP_SIZES } from "../dist/map.js";

function portWithHull() {
  return {
    id: "port",
    buildingId: "port",
    ownerId: "owner",
    gx: 10,
    gy: 10,
    hp: 12,
    hpMax: 12,
    u: 1,
    storeE: 0,
    ammo: 0,
    investedE: 90,
    buildTicksRemaining: 0,
    buildTicksTotal: 0,
  };
}

function oceanTerrain() {
  return {
    seed: 1,
    width: 89,
    height: 59,
    cells: Array.from({ length: 89 * 59 }, () => ({ ground: "ocean", resource: null })),
    deposits: [],
  };
}

function carrierAt(gx = 10, gy = 10, state = "idle", path) {
  return {
    id: "carrier",
    ownerId: "owner",
    kind: "navy_carrier",
    u: 1,
    hullHp: 10,
    gx,
    gy,
    carriedE: 20,
    state,
    homeBuildingId: "port",
    path,
    pathIndex: path ? 1 : undefined,
    embarkedAirU: 2,
    embarkedAirHomeBuildingId: "airport-a",
    embarkedAirByHome: [{ homeBuildingId: "airport-a", u: 2 }],
  };
}

function sortieWorld(carrier, targetUnit) {
  return {
    map: MAP_SIZES["89x59"],
    terrain: oceanTerrain(),
    buildings: [portWithHull()],
    liaisons: [],
    units: [carrier, targetUnit],
    connectedIds: new Set(),
    nextId: (() => {
      let id = 0;
      return () => `sortie-${++id}`;
    })(),
  };
}

test("carrier costs 2000E, starts at 10 hull HP, and carries 5U", () => {
  const built = applyBuildCarrier(
    "owner",
    "port",
    [portWithHull()],
    [],
    () => "carrier",
  );

  assert.equal(CARRIER_BUILD_E, 2000);
  assert.equal(CARRIER_AIR_CAPACITY, 5);
  assert.equal(UNIT_BY_KIND.navy_carrier.hp, 10);
  assert.equal(UNIT_BY_KIND.navy_carrier.carryEMax, 20);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.energyCost, 2000);
  assert.equal(built.units[0].hullHp, 10);
  assert.equal(built.units[0].carriedE, 20);
  assert.equal(carrierAirRoom(built.units[0], built.units), 5);
});

test("carrier hull damage accumulates until the 10th HP is removed", () => {
  const first = applyUnitDamage(1, "navy_carrier", 2, 10);
  assert.deepEqual(first, { u: 1, hullHp: 8 });

  const second = applyUnitDamage(first.u, "navy_carrier", 8, first.hullHp);
  assert.deepEqual(second, { u: 0, hullHp: 0 });

  const round = resolveCombatRound(2, "infantry", 1, "navy_carrier", undefined, 10);
  assert.equal(round.ub1, 1);
  assert.equal(round.hullHpB, 8);
});

test("sorties retain airport origins and reserve hangar capacity", () => {
  const carrier = {
    id: "carrier",
    ownerId: "owner",
    kind: "navy_carrier",
    u: 1,
    hullHp: 10,
    gx: 10,
    gy: 10,
    carriedE: 20,
    state: "idle",
    homeBuildingId: "port",
    embarkedAirU: 5,
    embarkedAirByHome: [
      { homeBuildingId: "airport-a", u: 2 },
      { homeBuildingId: "airport-b", u: 3 },
    ],
  };
  const launched = applyCarrierSortieLaunch(
    "owner",
    carrier.id,
    3,
    [carrier],
    (() => {
      let id = 0;
      return () => `air-${++id}`;
    })(),
  );

  assert.equal(launched.ok, true);
  if (!launched.ok) return;
  const nextCarrier = launched.units.find((unit) => unit.id === carrier.id);
  const aircraft = launched.units.filter((unit) => unit.carrierId === carrier.id);
  assert.equal(nextCarrier.embarkedAirU, 2);
  assert.deepEqual(
    aircraft.map(({ homeBuildingId, u }) => ({ homeBuildingId, u })),
    [
      { homeBuildingId: "airport-a", u: 2 },
      { homeBuildingId: "airport-b", u: 1 },
    ],
  );
  assert.equal(carrierAirRoom(nextCarrier, launched.units), 0);
});

test("returning sortie can reclaim its reserved hangar slot", () => {
  const carrier = {
    id: "carrier",
    ownerId: "owner",
    kind: "navy_carrier",
    u: 1,
    hullHp: 10,
    gx: 10,
    gy: 10,
    carriedE: 20,
    state: "idle",
    homeBuildingId: "port",
    embarkedAirU: 4,
    embarkedAirHomeBuildingId: "airport-a",
    embarkedAirByHome: [{ homeBuildingId: "airport-a", u: 4 }],
  };
  const returner = {
    id: "returner",
    ownerId: "owner",
    kind: "air",
    u: 1,
    gx: 10,
    gy: 10,
    carriedE: 0,
    state: "idle",
    homeBuildingId: "airport-b",
    carrierId: "carrier",
  };

  const returned = applyEmbarkAir(
    "owner",
    carrier.id,
    returner.id,
    1,
    [carrier, returner],
    [],
  );
  assert.equal(returned.ok, true);
  if (!returned.ok) return;
  const nextCarrier = returned.units.find((unit) => unit.id === carrier.id);
  assert.equal(nextCarrier.embarkedAirU, 5);
  assert.deepEqual(nextCarrier.embarkedAirByHome, [
    { homeBuildingId: "airport-a", u: 4 },
    { homeBuildingId: "airport-b", u: 1 },
  ]);
});

test("sortie aborts when the moving carrier takes its target out of range", () => {
  const carrier = carrierAt(10, 10, "moving", [
    { gx: 10, gy: 10 },
    { gx: 8, gy: 10 },
  ]);
  const target = {
    id: "target",
    ownerId: "enemy",
    kind: "infantry",
    u: 2,
    gx: 18,
    gy: 10,
    carriedE: 0,
    state: "idle",
    homeBuildingId: "enemy-base",
  };
  const world = sortieWorld(carrier, target);
  const order = applyCarrierSortie(
    { ownerId: "owner", carrierId: carrier.id, u: 2, targetUnitId: target.id },
    world,
  );
  assert.equal(order.ok, true);
  if (!order.ok) return;

  const moved = advanceUnits(order.units, order.buildings, [], world.terrain, new Map(), 0.2);
  const enemy = moved.units.find((unit) => unit.id === target.id);
  const ship = moved.units.find((unit) => unit.id === carrier.id);
  assert.equal(enemy.u, 2);
  assert.equal(ship.embarkedAirU, 2);
  assert.equal(moved.units.some((unit) => unit.carrierId === carrier.id), false);
});

test("successful hit-and-run returns to and automatically re-embarks on the carrier", () => {
  const carrier = carrierAt();
  const target = {
    id: "target",
    ownerId: "enemy",
    kind: "infantry",
    u: 1,
    gx: 11,
    gy: 10,
    carriedE: 0,
    state: "idle",
    homeBuildingId: "enemy-base",
  };
  const world = sortieWorld(carrier, target);
  const order = applyCarrierSortie(
    { ownerId: "owner", carrierId: carrier.id, u: 2, targetUnitId: target.id },
    world,
  );
  assert.equal(order.ok, true);
  if (!order.ok) return;

  const strike = advanceUnits(order.units, order.buildings, [], world.terrain, new Map(), 1);
  assert.equal(strike.units.some((unit) => unit.id === target.id), false);
  assert.equal(
    strike.units.some((unit) => unit.carrierId === carrier.id && unit.carrierSortieState === "returning_carrier"),
    true,
  );

  const returned = advanceUnits(strike.units, strike.buildings, [], world.terrain, new Map(), 1);
  const ship = returned.units.find((unit) => unit.id === carrier.id);
  assert.equal(ship.embarkedAirU, 2);
  assert.equal(returned.units.some((unit) => unit.carrierId === carrier.id), false);
});

test("a sortie whose carrier is destroyed diverts to its original airport", () => {
  const airport = {
    ...portWithHull(),
    id: "airport-a",
    buildingId: "airport",
    gx: 20,
    gy: 20,
    u: 7,
    awayOccupiedU: 1,
  };
  const air = {
    id: "sortie-air",
    ownerId: "owner",
    kind: "air",
    u: 1,
    gx: 10,
    gy: 10,
    carriedE: 0,
    state: "idle",
    homeBuildingId: airport.id,
    returnGx: airport.gx,
    returnGy: airport.gy,
    carrierId: "destroyed-carrier",
    carrierSortieState: "returning_carrier",
    retreating: true,
  };
  const terrain = oceanTerrain();
  const returning = advanceUnits(
    [air],
    [airport],
    [],
    terrain,
    new Map(),
    0.2,
  );
  const result = advanceUnits(
    returning.units,
    returning.buildings,
    [],
    terrain,
    new Map(),
    10,
  );
  assert.equal(result.units.some((unit) => unit.id === air.id), false);
  assert.equal(result.buildings[0].u, 8);
  assert.equal(result.buildings[0].awayOccupiedU, undefined);
});

test("carrier retreat parks beside its port without entering the garrison", () => {
  const built = applyBuildCarrier(
    "owner",
    "port",
    [portWithHull()],
    [],
    () => "carrier",
  );
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const carrier = { ...built.units[0], gx: 20, gy: 20 };
  const retreat = applyUnitStop(
    "owner",
    [carrier.id],
    [carrier],
    {
      buildings: built.buildings,
      connectedIds: new Set(),
      terrain: oceanTerrain(),
      liaisons: [],
      map: MAP_SIZES["89x59"],
    },
    { retreat: true },
  );
  assert.equal(retreat.ok, true);
  const result = advanceUnits(
    retreat.units,
    retreat.buildings ?? built.buildings,
    [],
    oceanTerrain(),
    new Map(),
    100,
  );
  const parked = result.units.find((unit) => unit.id === carrier.id);
  assert.ok(parked);
  assert.equal(parked.state, "docked");
  assert.equal(parked.retreating, undefined);
  assert.notDeepEqual({ gx: parked.gx, gy: parked.gy }, { gx: 10, gy: 10 });
  assert.ok(Math.hypot(parked.gx - 10, parked.gy - 10) <= 1.1);
  assert.equal(result.buildings[0].u, 0);
  assert.equal(result.buildings[0].awayOccupiedU, 1);
});
test("carrier display name is 母舰", () => {
  assert.equal(UNIT_BY_KIND.navy_carrier.name, "母舰");
});

test("carrier deploy boards airport air for 5O and embarks on arrival", () => {
  const airport = {
    ...portWithHull(),
    id: "airport-a",
    buildingId: "airport",
    gx: 12,
    gy: 10,
    u: 3,
  };
  const carrier = {
    ...carrierAt(10, 10),
    embarkedAirU: 0,
    embarkedAirHomeBuildingId: undefined,
    embarkedAirByHome: undefined,
  };
  const deployed = applyCarrierDeploy(
    {
      ownerId: "owner",
      carrierId: carrier.id,
      sources: [{ buildingId: airport.id, u: 2 }],
    },
    {
      map: MAP_SIZES["89x59"],
      terrain: oceanTerrain(),
      buildings: [portWithHull(), airport],
      liaisons: [],
      units: [carrier],
      connectedIds: new Set(),
      nextId: (() => {
        let id = 0;
        return () => "board-" + ++id;
      })(),
    },
  );
  assert.equal(deployed.ok, true);
  if (!deployed.ok) return;
  assert.equal(deployed.organizationCost, CARRIER_DEPLOY_O_COST);
  assert.equal(CARRIER_DEPLOY_O_COST, 5);
  const air = deployed.units.find((unit) => unit.kind === "air");
  assert.ok(air);
  assert.equal(air.carrierSortieState, "boarding");
  assert.equal(air.carrierId, carrier.id);
  assert.equal(
    deployed.buildings.find((b) => b.id === airport.id).u,
    1,
  );
  assert.equal(
    deployed.buildings.find((b) => b.id === airport.id).awayOccupiedU,
    2,
  );

  const arrived = advanceUnits(
    deployed.units,
    deployed.buildings,
    [],
    oceanTerrain(),
    new Map(),
    10,
  );
  const ship = arrived.units.find((unit) => unit.id === carrier.id);
  assert.equal(ship.embarkedAirU, 2);
  assert.equal(arrived.units.some((unit) => unit.kind === "air"), false);
  const airportAfter = arrived.buildings.find((b) => b.id === airport.id);
  assert.equal(airportAfter.u, 1);
  assert.equal(airportAfter.awayOccupiedU, undefined);
});

test("docked carrier repairs 1 hull HP every 2 seconds", () => {
  const carrier = {
    ...carrierAt(),
    state: "docked",
    hullHp: 7,
    dockRepairTimerSec: 0,
    embarkedAirU: 0,
    embarkedAirByHome: undefined,
  };
  const after = advanceUnits(
    [carrier],
    [portWithHull()],
    [],
    oceanTerrain(),
    new Map(),
    CARRIER_DOCK_REPAIR_INTERVAL_SEC,
  );
  assert.equal(after.units[0].hullHp, 8);
  assert.equal(after.units[0].state, "docked");
});

test("stop is free for holding/blockade and costs only while moving", () => {
  const holding = {
    ...carrierAt(),
    kind: "infantry",
    state: "holding",
    holdBuildingId: "port",
    hullHp: undefined,
    embarkedAirU: undefined,
    embarkedAirByHome: undefined,
  };
  const moving = {
    ...holding,
    id: "mover",
    state: "moving",
    path: [
      { gx: 10, gy: 10 },
      { gx: 12, gy: 10 },
    ],
    pathIndex: 1,
    holdBuildingId: undefined,
  };
  const idle = { ...holding, id: "idle", state: "idle", holdBuildingId: undefined };

  assert.equal(canUnitStop(holding), true);
  assert.equal(canUnitStop(moving), true);
  assert.equal(canUnitStop(idle), false);
  assert.equal(canUnitStop({ ...moving, retreating: true }), false);

  const stopHold = applyUnitStop(
    "owner",
    [holding.id],
    [holding],
    {
      buildings: [portWithHull()],
      connectedIds: new Set(),
      terrain: oceanTerrain(),
      liaisons: [],
      map: MAP_SIZES["89x59"],
    },
  );
  assert.equal(stopHold.ok, true);
  assert.equal(stopHold.organizationCost, 0);
  assert.equal(stopHold.energyCost, 0);

  const stopMove = applyUnitStop(
    "owner",
    [moving.id],
    [moving],
    {
      buildings: [portWithHull()],
      connectedIds: new Set(),
      terrain: oceanTerrain(),
      liaisons: [],
      map: MAP_SIZES["89x59"],
    },
  );
  assert.equal(stopMove.ok, true);
  assert.equal(stopMove.organizationCost, UNIT_STOP_O_COST);
  assert.equal(stopMove.energyCost, UNIT_STOP_E_COST);
});
