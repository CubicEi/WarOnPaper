import { useEffect, useRef, useState } from "react";
import {
  generateTerrain,
  type MapSizeId,
  type TerrainMap,
} from "@wop/shared";

/** Match core/client terrainColors + drawMap grid. */
const TERRAIN_COLORS = {
  ocean: "#1e3340",
  land: "#3d4a3a",
  mountain: "#5c5852",
  forest: "#2f6b3c",
  oil: "#c4a547",
  uranium: "#7ea84d",
} as const;

const GRID = "#4a4a4a";

/** White (own) building icons from core/assets — same paths as catalog. */
const OIL_WELL_ICON = "/icons/buildings/energy/oil_well.svg";
const THERMAL_FACTORY_ICON = "/icons/buildings/energy/thermal_factory.svg";
const URANIUM_MINER_ICON = "/icons/buildings/energy/uranium_miner.svg";
const URANIUM_FACTORY_ICON = "/icons/buildings/energy/uranium_factory.svg";

/** SVG building icons are authored at 256×256 (viewBox). */
const ICON_NATIVE_PX = 256;
/** Same ratio as in-game `drawBuildings` (`cell * 0.85`). */
const ICON_CELL_RATIO = 0.85;

const SWITCH_MS = 10_000;
const ZOOM_MIN = 2.2;
const ZOOM_MAX = 2.85;
/** Screen pixels per second while a map is shown. */
const PAN_SPEED = 14;
const MAP_SIZES: MapSizeId[] = ["89x59", "119x79", "179x119"];

const ORTHO_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const DIAG_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

type PlacedIcon = {
  icon: CanvasImageSource;
  gx: number;
  gy: number;
};

type Slide = {
  terrain: TerrainMap;
  placements: readonly PlacedIcon[];
  aspect: number;
  zoom: number;
  /** Unit direction for pan. */
  dirX: number;
  dirY: number;
};

type IconSet = {
  oilWell: CanvasImageSource | null;
  thermalFactory: CanvasImageSource | null;
  uraniumMiner: CanvasImageSource | null;
  uraniumFactory: CanvasImageSource | null;
};

type GridPt = { gx: number; gy: number };

let iconsPromise: Promise<IconSet> | null = null;

/**
 * Decode an SVG (or raster) icon at its authored pixel size so canvas
 * `drawImage` scales from the native 256×256 bitmap, not a tiny default intrinsic
 * (SVG assets ship with width/height="100%").
 */
async function loadIconNative(src: string): Promise<CanvasImageSource | null> {
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const ctype = res.headers.get("content-type") ?? "";
    let blob: Blob;
    if (ctype.includes("svg") || src.endsWith(".svg")) {
      let text = await res.text();
      text = text
        .replace(/\swidth="100%"/i, ` width="${ICON_NATIVE_PX}"`)
        .replace(/\sheight="100%"/i, ` height="${ICON_NATIVE_PX}"`);
      blob = new Blob([text], { type: "image/svg+xml" });
    } else {
      blob = await res.blob();
    }
    if (typeof createImageBitmap === "function") {
      try {
        return await createImageBitmap(blob, {
          resizeWidth: ICON_NATIVE_PX,
          resizeHeight: ICON_NATIVE_PX,
          resizeQuality: "high",
        });
      } catch {
        // Fall through to HTMLImageElement (some engines reject SVG bitmaps).
      }
    }
    const url = URL.createObjectURL(blob);
    try {
      return await new Promise<HTMLImageElement | null>((resolve) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => resolve(null);
        el.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return null;
  }
}

function ensureIcons(): Promise<IconSet> {
  if (!iconsPromise) {
    iconsPromise = Promise.all([
      loadIconNative(OIL_WELL_ICON),
      loadIconNative(THERMAL_FACTORY_ICON),
      loadIconNative(URANIUM_MINER_ICON),
      loadIconNative(URANIUM_FACTORY_ICON),
    ]).then(([oilWell, thermalFactory, uraniumMiner, uraniumFactory]) => ({
      oilWell,
      thermalFactory,
      uraniumMiner,
      uraniumFactory,
    }));
  }
  return iconsPromise;
}

/** Node usable if it touches at least one land/mountain cell (not pure ocean). */
function isLandGridNode(terrain: TerrainMap, gx: number, gy: number): boolean {
  for (const dx of [-1, 0] as const) {
    for (const dy of [-1, 0] as const) {
      const x = gx + dx;
      const y = gy + dy;
      if (x < 0 || y < 0 || x >= terrain.width || y >= terrain.height) continue;
      const g = terrain.cells[y * terrain.width + x]?.ground;
      if (g === "land" || g === "mountain") return true;
    }
  }
  return false;
}

function collectAdjacentLandNodes(
  terrain: TerrainMap,
  extractors: readonly GridPt[],
  occupied: ReadonlySet<string>,
  dirs: ReadonlyArray<readonly [number, number]>,
): GridPt[] {
  const seen = new Set<string>();
  const out: GridPt[] = [];
  for (const { gx: ex, gy: ey } of extractors) {
    for (const [dx, dy] of dirs) {
      const gx = ex + dx;
      const gy = ey + dy;
      if (gx < 0 || gy < 0 || gx > terrain.width || gy > terrain.height) {
        continue;
      }
      const key = `${gx},${gy}`;
      if (occupied.has(key) || seen.has(key)) continue;
      if (!isLandGridNode(terrain, gx, gy)) continue;
      seen.add(key);
      out.push({ gx, gy });
    }
  }
  return out;
}

function terrainFillColor(map: TerrainMap, x: number, y: number): string {
  const cell = map.cells[y * map.width + x];
  if (!cell) return TERRAIN_COLORS.ocean;
  if (cell.resource?.kind === "forest") return TERRAIN_COLORS.forest;
  return TERRAIN_COLORS[cell.ground];
}

function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

/**
 * Place extractors / refineries (same rules as before). Drawing is deferred to
 * the live canvas pass so icons stay at native SVG resolution.
 */
function placeDecorations(terrain: TerrainMap, icons: IconSet): PlacedIcon[] {
  const occupied = new Set<string>();
  const placements: PlacedIcon[] = [];

  for (const dep of terrain.deposits) {
    const landCells = dep.cells.filter(({ x, y }) => {
      const cell = terrain.cells[y * terrain.width + x];
      return cell != null && cell.ground !== "ocean";
    });
    if (landCells.length === 0) continue;
    if (Math.random() >= 0.5) continue;

    const nodeKeys = new Set<string>();
    const nodes: GridPt[] = [];
    for (const { x, y } of landCells) {
      for (const [gx, gy] of [
        [x, y],
        [x + 1, y],
        [x, y + 1],
        [x + 1, y + 1],
      ] as const) {
        if (gx < 0 || gy < 0 || gx > terrain.width || gy > terrain.height) {
          continue;
        }
        const key = `${gx},${gy}`;
        if (nodeKeys.has(key) || occupied.has(key)) continue;
        nodeKeys.add(key);
        nodes.push({ gx, gy });
      }
    }
    if (nodes.length === 0) continue;

    const extractorIcon =
      dep.kind === "oil" ? icons.oilWell : icons.uraniumMiner;
    const refineryIcon =
      dep.kind === "oil" ? icons.thermalFactory : icons.uraniumFactory;
    if (!extractorIcon) continue;

    const count = 1 + ((Math.random() * Math.min(3, nodes.length)) | 0);
    const picks = shuffleInPlace(nodes.slice()).slice(0, count);
    for (const { gx, gy } of picks) {
      occupied.add(`${gx},${gy}`);
      placements.push({ icon: extractorIcon, gx, gy });
    }

    if (!refineryIcon) continue;
    let refinerySpots = collectAdjacentLandNodes(
      terrain,
      picks,
      occupied,
      ORTHO_DIRS,
    );
    if (refinerySpots.length === 0) {
      refinerySpots = collectAdjacentLandNodes(
        terrain,
        picks,
        occupied,
        DIAG_DIRS,
      );
    }
    if (refinerySpots.length === 0) continue;
    const ref = shuffleInPlace(refinerySpots.slice())[0]!;
    occupied.add(`${ref.gx},${ref.gy}`);
    placements.push({ icon: refineryIcon, gx: ref.gx, gy: ref.gy });
  }

  return placements;
}

/**
 * Draw like in-game `drawMap` terrain stack:
 * fill → grid → oil/uranium borders → building icons.
 * `cell` is CSS px per map cell in the current camera frame.
 */
function drawSlide(
  ctx: CanvasRenderingContext2D,
  slide: Slide,
  originX: number,
  originY: number,
  cell: number,
): void {
  const { terrain, placements } = slide;

  for (let y = 0; y < terrain.height; y++) {
    for (let x = 0; x < terrain.width; x++) {
      ctx.fillStyle = terrainFillColor(terrain, x, y);
      ctx.fillRect(
        originX + x * cell,
        originY + y * cell,
        cell + 0.5,
        cell + 0.5,
      );
    }
  }

  ctx.strokeStyle = GRID;
  ctx.lineWidth = Math.max(1, cell * 0.06);
  ctx.beginPath();
  for (let i = 0; i <= terrain.width; i++) {
    const x = originX + i * cell + 0.5;
    ctx.moveTo(x, originY);
    ctx.lineTo(x, originY + terrain.height * cell);
  }
  for (let j = 0; j <= terrain.height; j++) {
    const y = originY + j * cell + 0.5;
    ctx.moveTo(originX, y);
    ctx.lineTo(originX + terrain.width * cell, y);
  }
  ctx.stroke();

  ctx.lineWidth = Math.max(1, cell * 0.18);
  for (let y = 0; y < terrain.height; y++) {
    for (let x = 0; x < terrain.width; x++) {
      const c = terrain.cells[y * terrain.width + x];
      if (!c?.resource) continue;
      if (c.resource.kind === "oil") {
        ctx.strokeStyle = TERRAIN_COLORS.oil;
        ctx.strokeRect(
          originX + x * cell + 0.5,
          originY + y * cell + 0.5,
          cell - 1,
          cell - 1,
        );
      } else if (c.resource.kind === "uranium") {
        ctx.strokeStyle = TERRAIN_COLORS.uranium;
        ctx.strokeRect(
          originX + x * cell + 0.5,
          originY + y * cell + 0.5,
          cell - 1,
          cell - 1,
        );
      }
    }
  }

  const iconSize = cell * ICON_CELL_RATIO;
  const half = iconSize / 2;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  for (const { icon, gx, gy } of placements) {
    ctx.drawImage(
      icon,
      originX + gx * cell - half,
      originY + gy * cell - half,
      iconSize,
      iconSize,
    );
  }
}

async function pickSlide(
  prevSeed: number | null,
): Promise<{ slide: Slide; seed: number }> {
  const icons = await ensureIcons();
  let seed = (Math.random() * 0xffffffff) >>> 0;
  if (prevSeed != null && seed === prevSeed) {
    seed = (seed + 0x9e3779b9) >>> 0;
  }
  const map = MAP_SIZES[(Math.random() * MAP_SIZES.length) | 0]!;
  const terrain = generateTerrain({ map, seed });
  const placements = placeDecorations(terrain, icons);
  const angle = Math.random() * Math.PI * 2;
  const zoom = ZOOM_MIN + Math.random() * (ZOOM_MAX - ZOOM_MIN);
  return {
    seed,
    slide: {
      terrain,
      placements,
      aspect: terrain.width / terrain.height,
      zoom,
      dirX: Math.cos(angle),
      dirY: Math.sin(angle),
    },
  };
}

function coverSize(
  viewW: number,
  viewH: number,
  aspect: number,
  zoom: number,
): { w: number; h: number } {
  const viewAspect = viewW / viewH;
  let w: number;
  let h: number;
  if (viewAspect > aspect) {
    w = viewW;
    h = viewW / aspect;
  } else {
    h = viewH;
    w = viewH * aspect;
  }
  return { w: w * zoom, h: h * zoom };
}

export function TitleMapBackdrop() {
  const [visible, setVisible] = useState(false);
  const seedRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const slideRef = useRef<Slide | null>(null);
  const originRef = useRef({ x: 0, y: 0 });
  const startedAtRef = useRef(0);

  const resetCameraOrigin = (slide: Slide) => {
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const { w, h } = coverSize(viewW, viewH, slide.aspect, slide.zoom);
    const maxX = Math.max(0, (w - viewW) / 2);
    const maxY = Math.max(0, (h - viewH) / 2);
    originRef.current = {
      x: -slide.dirX * maxX * 0.85,
      y: -slide.dirY * maxY * 0.85,
    };
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { slide: first, seed } = await pickSlide(null);
      if (cancelled) return;
      seedRef.current = seed;
      slideRef.current = first;
      startedAtRef.current = performance.now();
      resetCameraOrigin(first);
      requestAnimationFrame(() => {
        if (!cancelled) setVisible(true);
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let fadeTimer = 0;
    let cancelled = false;
    const timer = window.setInterval(() => {
      setVisible(false);
      window.clearTimeout(fadeTimer);
      fadeTimer = window.setTimeout(() => {
        void (async () => {
          const { slide: next, seed } = await pickSlide(seedRef.current);
          if (cancelled) return;
          seedRef.current = seed;
          slideRef.current = next;
          startedAtRef.current = performance.now();
          resetCameraOrigin(next);
          requestAnimationFrame(() => {
            if (!cancelled) setVisible(true);
          });
        })();
      }, 420);
    }, SWITCH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.clearTimeout(fadeTimer);
    };
  }, []);

  useEffect(() => {
    let raf = 0;
    const tick = (now: number) => {
      const slide = slideRef.current;
      const canvas = canvasRef.current;
      if (slide && canvas) {
        const viewW = window.innerWidth;
        const viewH = window.innerHeight;
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const bw = Math.max(1, Math.round(viewW * dpr));
        const bh = Math.max(1, Math.round(viewH * dpr));
        if (canvas.width !== bw || canvas.height !== bh) {
          canvas.width = bw;
          canvas.height = bh;
        }
        canvas.style.width = `${viewW}px`;
        canvas.style.height = `${viewH}px`;

        const { w, h } = coverSize(viewW, viewH, slide.aspect, slide.zoom);
        const maxX = Math.max(0, (w - viewW) / 2);
        const maxY = Math.max(0, (h - viewH) / 2);
        const t = (now - startedAtRef.current) / 1000;
        let x = originRef.current.x + slide.dirX * PAN_SPEED * t;
        let y = originRef.current.y + slide.dirY * PAN_SPEED * t;
        x = Math.max(-maxX, Math.min(maxX, x));
        y = Math.max(-maxY, Math.min(maxY, y));

        const cell = w / slide.terrain.width;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, viewW, viewH);
          // Map layer centered on viewport, then pan (same as former CSS translate).
          const originX = (viewW - w) / 2 + x;
          const originY = (viewH - h) / 2 + y;
          drawSlide(ctx, slide, originX, originY, cell);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="title-map-backdrop" aria-hidden="true">
      <canvas
        ref={canvasRef}
        className={`title-map-canvas${visible ? " is-visible" : ""}`}
      />
      <div className="title-map-veil" />
    </div>
  );
}
