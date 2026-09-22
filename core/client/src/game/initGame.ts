import type {
  ClientToServer,
  MapConfig,
  MapSizeId,
  ResourceTerrainSync,
  TerrainMap,
} from "@wop/shared";
import { applyResourceTerrainSync, generateTerrain } from "@wop/shared";
import { log } from "../net/log";

/**
 * 初始化对局：向服务器请求清空建筑并生成地形，随后进入选都阶段。
 * 地形由服务器 seed 驱动，客户端在收到 snapshot.terrainSeed 后本地复现。
 */
export function requestGameInit(
  send: (msg: ClientToServer) => boolean,
  mapSize?: MapSizeId,
  seed?: number | string,
): boolean {
  log.info("init", "request init", { mapSize, seed });
  return send({ type: "init", mapSize, seed });
}

/** 用服务端 seed 在客户端复现同一张地形图。 */
export function applyTerrainSeed(
  map: MapConfig,
  seed: number,
  prev: TerrainMap | null,
): TerrainMap {
  if (prev && prev.seed === seed && prev.width === map.cellsX && prev.height === map.cellsY) {
    return prev;
  }
  const next = generateTerrain({ map, seed });
  log.info("init", "terrain applied", {
    seed: next.seed,
    size: `${next.width}×${next.height}`,
    deposits: next.deposits.length,
  });
  return next;
}

/**
 * Apply authoritative resource depletion onto client terrain so forest→plains
 * and oil/uranium borders disappear when reserves hit 0.
 * Returns a new terrain reference when anything changed (for React re-render).
 */
export function syncTerrainResources(
  terrain: TerrainMap,
  sync: ResourceTerrainSync | null | undefined,
): TerrainMap {
  if (!sync) return terrain;
  const changed = applyResourceTerrainSync(terrain, sync);
  if (!changed) return terrain;
  return {
    ...terrain,
    cells: terrain.cells,
    deposits: terrain.deposits.map((d) => ({ ...d, cells: d.cells.slice() })),
  };
}
