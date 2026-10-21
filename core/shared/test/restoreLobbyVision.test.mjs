import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectRestoreDownloaderOwnerIds,
  filterBuildingsForRestoreHolderViewer,
  filterBuildingsForRestoreLobbyViewer,
  filterLiaisonsForRestoreHolderViewer,
  filterLiaisonsForRestoreLobbyViewer,
  filterUnitsForRestoreHolderViewer,
  restoreHolderOverviewBuildings,
  restoreHolderOverviewLiaisons,
  restoreHolderOverviewUnits,
} from "../dist/index.js";

test("collectRestoreDownloaderOwnerIds excludes holder", () => {
  const map = new Map([
    ["holder-live", "save-holder"],
    ["dl-live", "save-dl"],
  ]);
  const ids = collectRestoreDownloaderOwnerIds(map, "holder-live");
  assert.equal(ids.has("holder-live"), false);
  assert.equal(ids.has("save-holder"), false);
  assert.equal(ids.has("dl-live"), true);
  assert.equal(ids.has("save-dl"), true);
});

test("restore holder scoped overview includes downloader small buildings and fiber only", () => {
  const holder = "holder-live";
  const downloaderOwners = collectRestoreDownloaderOwnerIds(
    new Map([
      [holder, "save-holder"],
      ["dl-live", "save-dl"],
    ]),
    holder,
  );
  const buildings = [
    {
      id: "b-dl",
      buildingId: "outpost",
      ownerId: "dl-live",
      gx: 1,
      gy: 1,
      hp: 10,
      hpMax: 10,
      u: 0,
      storeE: 0,
      ammo: 0,
      investedE: 0,
      buildTicksRemaining: 0,
      buildTicksTotal: 0,
    },
    {
      id: "b-other",
      buildingId: "outpost",
      ownerId: "save-unclaimed",
      gx: 2,
      gy: 2,
      hp: 10,
      hpMax: 10,
      u: 0,
      storeE: 0,
      ammo: 0,
      investedE: 0,
      buildTicksRemaining: 0,
      buildTicksTotal: 0,
    },
    {
      id: "b-cap",
      buildingId: "capital",
      ownerId: "save-unclaimed",
      gx: 5,
      gy: 5,
      hp: 100,
      hpMax: 100,
      u: 0,
      storeE: 0,
      ammo: 0,
      investedE: 0,
      buildTicksRemaining: 0,
      buildTicksTotal: 0,
    },
  ];
  const out = filterBuildingsForRestoreHolderViewer(
    buildings,
    holder,
    downloaderOwners,
    [],
    null,
  );
  assert.equal(out.length, 2);
  assert.ok(out.some((b) => b.id === "b-dl" && b.buildingId === "outpost"));
  assert.ok(out.some((b) => b.id === "b-cap"));
  assert.ok(!out.some((b) => b.id === "b-other"));

  const liaisons = [
    {
      id: "l-dl",
      kind: "fiber",
      ownerId: "dl-live",
      nodes: [
        { gx: 0, gy: 0 },
        { gx: 1, gy: 0 },
      ],
      investedE: 5,
      buildTicksRemaining: 0,
      buildTicksTotal: 0,
    },
    {
      id: "l-other",
      kind: "fiber",
      ownerId: "save-unclaimed",
      nodes: [
        { gx: 0, gy: 0 },
        { gx: 1, gy: 0 },
      ],
      investedE: 0,
      buildTicksRemaining: 0,
      buildTicksTotal: 0,
    },
  ];
  const lines = filterLiaisonsForRestoreHolderViewer(
    liaisons,
    buildings,
    holder,
    downloaderOwners,
    null,
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, "l-dl");
  assert.equal(lines[0].kind, "fiber");
});

test("restore holder overview helpers still map full downloader asset sets", () => {
  const buildings = [
    {
      id: "b1",
      buildingId: "outpost",
      ownerId: "enemy",
      gx: 1,
      gy: 1,
      hp: 10,
      hpMax: 10,
      u: 0,
      storeE: 0,
      ammo: 0,
      investedE: 0,
      buildTicksRemaining: 0,
      buildTicksTotal: 0,
    },
  ];
  const out = restoreHolderOverviewBuildings(buildings);
  assert.equal(out.length, 1);
  assert.equal(out[0].buildingId, "outpost");
  assert.equal(out[0].visionLevel, "satellite");

  const liaisons = [
    {
      id: "l1",
      kind: "fiber",
      ownerId: "enemy",
      nodes: [{ gx: 0, gy: 0 }, { gx: 1, gy: 0 }],
      investedE: 5,
      buildTicksRemaining: 0,
      buildTicksTotal: 0,
    },
  ];
  const lines = restoreHolderOverviewLiaisons(liaisons);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, "fiber");
});

test("restore lobby non-holder uses satellite filter only", () => {
  const buildings = [
    {
      id: "b1",
      buildingId: "outpost",
      ownerId: "enemy",
      gx: 1,
      gy: 1,
      hp: 10,
      hpMax: 10,
      u: 0,
      storeE: 0,
      ammo: 0,
      investedE: 0,
      buildTicksRemaining: 0,
      buildTicksTotal: 0,
    },
    {
      id: "b2",
      buildingId: "capital",
      ownerId: "enemy",
      gx: 5,
      gy: 5,
      hp: 100,
      hpMax: 100,
      u: 0,
      storeE: 0,
      ammo: 0,
      investedE: 0,
      buildTicksRemaining: 0,
      buildTicksTotal: 0,
    },
  ];
  const viewer = "me";
  const filtered = filterBuildingsForRestoreLobbyViewer(buildings, viewer, [], null);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].buildingId, "capital");

  const liaisons = [
    {
      id: "l1",
      kind: "fiber",
      ownerId: "enemy",
      nodes: [{ gx: 0, gy: 0 }, { gx: 1, gy: 0 }],
      investedE: 0,
      buildTicksRemaining: 0,
      buildTicksTotal: 0,
    },
  ];
  const lines = filterLiaisonsForRestoreLobbyViewer(
    liaisons,
    buildings,
    viewer,
    null,
  );
  assert.equal(lines.length, 0);
});

test("restore holder scoped units: downloader only", () => {
  const holder = "holder-live";
  const downloaderOwners = collectRestoreDownloaderOwnerIds(
    new Map([["dl-live", "save-dl"]]),
    holder,
  );
  const units = [
    {
      id: "u-dl",
      ownerId: "dl-live",
      kind: "infantry",
      u: 3,
      gx: 2,
      gy: 2,
      carriedE: 0,
      state: "idle",
      homeBuildingId: "b1",
    },
    {
      id: "u-other",
      ownerId: "save-unclaimed",
      kind: "infantry",
      u: 2,
      gx: 3,
      gy: 3,
      carriedE: 0,
      state: "idle",
      homeBuildingId: "b2",
    },
  ];
  const scoped = filterUnitsForRestoreHolderViewer(
    units,
    holder,
    downloaderOwners,
    [],
    null,
  );
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].id, "u-dl");
  assert.equal(scoped[0].strengthHidden, true);

  const all = restoreHolderOverviewUnits(units, holder, null);
  assert.equal(all.length, 2);
});
