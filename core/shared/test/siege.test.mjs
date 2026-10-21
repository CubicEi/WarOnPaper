import assert from "node:assert/strict";
import test from "node:test";
import { MAP_SIZES } from "../dist/map.js";
import {
  UNIT_SIEGE_INTERVAL_SEC,
  UNIT_SIEGE_STOP_O_COST,
} from "../dist/units/catalog.js";
import { advanceFightsAndSieges } from "../dist/units/fight.js";
import { applyUnitStop } from "../dist/units/orders.js";
import { canUnitStop, isSiegeBuildingHpPhase } from "../dist/units/occupy.js";
import { advanceUnits } from "../dist/units/tick.js";

function enemyTown(id = "town") {
  return {
    id,
    buildingId: "town",
    ownerId: "def",
    gx: 20,
    gy: 20,
    hp: 3,
    hpMax: 12,
    u: 0,
    storeE: 0,
    ammo: 0,
    investedE: 100,
    buildTicksRemaining: 0,
    buildTicksTotal: 0,
  };
}

function infantrySiege(id, u, siegeBuildingId, extra = {}) {
  return {
    id,
    ownerId: "atk",
    kind: "infantry",
    u,
    gx: 20.2,
    gy: 20.2,
    carriedE: 10,
    state: "fighting",
    homeBuildingId: "home",
    siegeBuildingId,
    siegeTimerSec: 0,
    siegeDamageDealt: 0,
    siegeAirDamageDealt: 0,
    ...extra,
  };
}

const fightCtx = {
  map: MAP_SIZES["89x59"],
  terrain: null,
  liaisons: [],
  connectedByOwner: new Map(),
  nextId: () => "x",
};

test("multi-group siege: late mover does not stay fighting after capture", () => {
  const building = enemyTown();
  const onSite = infantrySiege("g1", 3, building.id);
  const incoming = {
    ...infantrySiege("g2", 2, building.id),
    state: "moving",
    siegeBuildingId: undefined,
    pendingAttackBuildingId: building.id,
    path: [
      { gx: 18, gy: 18 },
      { gx: 20.2, gy: 20.2 },
    ],
    pathIndex: 1,
  };
  let units = [onSite, incoming];
  let buildings = [building];

  const cap = advanceFightsAndSieges(units, buildings, UNIT_SIEGE_INTERVAL_SEC, fightCtx);
  units = cap.units;
  buildings = cap.buildings;
  assert.equal(buildings[0].capturePending, true);
  assert.equal(buildings[0].ownerId, "atk");
  assert.equal(units.find((u) => u.id === "g1")?.state, "idle");
  assert.equal(units.find((u) => u.id === "g1")?.siegeBuildingId, undefined);

  const move = advanceUnits(units, buildings, [], null, new Map(), 60);
  units = move.units;
  const g2 = units.find((u) => u.id === "g2");
  assert.ok(g2);
  assert.equal(g2.state, "idle");
  assert.equal(g2.siegeBuildingId, undefined);
});

test("siege HP stop: one pulse then idle", () => {
  const building = enemyTown();
  building.hp = 8;
  const unit = infantrySiege("s1", 4, building.id);
  assert.equal(isSiegeBuildingHpPhase(unit, [building], [unit]), true);
  assert.equal(canUnitStop(unit, { buildings: [building], units: [unit] }), true);

  const stop = applyUnitStop("atk", ["s1"], [unit], { buildings: [building] });
  assert.equal(stop.ok, true);
  assert.equal(stop.organizationCost, UNIT_SIEGE_STOP_O_COST);
  assert.equal(stop.energyCost, 0);
  assert.equal(stop.units[0].pendingSiegeStop, true);
  assert.equal(stop.units[0].state, "fighting");

  const after = advanceFightsAndSieges(
    stop.units,
    [building],
    UNIT_SIEGE_INTERVAL_SEC,
    fightCtx,
  );
  const u = after.units.find((x) => x.id === "s1");
  assert.equal(u?.state, "idle");
  assert.equal(u?.siegeBuildingId, undefined);
  assert.equal(u?.pendingSiegeStop, undefined);
  assert.ok((after.buildings[0]?.hp ?? 0) < building.hp);
});
