import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyRandomHpDamage,
  applyUnitDamage,
  fullUHp,
  repairWorstSubUnit,
  resolveCombatRound,
  siegeDamageFromBuilding,
  totalUnitHp,
} from "../dist/index.js";

test("random HP damage removes U when a slot reaches 0", () => {
  const hit = applyRandomHpDamage(
    2,
    "armor",
    4,
    [3, 3],
    () => 0,
  );
  assert.equal(hit.u, 1);
  assert.equal(hit.uHp.length, 1);
  assert.equal(hit.uHp[0], 2);
});

test("resolveCombatRound tracks uHp for field units", () => {
  const round = resolveCombatRound(
    2,
    "armor",
    2,
    "armor",
    undefined,
    undefined,
    fullUHp("armor", 2),
    fullUHp("armor", 2),
    () => 0,
  );
  assert.equal(round.ua1 + round.ub1, 4);
  assert.ok(round.uHpA);
  assert.ok(round.uHpB);
  assert.equal(round.uHpA.length, round.ua1);
  assert.equal(round.uHpB.length, round.ub1);
});

test("supply repair picks the most damaged sub-unit", () => {
  const uHp = [3, 1, 3];
  const repaired = repairWorstSubUnit(3, "armor", uHp);
  assert.equal(repaired.repaired, true);
  assert.deepEqual(repaired.uHp, [3, 2, 3]);
});

test("mortar-style damage returns uHp array", () => {
  const result = applyUnitDamage(2, "armor", 2, undefined, fullUHp("armor", 2), () => 0);
  assert.ok(result.uHp);
  assert.equal(result.uHp.length, result.u);
  assert.equal(totalUnitHp({ kind: "armor", u: result.u, uHp: result.uHp }), 4);
});

test("building siege retaliation chips HP before losing U", () => {
  const u = 3;
  const dmg = siegeDamageFromBuilding(u);
  assert.equal(dmg, 1);
  const result = applyUnitDamage(u, "armor", dmg, undefined, fullUHp("armor", u), () => 0);
  assert.equal(result.u, 3);
  assert.equal(result.uHp.length, 3);
  assert.equal(totalUnitHp({ kind: "armor", u: result.u, uHp: result.uHp }), 8);
});
