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
const OIL_WELL_ICON = "/icons/buildings/energy/oil_well.png";
const THERMAL_FACTORY_ICON = "/icons/buildings/energy/thermal_factory.png";
const URANIUM_MINER_ICON = "/icons/buildings/energy/uranium_miner.png";
const URANIUM_FACTORY_ICON = "/icons/buildings/energy/uranium_factory.png";

const SWITCH_MS = 10_000;
/** Pixels per map cell in the baked raster (icons ~34px at 0.85× cell). */
const CELL_PX = 40;
const ZOOM_MIN = 2.2;
const ZOOM_MAX = 2.85;
/** Screen pixels per second while a map is shown. */
const PAN_SPEED = 14;
const MAP_SIZES: MapSizeId[] = ["89x59", "119x79"];

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

type Slide = {
  url: string;
  aspect: number;
  zoom: number;
  /** Unit direction for pan. */
  dirX: number;
  dirY: number;
};

type IconSet = {
  oilWell: HTMLImageElement | null;
  thermalFactory: HTMLImageElement | null;
  uraniumMiner: HTMLImageElement | null;
  uraniumFactory: HTMLImageElement | null;
};

type GridPt = { gx: number; gy: number };

let iconsPromise: Promise<IconSet> | null = null;

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function ensureIcons(): Promise<IconSet> {
  if (!iconsPromise) {
    iconsPromise = Promise.all([
      loadImage(OIL_WELL_ICON),
      loadImage(THERMAL_FACTORY_ICON),
      loadImage(URANIUM_MINER_ICON),
      loadImage(URANIUM_FACTORY_ICON),
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

function rasterizeTerrain(terrain: TerrainMap, icons: IconSet): string {
  const canvas = document.createElement("canvas");
  canvas.width = terrain.width * CELL_PX;
  canvas.height = terrain.height * CELL_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  // Ground + forest fills
  for (let y = 0; y < terrain.height; y++) {
    for (let x = 0; x < terrain.width; x++) {
      ctx.fillStyle = terrainFillColor(terrain, x, y);
      ctx.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX + 0.5, CELL_PX + 0.5);
    }
  }

  // Oil / uranium borders (including ocean uranium — resource only)
  ctx.lineWidth = Math.max(1, CELL_PX * 0.18);
  for (let y = 0; y < terrain.height; y++) {
    for (let x = 0; x < terrain.width; x++) {
      const c = terrain.cells[y * terrain.width + x];
      if (!c?.resource) continue;
      if (c.resource.kind === "oil") {
        ctx.strokeStyle = TERRAIN_COLORS.oil;
        ctx.strokeRect(
          x * CELL_PX + 0.5,
          y * CELL_PX + 0.5,
          CELL_PX - 1,
          CELL_PX - 1,
        );
      } else if (c.resource.kind === "uranium") {
        ctx.strokeStyle = TERRAIN_COLORS.uranium;
        ctx.strokeRect(
          x * CELL_PX + 0.5,
          y * CELL_PX + 0.5,
          CELL_PX - 1,
          CELL_PX - 1,
        );
      }
    }
  }

  // Cell grid (same spirit as in-game GRID)
  ctx.strokeStyle = GRID;
  ctx.lineWidth = Math.max(1, CELL_PX * 0.06);
  ctx.beginPath();
  for (let i = 0; i <= terrain.width; i++) {
    const x = i * CELL_PX + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
  }
  for (let j = 0; j <= terrain.height; j++) {
    const y = j * CELL_PX + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
  }
  ctx.stroke();

  // Buildings on 格点 (grid nodes), same as in-game: center on node.
  // Per deposit: 50% → 1–3 extractors on land deposit corners; then 1 refinery
  // on an adjacent empty land node (ortho preferred, then diagonal).
  const iconSize = CELL_PX * 0.85;
  const half = iconSize / 2;
  const occupied = new Set<string>();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const drawAtNode = (icon: HTMLImageElement, gx: number, gy: number) => {
    ctx.drawImage(
      icon,
      gx * CELL_PX - half,
      gy * CELL_PX - half,
      iconSize,
      iconSize,
    );
  };

  for (const dep of terrain.deposits) {
    const landCells = dep.cells.filter(({ x, y }) => {
      const cell = terrain.cells[y * terrain.width + x];
      return cell != null && cell.ground !== "ocean";
    });
    if (landCells.length === 0) continue;
    if (Math.random() >= 0.5) continue;

    // Corners of land deposit cells → candidate grid nodes (integer 格点).
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
      drawAtNode(extractorIcon, gx, gy);
    }

    // One refinery next to the extractor cluster (not one per extractor).
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
    drawAtNode(refineryIcon, ref.gx, ref.gy);
  }

  return canvas.toDataURL("image/png");
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
  const url = rasterizeTerrain(terrain, icons);
  const angle = Math.random() * Math.PI * 2;
  const zoom = ZOOM_MIN + Math.random() * (ZOOM_MAX - ZOOM_MIN);
  return {
    seed,
    slide: {
      url,
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
  const [slide, setSlide] = useState<Slide | null>(null);
  const [visible, setVisible] = useState(false);
  const seedRef = useRef<number | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const slideRef = useRef<Slide | null>(null);
  const originRef = useRef({ x: 0, y: 0 });
  const startedAtRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { slide: first, seed } = await pickSlide(null);
      if (cancelled) return;
      seedRef.current = seed;
      slideRef.current = first;
      setSlide(first);
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
          setSlide(next);
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
    if (!slide) return;
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const { w, h } = coverSize(viewW, viewH, slide.aspect, slide.zoom);
    const maxX = Math.max(0, (w - viewW) / 2);
    const maxY = Math.max(0, (h - viewH) / 2);
    originRef.current = {
      x: -slide.dirX * maxX * 0.85,
      y: -slide.dirY * maxY * 0.85,
    };
    startedAtRef.current = performance.now();
  }, [slide]);

  useEffect(() => {
    let raf = 0;
    const tick = (now: number) => {
      const s = slideRef.current;
      const el = layerRef.current;
      if (s && el) {
        const viewW = window.innerWidth;
        const viewH = window.innerHeight;
        const { w, h } = coverSize(viewW, viewH, s.aspect, s.zoom);
        const maxX = Math.max(0, (w - viewW) / 2);
        const maxY = Math.max(0, (h - viewH) / 2);
        const t = (now - startedAtRef.current) / 1000;
        let x = originRef.current.x + s.dirX * PAN_SPEED * t;
        let y = originRef.current.y + s.dirY * PAN_SPEED * t;
        x = Math.max(-maxX, Math.min(maxX, x));
        y = Math.max(-maxY, Math.min(maxY, y));
        el.style.width = `${w}px`;
        el.style.height = `${h}px`;
        el.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="title-map-backdrop" aria-hidden="true">
      <div
        ref={layerRef}
        className={`title-map-layer${visible ? " is-visible" : ""}`}
      >
        {slide?.url ? (
          <img
            className="title-map-img"
            src={slide.url}
            alt=""
            draggable={false}
          />
        ) : null}
      </div>
      <div className="title-map-veil" />
    </div>
  );
}
