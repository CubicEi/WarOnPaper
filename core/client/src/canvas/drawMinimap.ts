import type { MapConfig, TerrainMap } from "@wop/shared";
import { getBoardLayout } from "./drawMap";
import { terrainFillColor } from "./terrainColors";

const MINIMAP_AREA_RATIO = 1 / 30;

const warningIconCache = { img: null as HTMLImageElement | null, loading: false };

function getWarningIcon(): HTMLImageElement | null {
  if (warningIconCache.img) return warningIconCache.img;
  if (!warningIconCache.loading) {
    warningIconCache.loading = true;
    const img = new Image();
    img.onload = () => {
      warningIconCache.img = img;
    };
    img.onerror = () => {
      warningIconCache.loading = false;
    };
    img.src = "/ui/warning.png";
  }
  return warningIconCache.img;
}

export interface MinimapSize {
  width: number;
  height: number;
}

/** Area = window/30, aspect = map cells (full map always visible). */
export function getMinimapSize(
  windowW: number,
  windowH: number,
  map: MapConfig,
): MinimapSize {
  const area = windowW * windowH * MINIMAP_AREA_RATIO;
  const aspect = map.cellsX / map.cellsY;
  const height = Math.sqrt(area / aspect);
  const width = height * aspect;
  return { width, height };
}

/** Viewport corners → axis-aligned rect in board UV [0,1] (may extend outside). */
export function getViewRectInBoard(
  viewW: number,
  viewH: number,
  map: MapConfig,
  pan: { x: number; y: number },
  zoom: number,
): { u0: number; v0: number; u1: number; v1: number } {
  const { boardW, boardH, originX, originY } = getBoardLayout(viewW, viewH, map);
  const cx = viewW / 2;
  const cy = viewH / 2;

  const toBoard = (sx: number, sy: number) => {
    const lx = cx + (sx - cx - pan.x) / zoom;
    const ly = cy + (sy - cy - pan.y) / zoom;
    return {
      u: (lx - originX) / boardW,
      v: (ly - originY) / boardH,
    };
  };

  const a = toBoard(0, 0);
  const b = toBoard(viewW, 0);
  const c = toBoard(viewW, viewH);
  const d = toBoard(0, viewH);

  return {
    u0: Math.min(a.u, b.u, c.u, d.u),
    v0: Math.min(a.v, b.v, c.v, d.v),
    u1: Math.max(a.u, b.u, c.u, d.u),
    v1: Math.max(a.v, b.v, c.v, d.v),
  };
}

/** Pan that centers the viewport on board UV (uc, vc). */
export function panFromBoardUV(
  uc: number,
  vc: number,
  viewW: number,
  viewH: number,
  map: MapConfig,
  zoom: number,
): { x: number; y: number } {
  const { boardW, boardH } = getBoardLayout(viewW, viewH, map);
  return {
    x: -zoom * (uc - 0.5) * boardW,
    y: -zoom * (vc - 0.5) * boardH,
  };
}

/** View rect in minimap pixel space (clipped) + unclipped board UV center. */
export function getViewRectOnMinimap(
  miniW: number,
  miniH: number,
  viewW: number,
  viewH: number,
  map: MapConfig,
  pan: { x: number; y: number },
  zoom: number,
): { x0: number; y0: number; x1: number; y1: number; uc: number; vc: number } {
  const view = getViewRectInBoard(viewW, viewH, map, pan, zoom);
  return {
    x0: Math.max(0, Math.min(miniW, view.u0 * miniW)),
    y0: Math.max(0, Math.min(miniH, view.v0 * miniH)),
    x1: Math.max(0, Math.min(miniW, view.u1 * miniW)),
    y1: Math.max(0, Math.min(miniH, view.v1 * miniH)),
    uc: (view.u0 + view.u1) / 2,
    vc: (view.v0 + view.v1) / 2,
  };
}

export function drawMinimap(
  ctx: CanvasRenderingContext2D,
  args: {
    miniW: number;
    miniH: number;
    map: MapConfig;
    viewW: number;
    viewH: number;
    pan: { x: number; y: number };
    zoom: number;
    terrain?: TerrainMap | null;
    /** Destroyed-building warning markers (board grid nodes). */
    destructionMarks?: readonly { gx: number; gy: number }[];
  },
): void {
  const {
    miniW,
    miniH,
    map,
    viewW,
    viewH,
    pan,
    zoom,
    terrain,
    destructionMarks,
  } = args;
  const dpr = devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, miniW, miniH);

  ctx.fillStyle = "#2a2a2a";
  ctx.fillRect(0, 0, miniW, miniH);

  if (terrain) {
    const cw = miniW / terrain.width;
    const ch = miniH / terrain.height;
    for (let y = 0; y < terrain.height; y++) {
      for (let x = 0; x < terrain.width; x++) {
        ctx.fillStyle = terrainFillColor(terrain, x, y);
        ctx.fillRect(x * cw, y * ch, cw + 0.5, ch + 0.5);
      }
    }
  } else {
    ctx.strokeStyle = "#4a4a4a";
    ctx.lineWidth = 1;
    const gx = Math.min(12, map.linesX);
    const gy = Math.min(10, map.linesY);
    ctx.beginPath();
    for (let i = 0; i < gx; i++) {
      const x = (i / (gx - 1)) * miniW;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, miniH);
    }
    for (let j = 0; j < gy; j++) {
      const y = (j / (gy - 1)) * miniH;
      ctx.moveTo(0, y);
      ctx.lineTo(miniW, y);
    }
    ctx.stroke();
  }

  ctx.strokeStyle = "#6a6a6a";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, miniW - 1, miniH - 1);

  if (destructionMarks && destructionMarks.length > 0) {
    const warn = getWarningIcon();
    const iconSize = Math.max(10, Math.min(miniW, miniH) * 0.08);
    for (const m of destructionMarks) {
      const px = (m.gx / map.cellsX) * miniW;
      const py = (m.gy / map.cellsY) * miniH;
      if (warn) {
        ctx.drawImage(warn, px - iconSize / 2, py - iconSize / 2, iconSize, iconSize);
      } else {
        // Fallback triangle while image loads.
        ctx.fillStyle = "#f5d000";
        ctx.beginPath();
        ctx.moveTo(px, py - iconSize * 0.45);
        ctx.lineTo(px + iconSize * 0.4, py + iconSize * 0.35);
        ctx.lineTo(px - iconSize * 0.4, py + iconSize * 0.35);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#111";
        ctx.font = `bold ${Math.max(7, iconSize * 0.55)}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("!", px, py + iconSize * 0.05);
      }
    }
  }

  const box = getViewRectOnMinimap(miniW, miniH, viewW, viewH, map, pan, zoom);
  const rw = Math.max(2, box.x1 - box.x0);
  const rh = Math.max(2, box.y1 - box.y0);

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(box.x0 + 0.75, box.y0 + 0.75, rw - 1.5, rh - 1.5);
}
