import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  MapConfig,
  TerrainMap,
  GroundContext,
  PlacedBuilding,
  PlacedLiaison,
  BuildingDef,
  GamePhase,
  ResourceSightCell,
  LiaisonKind,
  GridNode,
  UnitGroup,
  PollutionZone,
} from "@wop/shared";
import {
  cellAt,
  findBuildingAt,
  findBuildingNear,
  findUnitNear,
  findLiaisonNear,
  findLiaisonSegmentNear,
  workRangeCircles,
  isInsideWorkRange,
  snapToBuildNode,
  snapToIntegerNode,
  snapToUnitCoord,
  canUnitStop,
  isMovingState,
  previewUnitMove,
  previewTrainingDeliveryPath,
  applyAssignHome,
  unitKindFromBuilding,
  extendLiaisonPath,
  bluntLiaisonPath,
  previewLiaisonCost,
  withLiaisonTerrainSurcharge,
  demolishLiaisonRefundE,
  hasRailwayOriginStationAt,
  findOwnedRailwayStationNear,
  anchorRailwayEndpoints,
  railwayEndpointRejectReason,
  roadRailTerrainSurchargeE,
  isValidPortSite,
  isBuildingCommsLinked,
  nukeReloadRejectReason,
  LIAISON_BY_ID,
  capitalSiteRejectReason,
  capitalSiteRejectMessage,
  availableTrainingRoom,
} from "@wop/shared";
import {
  clampPan,
  drawMap,
  getBoardLayout,
  hitFireAimCancel,
  layoutToScreen,
  mapFitMargin,
  MAP_ZOOM_MAX,
  MAP_ZOOM_MIN,
  panAfterZoomAt,
  pickGridPoint,
  pickGridCoord,
  SEL_RING_OUTER,
} from "./drawMap";
import {
  drawMinimap,
  getMinimapSize,
  getViewRectOnMinimap,
  panFromBoardUV,
} from "./drawMinimap";
import {
  PointActionMenu,
  POINT_ACTIONS,
  CAPITAL_PICK_ACTIONS,
  type PointActionId,
} from "../components/PointActionMenu";
import { BuildModeOverlay } from "../components/BuildModeOverlay";
import { MobilizePanel } from "../components/MobilizePanel";
import { TrainPanel } from "../components/TrainPanel";
import { BuildingInspectHud, type BuildingInspectAction } from "../components/BuildingInspectHud";
import { UnitInspectHud, type UnitInspectAction } from "../components/UnitInspectHud";
import { ChatPanel, type ChatMessage } from "../components/ChatPanel";
import { log } from "../net/log";
import { logLocalReject } from "../debug/playerActionLog";
import type { TrainableKind } from "@wop/shared";

interface Props {
  map: MapConfig | null;
  terrain?: TerrainMap | null;
  buildings?: readonly PlacedBuilding[];
  liaisons?: readonly PlacedLiaison[];
  resourceSight?: readonly ResourceSightCell[];
  connectedBuildingIds?: readonly string[];
  pollutionZones?: readonly PollutionZone[];
  units?: readonly UnitGroup[];
  width: number;
  height: number;
  phase?: GamePhase;
  /** Local player id for own vs enemy building icon colors. */
  myPlayerId?: string | null;
  onBuild?: (args: {
    buildingId: string;
    gx: number;
    gy: number;
    ground: GroundContext;
  }) => void;
  onBuildLiaison?: (args: { kind: LiaisonKind; nodes: GridNode[] }) => void;
  onDemolishLiaison?: (id: string) => void;
  onDemolish?: (buildingId: string) => void;
  onRepair?: (buildingId: string) => void;
  onLevelUpgrade?: (buildingId: string) => void;
  onRelocateCapital?: (buildingId: string) => void;
  onReload?: (buildingId: string, count: number) => void;
  onBuildCarrier?: (buildingId: string) => void;
  onEmbarkAir?: (carrierId: string, airUnitId: string, u?: number) => void;
  onDisembarkAir?: (carrierId: string, u?: number) => void;
  onDeploy?: (buildingId: string, count: number) => void;
  onTrain?: (args: {
    id: string;
    kind: TrainableKind;
    u: number;
    targetIds: string[];
  }) => void;
  onFire?: (
    buildingId: string,
    target: { targetId?: string; targetUnitId?: string },
  ) => void;
  onPlaceCapital?: (gx: number, gy: number) => void;
  onMoveUnits?: (args: {
    gx: number;
    gy: number;
    sources?: Array<{ buildingId: string; u: number }>;
    unitIds?: string[];
  }) => void;
  onStopUnits?: (unitIds: string[], retreat?: boolean) => void;
  onBlockadeUnits?: (args: {
    gx: number;
    gy: number;
    sources?: Array<{ buildingId: string; u: number }>;
    unitIds?: string[];
  }) => void;
  onEndBlockade?: (unitIds: string[]) => void;
  onSupplyUnits?: (args: {
    supplyBuildingId: string;
    gx: number;
    gy: number;
    sources?: Array<{ buildingId: string; u: number }>;
    unitIds?: string[];
  }) => void;
  onAttackUnits?: (args: {
    sources?: Array<{ buildingId: string; u: number }>;
    unitIds?: string[];
    targetUnitId?: string;
    targetBuildingId?: string;
    targetLiaisonId?: string;
    liaisonAx?: number;
    liaisonAy?: number;
    liaisonBx?: number;
    liaisonBy?: number;
  }) => void;
  onHoldUnits?: (args: {
    holdBuildingId: string;
    sources?: Array<{ buildingId: string; u: number }>;
    unitIds?: string[];
  }) => void;
  onEndHold?: (unitIds: string[]) => void;
  onAssignHome?: (args: { buildingId: string; unitIds: string[] }) => void;
  onMutualDefense?: (buildingId: string, partnerBuildingId: string) => void;
  onEndMutualDefense?: (buildingId: string) => void;
  /** Local player energy for reload and deploy affordance. */
  energy?: number;
  /** Local organization. Reload and deploy each spend 1 O. */
  organization?: number;
  /** Server tick for launch cooldown UI. */
  tick?: number;
  /** Player roster for owner-name display. */
  playerNames?: readonly { id: string; name: string }[];
  /** Draw known enemy building + unit vision circles. */
  showEnemyVision?: boolean;
  /** Overlay own building / liaison / radio-range communication status. */
  showCommStatus?: boolean;
  chatMessages?: readonly ChatMessage[];
  onSendChat?: (text: string) => void;
}

interface SelectionView {
  kind: "point" | "building" | "unit";
  gx: number;
  gy: number;
  screenX: number;
  screenY: number;
  /** Placed building id when kind === "building". */
  buildingId?: string;
  /** Unit group id when kind === "unit". */
  unitId?: string;
}

/** Button centers sit just outside the half-ring along a right-side arc. */
const ACTION_BTN_R = 18;
const ACTION_ARC_RADIUS = SEL_RING_OUTER + ACTION_BTN_R + 10;
/** Unit inspect: place the unit at ~38% width (center-left), vertical center. */
const UNIT_FOCUS_X_RATIO = 0.38;
/** Pan/zoom camera tween when focusing a building or fitting fire range. */
const CAMERA_FOCUS_MS = 500;
/** CSS ease-in-out equivalent: accelerate then decelerate. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function GameCanvas({
  map,
  terrain = null,
  buildings = [],
  liaisons = [],
  resourceSight = [],
  connectedBuildingIds = [],
  pollutionZones = [],
  units = [],
  width,
  height,
  phase = "need_init",
  myPlayerId = null,
  onBuild,
  onBuildLiaison,
  onDemolishLiaison,
  onDemolish,
  onRepair,
  onLevelUpgrade,
  onRelocateCapital,
  onReload,
  onBuildCarrier,
  onEmbarkAir,
  onDisembarkAir,
  onDeploy,
  onTrain,
  onFire,
  onPlaceCapital,
  onMoveUnits,
  onStopUnits,
  onBlockadeUnits,
  onEndBlockade,
  onSupplyUnits,
  onAttackUnits,
  onHoldUnits,
  onEndHold,
  onAssignHome,
  onMutualDefense,
  onEndMutualDefense,
  energy = 0,
  organization = 0,
  tick = 0,
  playerNames = [],
  showEnemyVision = false,
  showCommStatus = false,
  chatMessages = [],
  onSendChat,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const miniRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef(map);
  const terrainRef = useRef(terrain);
  const buildingsRef = useRef(buildings);
  const liaisonsRef = useRef(liaisons);
  const resourceSightRef = useRef(resourceSight);
  const connectedIdsRef = useRef(connectedBuildingIds);
  const pollutionZonesRef = useRef(pollutionZones);
  const unitsRef = useRef(units);
  const myPlayerIdRef = useRef(myPlayerId);
  const showEnemyVisionRef = useRef(showEnemyVision);
  const showCommStatusRef = useRef(showCommStatus);
  const tickRef = useRef(tick);
  const destructionMarksRef = useRef<
    Array<{ gx: number; gy: number; expiresAt: number }>
  >([]);
  const prevBuildingsForDestroyRef = useRef<readonly PlacedBuilding[]>([]);
  /** Own demolish requests — skip minimap destroy warnings for these ids. */
  const pendingDemolishIdsRef = useRef(new Set<string>());
  const sizeRef = useRef({ width, height });
  const miniSizeRef = useRef({ width: 0, height: 0 });
  const panRef = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(MAP_ZOOM_MIN);
  const cameraAnimRef = useRef<number | null>(null);
  /** Pending building focus (delay before camera + inspect HUD). */
  const pendingBuildingFocusRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** While set, pan keeps this unit centered (cleared with selection / camera cancel). */
  const followUnitIdRef = useRef<string | null>(null);
  const dragRef = useRef<{
    ox: number;
    oy: number;
    px: number;
    py: number;
    moved: boolean;
    /** Liaison draw: defer path start until drag past click threshold. */
    liaisonPending?: boolean;
    /** Ctrl+drag pans even while a liaison stroke would otherwise be drawn. */
    panGesture?: boolean;
  } | null>(null);
  /** Active pointer positions (client coords) for multi-touch pinch. */
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{
    startDist: number;
    startZoom: number;
    startPan: { x: number; y: number };
    startMid: { x: number; y: number };
  } | null>(null);
  /** True after a pinch this gesture; suppress click on final finger-up. */
  const pinchWasActiveRef = useRef(false);
  const miniDragRef = useRef<{
    grabDu: number;
    grabDv: number;
  } | null>(null);
  const pointerRef = useRef({ x: width / 2, y: height / 2 });
  const selectionRef = useRef<{ gx: number; gy: number } | null>(null);
  const liaisonKindRef = useRef<LiaisonKind | null>(null);
  const liaisonDraftRef = useRef<GridNode[] | null>(null);
  const liaisonEditActiveRef = useRef(false);
  const liaisonAwaitConfirmRef = useRef(false);
  const liaisonDemolishIdRef = useRef<string | null>(null);
  const onBuildLiaisonRef = useRef(onBuildLiaison);
  const onDemolishLiaisonRef = useRef(onDemolishLiaison);
  const onDemolishRef = useRef(onDemolish);
  const onFireRef = useRef(onFire);
  /** Pointer sample for liaison draw speed → blunting. */
  const liaisonSpeedRef = useRef<{
    gx: number;
    gy: number;
    t: number;
    /** Peak Du/s during current stroke (for release blunt). */
    peak: number;
  } | null>(null);

  const [miniSize, setMiniSize] = useState({ width: 0, height: 0 });
  const [selectionUi, setSelectionUi] = useState<SelectionView | null>(null);
  /** Building inspect HUD waits until focus-to-center pan finishes. */
  const [inspectHudReady, setInspectHudReady] = useState(false);
  const [buildMode, setBuildMode] = useState<{
    fromX: number;
    fromY: number;
    gx: number;
    gy: number;
    currentBuildingId: string | null;
    ground: GroundContext;
    /** Set when build request sent; cleared when building appears or user closes. */
    pendingBuildingId?: string;
    pendingLiaisonKind?: LiaisonKind;
    initialMode?: "buildings" | "liaison";
    liaisonNonce?: number;
  } | null>(null);
  const [liaisonKind, setLiaisonKind] = useState<LiaisonKind | null>(null);
  const [liaisonDraft, setLiaisonDraft] = useState<GridNode[] | null>(null);
  const [liaisonEditActive, setLiaisonEditActive] = useState(false);
  const [liaisonAwaitConfirm, setLiaisonAwaitConfirm] = useState(false);
  const [liaisonDemolishId, setLiaisonDemolishId] = useState<string | null>(null);
  const [liaisonLocalError, setLiaisonLocalError] = useState<string | null>(null);
  const [shiftDemolishHint, setShiftDemolishHint] = useState(false);
  const [fireAim, setFireAim] = useState<string | null>(null);
  const [fireAimNote, setFireAimNote] = useState("选择目标");
  const [mobilize, setMobilize] = useState<{
    mode: "move" | "blockade" | "supply" | "attack" | "hold" | "assign";
    gx: number;
    gy: number;
    sources: Record<string, number>;
    unitIds: string[];
    supplyBuildingId?: string;
    holdBuildingId?: string;
    targetUnitId?: string;
    targetBuildingId?: string;
    targetLiaisonId?: string;
    liaisonAx?: number;
    liaisonAy?: number;
    liaisonBx?: number;
    liaisonBy?: number;
    assignBuildingId?: string;
  } | null>(null);
  const [focusMarks, setFocusMarks] = useState<{ id: string; gx: number; gy: number }[]>([]);
  const focusMarksRef = useRef(focusMarks);
  const pathPreviewsRef = useRef<Array<Array<{ gx: number; gy: number }>>>([]);
  const [mutualAim, setMutualAim] = useState<string | null>(null);
  const [mutualAimNote, setMutualAimNote] = useState("选择互防伙伴");
  const [enemyLiaison, setEnemyLiaison] = useState<{
    id: string;
    ax: number;
    ay: number;
    bx: number;
    by: number;
    gx: number;
    gy: number;
    screenX: number;
    screenY: number;
  } | null>(null);
  const mutualAimRef = useRef<string | null>(null);
  const [trainUi, setTrainUi] = useState<{
    sourceId: string;
    kind: TrainableKind;
    u: number;
    targetIds: string[];
  } | null>(null);
  const selectionUiRef = useRef(selectionUi);
  const buildModeRef = useRef(buildMode);
  const enemyLiaisonRef = useRef(enemyLiaison);
  const mobilizeRef = useRef(mobilize);
  const trainUiRef = useRef(trainUi);
  const shiftHintRef = useRef<HTMLDivElement>(null);
  const fireHintRef = useRef<HTMLDivElement>(null);
  const mutualHintRef = useRef<HTMLDivElement>(null);
  const fireAimRef = useRef<string | null>(null);
  const shiftHeldRef = useRef(false);
  const mouseClientRef = useRef({ x: width / 2, y: height / 2 });
  const workRangeRef = useRef<{ gx: number; gy: number; radiusDu: number }[]>([]);

  mapRef.current = map;
  terrainRef.current = terrain;
  buildingsRef.current = buildings;
  liaisonsRef.current = liaisons;
  resourceSightRef.current = resourceSight;
  connectedIdsRef.current = connectedBuildingIds;
  pollutionZonesRef.current = pollutionZones;
  unitsRef.current = units;
  myPlayerIdRef.current = myPlayerId;
  showEnemyVisionRef.current = showEnemyVision;
  showCommStatusRef.current = showCommStatus;
  tickRef.current = tick;
  sizeRef.current = { width, height };
  miniSizeRef.current = miniSize;
  liaisonKindRef.current = liaisonKind;
  liaisonDraftRef.current = liaisonDraft;
  liaisonEditActiveRef.current = liaisonEditActive;
  liaisonAwaitConfirmRef.current = liaisonAwaitConfirm;
  liaisonDemolishIdRef.current = liaisonDemolishId;
  onBuildLiaisonRef.current = onBuildLiaison;
  onDemolishLiaisonRef.current = onDemolishLiaison;
  onDemolishRef.current = onDemolish;
  onFireRef.current = onFire;
  fireAimRef.current = fireAim;
  mutualAimRef.current = mutualAim;
  selectionUiRef.current = selectionUi;
  focusMarksRef.current = focusMarks;

  // Detect destroyed buildings → temporary minimap warning markers.
  // Only own buildings (fog cannot hide them); skip self-demolish ids.
  useEffect(() => {
    const prev = prevBuildingsForDestroyRef.current;
    const nextIds = new Set(buildings.map((b) => b.id));
    const now = performance.now();
    const me = myPlayerIdRef.current;
    const pending = pendingDemolishIdsRef.current;
    const added: Array<{ gx: number; gy: number; expiresAt: number }> = [];
    for (const b of prev) {
      if (nextIds.has(b.id)) continue;
      if (pending.has(b.id)) {
        pending.delete(b.id);
        continue;
      }
      if (me == null || b.ownerId !== me) continue;
      added.push({ gx: b.gx, gy: b.gy, expiresAt: now + 12_000 });
    }
    if (added.length > 0) {
      destructionMarksRef.current = [
        ...destructionMarksRef.current.filter((m) => m.expiresAt > now),
        ...added,
      ];
    } else {
      destructionMarksRef.current = destructionMarksRef.current.filter(
        (m) => m.expiresAt > now,
      );
    }
    prevBuildingsForDestroyRef.current = buildings;
  }, [buildings]);
  buildModeRef.current = buildMode;
  enemyLiaisonRef.current = enemyLiaison;
  mobilizeRef.current = mobilize;
  trainUiRef.current = trainUi;

  const onLiaisonKindChange = useCallback((kind: LiaisonKind | null) => {
    setLiaisonKind(kind);
    setLiaisonDraft(null);
    setLiaisonAwaitConfirm(false);
    setLiaisonDemolishId(null);
    setLiaisonLocalError(null);
  }, []);

  const onLiaisonEditActiveChange = useCallback((active: boolean) => {
    setLiaisonEditActive(active);
    if (!active) {
      setLiaisonDraft(null);
      setLiaisonAwaitConfirm(false);
      setLiaisonDemolishId(null);
    }
  }, []);

  const cancelPendingBuildingFocus = () => {
    if (pendingBuildingFocusRef.current != null) {
      clearTimeout(pendingBuildingFocusRef.current);
      pendingBuildingFocusRef.current = null;
    }
  };

  const exitFireAim = () => {
    setFireAim(null);
    setFireAimNote("选择目标");
  };

  const clearSelection = () => {
    cancelPendingBuildingFocus();
    cancelCameraAnim();
    followUnitIdRef.current = null;
    selectionRef.current = null;
    setSelectionUi(null);
    setInspectHudReady(false);
    // Fire-aim mode exits only via the × cancel chip (exitFireAim).
    setMutualAim(null);
    setEnemyLiaison(null);
  };

  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // Hide ring / actions when terrain is (re)generated; keep build mode if mid-pick
  useEffect(() => {
    clearSelection();
    exitFireAim();
    setBuildMode(null);
  }, [terrain?.seed]);

  const gridScreenAt = (gx: number, gy: number) => {
    const m = mapRef.current;
    if (!m) return null;
    const { width: w, height: h } = sizeRef.current;
    const { cell, originX, originY } = getBoardLayout(w, h, m);
    return layoutToScreen(
      originX + gx * cell,
      originY + gy * cell,
      w,
      h,
      panRef.current,
      zoomRef.current,
    );
  };

  const cancelCameraAnim = () => {
    if (cameraAnimRef.current != null) {
      cancelAnimationFrame(cameraAnimRef.current);
      cameraAnimRef.current = null;
    }
    // Same gestures that cancel a focus tween also drop unit camera follow.
    followUnitIdRef.current = null;
  };

  /** Animate pan (+ optional zoom) over CAMERA_FOCUS_MS with ease-in-out. */
  const animateCameraTo = (
    targetPan: { x: number; y: number },
    targetZoom: number,
    onDone?: () => void,
  ) => {
    cancelCameraAnim();
    const fromPan = { ...panRef.current };
    const fromZoom = zoomRef.current;
    const dx = targetPan.x - fromPan.x;
    const dy = targetPan.y - fromPan.y;
    const dz = targetZoom - fromZoom;
    if (Math.hypot(dx, dy) < 0.5 && Math.abs(dz) < 1e-4) {
      panRef.current = targetPan;
      zoomRef.current = targetZoom;
      onDone?.();
      return;
    }
    const t0 = performance.now();
    const step = (now: number) => {
      const u = Math.min(1, (now - t0) / CAMERA_FOCUS_MS);
      const e = easeInOutCubic(u);
      panRef.current = {
        x: fromPan.x + dx * e,
        y: fromPan.y + dy * e,
      };
      zoomRef.current = fromZoom + dz * e;
      if (u < 1) {
        cameraAnimRef.current = requestAnimationFrame(step);
      } else {
        cameraAnimRef.current = null;
        panRef.current = targetPan;
        zoomRef.current = targetZoom;
        onDone?.();
      }
    };
    cameraAnimRef.current = requestAnimationFrame(step);
  };

  /** Pan so (gx,gy) lands at a target screen point, then clamp. */
  const panGridToScreen = (gx: number, gy: number, targetX: number, targetY: number) => {
    const m = mapRef.current;
    if (!m) return;
    const { width: w, height: h } = sizeRef.current;
    const { cell, originX, originY, boardW, boardH } = getBoardLayout(w, h, m);
    const lx = originX + gx * cell;
    const ly = originY + gy * cell;
    const z = zoomRef.current;
    const cx = w / 2;
    const cy = h / 2;
    panRef.current = clampPan(
      {
        x: targetX - cx - z * (lx - cx),
        y: targetY - cy - z * (ly - cy),
      },
      w,
      h,
      boardW,
      boardH,
      z,
    );
  };

  /** Target pan (clamped) that places (gx,gy) at a screen point with given zoom. */
  const panForGridAtScreen = (
    gx: number,
    gy: number,
    targetX: number,
    targetY: number,
    zoom: number,
  ) => {
    const m = mapRef.current;
    if (!m) return null;
    const { width: w, height: h } = sizeRef.current;
    const { cell, originX, originY, boardW, boardH } = getBoardLayout(w, h, m);
    const lx = originX + gx * cell;
    const ly = originY + gy * cell;
    const cx = w / 2;
    const cy = h / 2;
    return clampPan(
      {
        x: targetX - cx - zoom * (lx - cx),
        y: targetY - cy - zoom * (ly - cy),
      },
      w,
      h,
      boardW,
      boardH,
      zoom,
    );
  };

  /** Zoom + pan so all work-range circles (incl. radar) fit in the viewport. */
  const fitWorkRangeCircles = (
    circles: readonly { gx: number; gy: number; radiusDu: number }[],
  ) => {
    const m = mapRef.current;
    if (!m || circles.length === 0) return;
    const { width: w, height: h } = sizeRef.current;
    const { cell, originX, originY, boardW, boardH } = getBoardLayout(w, h, m);
    let minGx = Infinity;
    let maxGx = -Infinity;
    let minGy = Infinity;
    let maxGy = -Infinity;
    for (const c of circles) {
      minGx = Math.min(minGx, c.gx - c.radiusDu);
      maxGx = Math.max(maxGx, c.gx + c.radiusDu);
      minGy = Math.min(minGy, c.gy - c.radiusDu);
      maxGy = Math.max(maxGy, c.gy + c.radiusDu);
    }
    const lx0 = originX + minGx * cell;
    const ly0 = originY + minGy * cell;
    const lx1 = originX + maxGx * cell;
    const ly1 = originY + maxGy * cell;
    const boxW = Math.max(1, lx1 - lx0);
    const boxH = Math.max(1, ly1 - ly0);
    const margin = mapFitMargin(w, h);
    const zFit = Math.min(
      MAP_ZOOM_MAX,
      Math.max(
        MAP_ZOOM_MIN,
        Math.min((w - 2 * margin) / boxW, (h - 2 * margin) / boxH),
      ),
    );
    const lcx = (lx0 + lx1) / 2;
    const lcy = (ly0 + ly1) / 2;
    const cx = w / 2;
    const cy = h / 2;
    const pan = clampPan(
      {
        x: -zFit * (lcx - cx),
        y: -zFit * (lcy - cy),
      },
      w,
      h,
      boardW,
      boardH,
      zFit,
    );
    animateCameraTo(pan, zFit);
  };

  /** Zoom + pan so a march polyline (start, end, and all waypoints) fits the viewport. */
  const fitPathNodes = (
    nodes: readonly { gx: number; gy: number }[],
    onDone?: () => void,
  ) => {
    const m = mapRef.current;
    if (!m || nodes.length === 0) {
      onDone?.();
      return;
    }
    let minGx = Infinity;
    let maxGx = -Infinity;
    let minGy = Infinity;
    let maxGy = -Infinity;
    for (const n of nodes) {
      minGx = Math.min(minGx, n.gx);
      maxGx = Math.max(maxGx, n.gx);
      minGy = Math.min(minGy, n.gy);
      maxGy = Math.max(maxGy, n.gy);
    }
    // Keep a usable bbox when start≈end or the path is nearly colinear.
    const minSpan = 2;
    if (maxGx - minGx < minSpan) {
      const mid = (minGx + maxGx) / 2;
      minGx = mid - minSpan / 2;
      maxGx = mid + minSpan / 2;
    }
    if (maxGy - minGy < minSpan) {
      const mid = (minGy + maxGy) / 2;
      minGy = mid - minSpan / 2;
      maxGy = mid + minSpan / 2;
    }
    const pad = 1.5;
    const { width: w, height: h } = sizeRef.current;
    const { cell, originX, originY, boardW, boardH } = getBoardLayout(w, h, m);
    const lx0 = originX + (minGx - pad) * cell;
    const ly0 = originY + (minGy - pad) * cell;
    const lx1 = originX + (maxGx + pad) * cell;
    const ly1 = originY + (maxGy + pad) * cell;
    const boxW = Math.max(1, lx1 - lx0);
    const boxH = Math.max(1, ly1 - ly0);
    const margin = mapFitMargin(w, h);
    const zFit = Math.min(
      MAP_ZOOM_MAX,
      Math.max(
        MAP_ZOOM_MIN,
        Math.min((w - 2 * margin) / boxW, (h - 2 * margin) / boxH),
      ),
    );
    const lcx = (lx0 + lx1) / 2;
    const lcy = (ly0 + ly1) / 2;
    const cx = w / 2;
    const cy = h / 2;
    const pan = clampPan(
      {
        x: -zFit * (lcx - cx),
        y: -zFit * (lcy - cy),
      },
      w,
      h,
      boardW,
      boardH,
      zFit,
    );
    animateCameraTo(pan, zFit, onDone);
  };

  const closeMobilize = () => {
    setMobilize(null);
    setFocusMarks([]);
  };

  const planError = useMemo(() => {
    if (!mobilize || !map || !terrain || myPlayerId == null) return null;
    if (mobilize.mode === "attack" && mobilize.targetLiaisonId) return null;
    const sources = Object.entries(mobilize.sources).map(([buildingId, u]) => ({
      buildingId,
      u,
    }));
    const unitIds = mobilize.unitIds;
    if (mobilize.mode !== "assign" && sources.length === 0 && unitIds.length === 0) return null;
    if (mobilize.mode === "assign" && unitIds.length === 0) return null;
    let n = 0;
    const ctx = {
      map,
      terrain,
      buildings,
      liaisons,
      units,
      connectedIds: connectedBuildingIds,
      nextId: () => `preview-${++n}`,
    };
    if (mobilize.mode === "assign") {
      if (!mobilize.assignBuildingId) return "请选择建筑";
      const result = applyAssignHome(myPlayerId, mobilize.assignBuildingId, unitIds, ctx);
      return result.ok ? null : (result.error ?? "无法归属");
    }
    const result = previewUnitMove(
      {
        ownerId: myPlayerId,
        gx: mobilize.gx,
        gy: mobilize.gy,
        sources: sources.length > 0 ? sources : undefined,
        unitIds: unitIds.length > 0 ? unitIds : undefined,
        asBlockade: mobilize.mode === "blockade",
        asSupply: mobilize.mode === "supply",
        supplyBuildingId: mobilize.supplyBuildingId,
        asHold: mobilize.mode === "hold",
        holdBuildingId: mobilize.holdBuildingId,
        attackTargetUnitId: mobilize.mode === "attack" ? mobilize.targetUnitId : undefined,
        attackTargetBuildingId:
          mobilize.mode === "attack" ? mobilize.targetBuildingId : undefined,
      },
      ctx,
    );
    return result.ok ? null : (result.error ?? "无法调动");
  }, [
    mobilize,
    map,
    terrain,
    buildings,
    liaisons,
    units,
    connectedBuildingIds,
    myPlayerId,
  ]);

  /** Dry-run march polylines for checked mobilize sources / train targets. */
  const marchPathPreviews = useMemo(() => {
    const paths: Array<Array<{ gx: number; gy: number }>> = [];
    if (!map || !terrain || myPlayerId == null) return paths;
    let n = 0;
    const ctx = {
      map,
      terrain,
      buildings,
      liaisons,
      units,
      connectedIds: connectedBuildingIds,
      nextId: () => `preview-${++n}`,
    };
    if (
      mobilize &&
      mobilize.mode !== "assign" &&
      !(mobilize.mode === "attack" && mobilize.targetLiaisonId)
    ) {
      const base = {
        ownerId: myPlayerId,
        gx: mobilize.gx,
        gy: mobilize.gy,
        asBlockade: mobilize.mode === "blockade",
        asSupply: mobilize.mode === "supply",
        supplyBuildingId: mobilize.supplyBuildingId,
        asHold: mobilize.mode === "hold",
        holdBuildingId: mobilize.holdBuildingId,
        attackTargetUnitId: mobilize.mode === "attack" ? mobilize.targetUnitId : undefined,
        attackTargetBuildingId:
          mobilize.mode === "attack" ? mobilize.targetBuildingId : undefined,
      };
      for (const [buildingId, u] of Object.entries(mobilize.sources)) {
        const result = previewUnitMove({ ...base, sources: [{ buildingId, u }] }, ctx);
        for (const p of result.paths) paths.push(p);
      }
      for (const id of mobilize.unitIds) {
        const result = previewUnitMove({ ...base, unitIds: [id] }, ctx);
        for (const p of result.paths) paths.push(p);
      }
    }
    if (trainUi) {
      const source = buildings.find((b) => b.id === trainUi.sourceId);
      if (source) {
        for (const tid of trainUi.targetIds) {
          const target = buildings.find((b) => b.id === tid);
          if (!target) continue;
          const result = previewTrainingDeliveryPath(
            myPlayerId,
            trainUi.kind,
            source.gx,
            source.gy,
            target.gx,
            target.gy,
            target.id,
            ctx,
          );
          if (result.path.length >= 2) paths.push(result.path);
        }
      }
    }
    return paths;
  }, [
    mobilize,
    trainUi,
    map,
    terrain,
    buildings,
    liaisons,
    units,
    connectedBuildingIds,
    myPlayerId,
  ]);
  pathPreviewsRef.current = marchPathPreviews;

  const setSelectionAt = (
    gx: number,
    gy: number,
    opts?: {
      kind?: "point" | "building" | "unit";
      buildingId?: string;
      unitId?: string;
      /** When selecting a unit, pan viewport so it sits center-left. */
      focusCenterLeft?: boolean;
      /** Animate building/unit to viewport center, then reveal inspect HUD. */
      focusCenter?: boolean;
    },
  ) => {
    const m = mapRef.current;
    if (!m) return;
    const { width: w, height: h } = sizeRef.current;
    const kind = opts?.kind ?? "point";
    const useFocusCenter =
      !!opts?.focusCenter && (kind === "building" || kind === "unit");

    cancelPendingBuildingFocus();

    if (!useFocusCenter) {
      cancelCameraAnim();
      if (kind === "unit" && opts?.focusCenterLeft) {
        setInspectHudReady(true);
        panGridToScreen(gx, gy, w * UNIT_FOCUS_X_RATIO, h / 2);
      } else if (kind === "building") {
        setInspectHudReady(true);
      } else {
        setInspectHudReady(false);
      }
    }

    const screen = gridScreenAt(gx, gy);
    if (!screen) return;
    selectionRef.current = kind === "point" ? { gx, gy } : null;
    setEnemyLiaison(null);
    setSelectionUi({
      kind,
      gx,
      gy,
      screenX: screen.x,
      screenY: screen.y,
      buildingId: opts?.buildingId,
      unitId: opts?.unitId,
    });

    if (useFocusCenter) {
      setInspectHudReady(false);
      const startFocusAnim = () => {
        pendingBuildingFocusRef.current = null;
        const stillSelected =
          kind === "building"
            ? selectionUiRef.current?.kind === "building" &&
              selectionUiRef.current.buildingId === opts?.buildingId
            : kind === "unit"
              ? selectionUiRef.current?.kind === "unit" &&
                selectionUiRef.current.unitId === opts?.unitId
              : false;
        if (!stillSelected) return;

        const targetPan = panForGridAtScreen(gx, gy, w / 2, h / 2, zoomRef.current);
        if (!targetPan) {
          if (kind === "unit" && opts?.unitId) followUnitIdRef.current = opts.unitId;
          setInspectHudReady(true);
          return;
        }
        // animateCameraTo → cancelCameraAnim clears follow; re-enable after settle for units.
        animateCameraTo(targetPan, zoomRef.current, () => {
          const stillAfterAnim =
            kind === "building"
              ? selectionUiRef.current?.kind === "building" &&
                selectionUiRef.current.buildingId === opts?.buildingId
              : kind === "unit"
                ? selectionUiRef.current?.kind === "unit" &&
                  selectionUiRef.current.unitId === opts?.unitId
                : false;
          if (!stillAfterAnim) {
            setInspectHudReady(true);
            return;
          }
          const liveGx =
            kind === "unit" && opts?.unitId
              ? (unitsRef.current.find((u) => u.id === opts.unitId)?.gx ?? gx)
              : gx;
          const liveGy =
            kind === "unit" && opts?.unitId
              ? (unitsRef.current.find((u) => u.id === opts.unitId)?.gy ?? gy)
              : gy;
          if (kind === "unit" && opts?.unitId) {
            const { width: cw, height: ch } = sizeRef.current;
            panGridToScreen(liveGx, liveGy, cw / 2, ch / 2);
            followUnitIdRef.current = opts.unitId;
          }
          const settled = gridScreenAt(liveGx, liveGy);
          if (!settled) {
            setInspectHudReady(true);
            return;
          }
          setSelectionUi((cur) => {
            if (!cur) return cur;
            if (
              kind === "building" &&
              cur.kind === "building" &&
              cur.buildingId === opts?.buildingId
            ) {
              return { ...cur, gx: liveGx, gy: liveGy, screenX: settled.x, screenY: settled.y };
            }
            if (kind === "unit" && cur.kind === "unit" && cur.unitId === opts?.unitId) {
              return { ...cur, gx: liveGx, gy: liveGy, screenX: settled.x, screenY: settled.y };
            }
            return cur;
          });
          setInspectHudReady(true);
        });
      };

      startFocusAnim();
    }
  };

  /** Light-cyan ring + path fit + inspect HUD for panel row toggles. */
  const syncFocus = (
    id: string,
    gx: number,
    gy: number,
    on: boolean,
    opts?: {
      kind: "building" | "unit";
      buildingId?: string;
      unitId?: string;
      /** Planned march polyline; camera fits this instead of centering the building/unit. */
      path?: Array<{ gx: number; gy: number }> | null;
    },
  ) => {
    setFocusMarks((cur) => {
      const without = cur.filter((m) => m.id !== id);
      return on ? [...without, { id, gx, gy }] : without;
    });
    if (!on) {
      const sel = selectionUiRef.current;
      if (
        opts?.kind === "building" &&
        sel?.kind === "building" &&
        sel.buildingId === opts.buildingId
      ) {
        clearSelection();
      } else if (
        opts?.kind === "unit" &&
        sel?.kind === "unit" &&
        sel.unitId === opts.unitId
      ) {
        clearSelection();
      }
      return;
    }

    const path = opts?.path;
    const revealHud = () => {
      const liveGx =
        opts?.kind === "unit" && opts.unitId
          ? (unitsRef.current.find((u) => u.id === opts.unitId)?.gx ?? gx)
          : opts?.kind === "building" && opts.buildingId
            ? (buildingsRef.current.find((b) => b.id === opts.buildingId)?.gx ?? gx)
            : gx;
      const liveGy =
        opts?.kind === "unit" && opts.unitId
          ? (unitsRef.current.find((u) => u.id === opts.unitId)?.gy ?? gy)
          : opts?.kind === "building" && opts.buildingId
            ? (buildingsRef.current.find((b) => b.id === opts.buildingId)?.gy ?? gy)
            : gy;
      const settled = gridScreenAt(liveGx, liveGy);
      if (!settled) {
        setInspectHudReady(true);
        return;
      }
      setSelectionUi((cur) => {
        if (!cur) return cur;
        if (
          opts?.kind === "building" &&
          cur.kind === "building" &&
          cur.buildingId === opts.buildingId
        ) {
          return { ...cur, gx: liveGx, gy: liveGy, screenX: settled.x, screenY: settled.y };
        }
        if (opts?.kind === "unit" && cur.kind === "unit" && cur.unitId === opts.unitId) {
          return { ...cur, gx: liveGx, gy: liveGy, screenX: settled.x, screenY: settled.y };
        }
        return cur;
      });
      setInspectHudReady(true);
    };

    if (opts?.kind === "building" && opts.buildingId) {
      setSelectionAt(gx, gy, {
        kind: "building",
        buildingId: opts.buildingId,
      });
    } else if (opts?.kind === "unit" && opts.unitId) {
      setSelectionAt(gx, gy, {
        kind: "unit",
        unitId: opts.unitId,
      });
    }

    if (path && path.length >= 1) {
      setInspectHudReady(false);
      fitPathNodes(path, revealHud);
    } else {
      setInspectHudReady(true);
    }
  };

  useEffect(() => {
    if (!map) {
      setMiniSize({ width: 0, height: 0 });
      return;
    }
    setMiniSize(getMinimapSize(width, height, map));
  }, [map, width, height]);

  const applyClamp = () => {
    const m = mapRef.current;
    if (!m) return;
    const { width: w, height: h } = sizeRef.current;
    const { boardW, boardH } = getBoardLayout(w, h, m);
    panRef.current = clampPan(panRef.current, w, h, boardW, boardH, zoomRef.current);
  };

  useEffect(() => {
    applyClamp();
  }, [map, width, height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const mini = miniRef.current;
    if (!canvas || !map) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const miniCtx = mini?.getContext("2d") ?? null;

    let raf = 0;
    const paint = () => {
      drawMap(ctx, {
        width,
        height,
        map,
        pan: panRef.current,
        zoom: zoomRef.current,
        terrain: terrainRef.current,
        selection: selectionRef.current,
        buildings: buildingsRef.current,
        liaisons: liaisonsRef.current,
        liaisonPreview:
          liaisonKindRef.current && liaisonDraftRef.current
            ? { kind: liaisonKindRef.current, nodes: liaisonDraftRef.current }
            : null,
        selectedLiaisonId:
          liaisonDemolishIdRef.current ??
          enemyLiaisonRef.current?.id ??
          mobilizeRef.current?.targetLiaisonId ??
          null,
        resourceSight: resourceSightRef.current,
        myPlayerId: myPlayerIdRef.current,
        connectedBuildingIds: connectedIdsRef.current,
        showCapitalExclusion: phaseRef.current === "pick_capital",
        workRanges: workRangeRef.current,
        units: unitsRef.current,
        selectedUnitId:
          selectionUiRef.current?.kind === "unit"
            ? selectionUiRef.current.unitId ?? null
            : null,
        pollutionZones: pollutionZonesRef.current,
        showEnemyVision: showEnemyVisionRef.current,
        showCommStatus: showCommStatusRef.current,
        focusMarks: focusMarksRef.current,
        pathPreviews: pathPreviewsRef.current,
        fireAimAt: (() => {
          const id = fireAimRef.current;
          if (!id) return null;
          const b = buildingsRef.current.find((x) => x.id === id);
          return b ? { gx: b.gx, gy: b.gy } : null;
        })(),
        tick: tickRef.current,
      });
      if (mini && miniCtx && miniSize.width > 0) {
        const now = performance.now();
        const marks = destructionMarksRef.current.filter((m) => m.expiresAt > now);
        destructionMarksRef.current = marks;
        drawMinimap(miniCtx, {
          miniW: miniSize.width,
          miniH: miniSize.height,
          map,
          viewW: width,
          viewH: height,
          pan: panRef.current,
          zoom: zoomRef.current,
          terrain: terrainRef.current,
          destructionMarks: marks,
        });
      }
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [map, terrain, buildings, liaisons, resourceSight, connectedBuildingIds, pollutionZones, myPlayerId, showEnemyVision, showCommStatus, width, height, miniSize.width, miniSize.height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const toLocal = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    };

    /** Pan / zoom / pinch while mobilize, train, or fire-aim: keep focus + path / aim. */
    const clearSelectionOnMapGesture = () => {
      if (
        mobilizeRef.current != null ||
        trainUiRef.current != null ||
        fireAimRef.current
      ) {
        cancelPendingBuildingFocus();
        if (cameraAnimRef.current != null) {
          cancelAnimationFrame(cameraAnimRef.current);
          cameraAnimRef.current = null;
        }
        followUnitIdRef.current = null;
        return;
      }
      clearSelection();
    };

    const rememberPointer = (clientX: number, clientY: number) => {
      pointerRef.current = toLocal(clientX, clientY);
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { width: w, height: h } = sizeRef.current;
      const rect = canvas.getBoundingClientRect();
      const over =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;
      if (over) rememberPointer(e.clientX, e.clientY);

      const pivot = pointerRef.current;
      const z0 = zoomRef.current;
      const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
      const z1 = Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, z0 * factor));
      if (z1 === z0) return;

      clearSelectionOnMapGesture();
      panRef.current = panAfterZoomAt(pivot.x, pivot.y, z0, z1, panRef.current, w, h);
      zoomRef.current = z1;
      applyClamp();
    };

    const CLICK_PX = 5;
    const SHIFT_DBL_MS = 450;
    let shiftDbl: { id: string; at: number } | null = null;
    let shiftLiaisonDbl: { id: string; at: number } | null = null;
    let shiftLiaisonDemolishedAt = 0;

    const shiftDown = (e: { shiftKey: boolean; getModifierState?: (key: string) => boolean }) =>
      e.shiftKey || e.getModifierState?.("Shift") === true || shiftHeldRef.current;

    const ownedLiaisonAt = (clientX: number, clientY: number) => {
      const cursor = cursorGridAt(clientX, clientY);
      if (!cursor) return null;
      const hit = findLiaisonNear(liaisonsRef.current, cursor.gx, cursor.gy, 0.4);
      if (!hit) return null;
      const mine =
        myPlayerIdRef.current == null || hit.ownerId === myPlayerIdRef.current;
      return mine ? hit : null;
    };

    const demolishLiaisonNow = (id: string, kindName: string) => {
      const now = performance.now();
      if (now - shiftLiaisonDemolishedAt < SHIFT_DBL_MS) return;
      shiftLiaisonDemolishedAt = now;
      shiftLiaisonDbl = null;
      log.info("liaison-ui", "shift-dbl-demolish", kindName, id.slice(0, 8));
      onDemolishLiaisonRef.current?.(id);
      setLiaisonDemolishId(null);
      setLiaisonDraft(null);
      setLiaisonAwaitConfirm(false);
      setLiaisonLocalError(null);
    };

    const snapNodeAt = (clientX: number, clientY: number): GridNode | null => {
      const m = mapRef.current;
      if (!m) return null;
      const { width: w, height: h } = sizeRef.current;
      const local = toLocal(clientX, clientY);
      const hit = pickGridPoint(local.x, local.y, w, h, m, panRef.current, zoomRef.current);
      if (!hit) return null;
      return snapToIntegerNode(hit.gx, hit.gy, m);
    };

    const cursorGridAt = (clientX: number, clientY: number): { gx: number; gy: number } | null => {
      const m = mapRef.current;
      if (!m) return null;
      const { width: w, height: h } = sizeRef.current;
      const local = toLocal(clientX, clientY);
      return pickGridCoord(local.x, local.y, w, h, m, panRef.current, zoomRef.current);
    };

    const tryPickLiaisonAt = (clientX: number, clientY: number): boolean => {
      if (!liaisonEditActiveRef.current) return false;
      const cursor = cursorGridAt(clientX, clientY);
      if (!cursor) return false;
      const hit = findLiaisonNear(liaisonsRef.current, cursor.gx, cursor.gy, 0.4);
      if (!hit) return false;
      const mine =
        myPlayerIdRef.current == null || hit.ownerId === myPlayerIdRef.current;
      if (!mine) return false;
      setLiaisonAwaitConfirm(false);
      setLiaisonDraft(null);
      setLiaisonDemolishId(hit.id);
      clearSelection();
      log.info("liaison-ui", "select for demolish", hit.kind, hit.id.slice(0, 8));
      return true;
    };

    const sampleLiaisonSpeed = (cursor: { gx: number; gy: number }): number => {
      const now = performance.now();
      const prev = liaisonSpeedRef.current;
      if (!prev) {
        liaisonSpeedRef.current = { gx: cursor.gx, gy: cursor.gy, t: now, peak: 0 };
        return 0;
      }
      const dt = Math.max(0.001, (now - prev.t) / 1000);
      const dist = Math.hypot(cursor.gx - prev.gx, cursor.gy - prev.gy);
      const speed = dist / dt;
      const peak = Math.max(prev.peak, speed);
      liaisonSpeedRef.current = { gx: cursor.gx, gy: cursor.gy, t: now, peak };
      // Map Du/s → blunt 0..1 (slow < ~1.5, full blunt ~8+)
      return Math.max(0, Math.min(1, (speed - 1.5) / 6.5));
    };

    const beginPinchFromPointers = () => {
      const pts = [...pointersRef.current.values()];
      if (pts.length < 2) {
        pinchRef.current = null;
        return;
      }
      const a = toLocal(pts[0].x, pts[0].y);
      const b = toLocal(pts[1].x, pts[1].y);
      const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      pinchRef.current = {
        startDist: dist,
        startZoom: zoomRef.current,
        startPan: { ...panRef.current },
        startMid: mid,
      };
      pinchWasActiveRef.current = true;
      dragRef.current = null;
      liaisonSpeedRef.current = null;
      clearSelectionOnMapGesture();
    };

    /** Scale + pan so pinch midpoint stays on the same map point (and follows mid drift). */
    const applyPinchFromPointers = () => {
      const pinch = pinchRef.current;
      const pts = [...pointersRef.current.values()];
      if (!pinch || pts.length < 2) return;
      const a = toLocal(pts[0].x, pts[0].y);
      const b = toLocal(pts[1].x, pts[1].y);
      const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const { width: w, height: h } = sizeRef.current;
      const z0 = pinch.startZoom;
      const z1 = Math.min(
        MAP_ZOOM_MAX,
        Math.max(MAP_ZOOM_MIN, z0 * (dist / pinch.startDist)),
      );
      let pan = panAfterZoomAt(
        pinch.startMid.x,
        pinch.startMid.y,
        z0,
        z1,
        pinch.startPan,
        w,
        h,
      );
      pan = {
        x: pan.x + (mid.x - pinch.startMid.x),
        y: pan.y + (mid.y - pinch.startMid.y),
      };
      zoomRef.current = z1;
      panRef.current = pan;
      pointerRef.current = mid;
      applyClamp();
    };

    const onDown = (e: PointerEvent) => {
      if (miniDragRef.current) return;
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      rememberPointer(e.clientX, e.clientY);
      canvas.setPointerCapture(e.pointerId);

      // Second+ finger: pinch-zoom (touch-action:none blocks browser pinch).
      if (pointersRef.current.size >= 2) {
        e.preventDefault();
        beginPinchFromPointers();
        return;
      }

      // Ctrl+drag pans the map, including while a liaison line is being drawn.
      if (e.ctrlKey) {
        e.preventDefault();
        dragRef.current = {
          ox: e.clientX,
          oy: e.clientY,
          px: panRef.current.x,
          py: panRef.current.y,
          moved: false,
          panGesture: true,
        };
        return;
      }

      // Awaiting build confirm: new press cancels confirm and may start redraw
      if (liaisonAwaitConfirmRef.current) {
        setLiaisonAwaitConfirm(false);
        setLiaisonDraft(null);
      }

      const kind = liaisonKindRef.current;
      // Shift is reserved for demolishing a line, not starting a stroke.
      if (kind && liaisonEditActiveRef.current && !shiftDown(e)) {
        setLiaisonDemolishId(null);
        liaisonSpeedRef.current = null;
        dragRef.current = {
          ox: e.clientX,
          oy: e.clientY,
          px: panRef.current.x,
          py: panRef.current.y,
          moved: false,
          liaisonPending: true,
        };
        return;
      }

      dragRef.current = {
        ox: e.clientX,
        oy: e.clientY,
        px: panRef.current.x,
        py: panRef.current.y,
        moved: false,
      };
    };

    const onMove = (e: PointerEvent) => {
      if (pointersRef.current.has(e.pointerId)) {
        pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      rememberPointer(e.clientX, e.clientY);

      if (pointersRef.current.size >= 2) {
        e.preventDefault();
        if (!pinchRef.current) beginPinchFromPointers();
        else applyPinchFromPointers();
        return;
      }

      const d = dragRef.current;
      if (!d) return;

      if (d.panGesture) {
        if (!d.moved && Math.hypot(e.clientX - d.ox, e.clientY - d.oy) > CLICK_PX) {
          d.moved = true;
          clearSelectionOnMapGesture();
        }
        if (!d.moved) return;
        panRef.current = {
          x: d.px + (e.clientX - d.ox),
          y: d.py + (e.clientY - d.oy),
        };
        applyClamp();
        return;
      }

      const kind = liaisonKindRef.current;
      const m = mapRef.current;

      if (d.liaisonPending && kind && m) {
        if (!d.moved && Math.hypot(e.clientX - d.ox, e.clientY - d.oy) > CLICK_PX) {
          d.moved = true;
          const start = snapNodeAt(d.ox, d.oy);
          if (start) {
            if (
              kind === "railway" &&
              myPlayerIdRef.current &&
              !hasRailwayOriginStationAt(
                buildingsRef.current,
                myPlayerIdRef.current,
                start,
                connectedIdsRef.current,
              )
            ) {
              setLiaisonLocalError("铁路只能从已建成且接入通信的车站开始绘制");
              logLocalReject({
                action: "build_liaison",
                summary: "铺设铁路",
                reason: "铁路只能从已建成且接入通信的车站开始绘制",
                detail: start ? `(${start.gx}, ${start.gy})` : undefined,
              });
              setLiaisonDraft(null);
              d.liaisonPending = false;
              d.moved = false;
              return;
            }
            clearSelection();
            setLiaisonDemolishId(null);
            setLiaisonLocalError(null);
            setLiaisonDraft([start]);
            const c0 = cursorGridAt(d.ox, d.oy);
            if (c0) {
              liaisonSpeedRef.current = {
                gx: c0.gx,
                gy: c0.gy,
                t: performance.now(),
                peak: 0,
              };
            }
          } else {
            d.liaisonPending = false;
            return;
          }
        }
        if (!d.moved || !liaisonDraftRef.current) return;
        const cursor = cursorGridAt(e.clientX, e.clientY);
        if (cursor) {
          const blunt = sampleLiaisonSpeed(cursor);
          const maxLen = LIAISON_BY_ID[kind].maxLengthDu;
          const next = extendLiaisonPath(
            liaisonDraftRef.current,
            cursor,
            maxLen,
            m,
            blunt,
          );
          setLiaisonDraft(next);
        }
        return;
      }

      if (kind && liaisonDraftRef.current && m && !liaisonAwaitConfirmRef.current) {
        const cursor = cursorGridAt(e.clientX, e.clientY);
        if (cursor) {
          if (!d.moved && Math.hypot(e.clientX - d.ox, e.clientY - d.oy) > CLICK_PX) {
            d.moved = true;
          }
          const blunt = sampleLiaisonSpeed(cursor);
          const maxLen = LIAISON_BY_ID[kind].maxLengthDu;
          const next = extendLiaisonPath(
            liaisonDraftRef.current,
            cursor,
            maxLen,
            m,
            blunt,
          );
          setLiaisonDraft(next);
        }
        return;
      }

      if (!d.moved && Math.hypot(e.clientX - d.ox, e.clientY - d.oy) > CLICK_PX) {
        d.moved = true;
        clearSelectionOnMapGesture();
      }
      if (!d.moved) return;
      panRef.current = {
        x: d.px + (e.clientX - d.ox),
        y: d.py + (e.clientY - d.oy),
      };
      applyClamp();
    };

    const onUp = (e: PointerEvent) => {
      pointersRef.current.delete(e.pointerId);

      // End or rebaseline pinch; never treat pinch release as a map click.
      if (pinchWasActiveRef.current) {
        if (pointersRef.current.size >= 2) {
          beginPinchFromPointers();
          return;
        }
        pinchRef.current = null;
        if (pointersRef.current.size === 1) {
          const rem = [...pointersRef.current.values()][0]!;
          dragRef.current = {
            ox: rem.x,
            oy: rem.y,
            px: panRef.current.x,
            py: panRef.current.y,
            moved: true,
            panGesture: true,
          };
          return;
        }
        pinchWasActiveRef.current = false;
        dragRef.current = null;
        liaisonSpeedRef.current = null;
        return;
      }

      const d = dragRef.current;
      dragRef.current = null;

      const kind = liaisonKindRef.current;
      let draft = liaisonDraftRef.current;

      if (d?.panGesture) {
        liaisonSpeedRef.current = null;
        return;
      }

      // Finished a draw stroke → blunt by peak speed, then secondary confirm
      if (kind && draft && d?.moved && !liaisonAwaitConfirmRef.current) {
        if (draft.length >= 2) {
          const peak = liaisonSpeedRef.current?.peak ?? 0;
          const releaseBlunt = Math.max(0, Math.min(1, (peak - 1.5) / 6.5));
          if (releaseBlunt > 0.1) {
            draft = bluntLiaisonPath(draft, releaseBlunt);
            setLiaisonDraft(draft);
          }
          const owner = myPlayerIdRef.current;
          if (owner && kind === "railway") {
            const m = mapRef.current;
            const cursor = cursorGridAt(e.clientX, e.clientY);
            // 指针附近的己方车站（含建造中）优先作为终点，先把路径接到它上面再校验。
            const aimed =
              cursor &&
              findOwnedRailwayStationNear(buildingsRef.current, owner, cursor, {
                maxDistDu: 1.2,
              });
            const aim = aimed ? { gx: aimed.gx, gy: aimed.gy } : cursor;
            if (aim && m) {
              draft = extendLiaisonPath(
                draft,
                aim,
                LIAISON_BY_ID.railway.maxLengthDu,
                m,
                0,
              );
            }
            draft = anchorRailwayEndpoints(
              draft,
              buildingsRef.current,
              owner,
              connectedIdsRef.current,
              aim ?? undefined,
            );
            setLiaisonDraft(draft);
          }
          const railErr =
            owner != null
              ? railwayEndpointRejectReason(
                  kind,
                  draft,
                  buildingsRef.current,
                  owner,
                  connectedIdsRef.current,
                )
              : kind === "railway"
                ? "铁路只能连接车站"
                : null;
          if (railErr) {
            log.warn("liaison-ui", railErr);
            setLiaisonLocalError(railErr);
            logLocalReject({
              action: "build_liaison",
              summary: `铺设${LIAISON_BY_ID[kind].name}`,
              reason: railErr,
            });
            setLiaisonDraft(null);
            setLiaisonAwaitConfirm(false);
          } else {
            setLiaisonLocalError(null);
            log.info("liaison-ui", "await confirm", kind, draft.length, "blunt", releaseBlunt.toFixed(2));
            setLiaisonAwaitConfirm(true);
          }
        } else {
          setLiaisonDraft(null);
        }
        liaisonSpeedRef.current = null;
        return;
      }
      liaisonSpeedRef.current = null;

      // Shift+双击优先于单击确认框。按住 Shift 时绝不打开拆除确认。
      if (d && !d.moved && liaisonEditActiveRef.current && shiftDown(e)) {
        const hit = ownedLiaisonAt(e.clientX, e.clientY);
        if (hit) {
          const now = performance.now();
          const second =
            e.detail >= 2 ||
            (shiftLiaisonDbl != null &&
              shiftLiaisonDbl.id === hit.id &&
              now - shiftLiaisonDbl.at < SHIFT_DBL_MS);
          if (second) {
            demolishLiaisonNow(hit.id, hit.kind);
            return;
          }
          shiftLiaisonDbl = { id: hit.id, at: now };
        }
        return;
      }

      if (d && !d.moved) {
        if (tryPickLiaisonAt(e.clientX, e.clientY)) return;
        if (liaisonEditActiveRef.current) {
          setLiaisonDemolishId(null);
          return;
        }
      }

      if (!d || d.moved) return;
      const m = mapRef.current;
      if (!m) return;
      const { width: w, height: h } = sizeRef.current;
      const local = toLocal(e.clientX, e.clientY);
      const hit = pickGridPoint(
        local.x,
        local.y,
        w,
        h,
        m,
        panRef.current,
        zoomRef.current,
      );
      if (hit) {
        if (phaseRef.current === "playing" || phaseRef.current === "spectating" || phaseRef.current === "ended") {
          const nearUnit = findUnitNear(unitsRef.current, hit.gx, hit.gy, 0.35);
          if (nearUnit && !fireAimRef.current && !mutualAimRef.current) {
            log.info("select", "unit", nearUnit.kind, nearUnit.gx, nearUnit.gy);
            setSelectionAt(nearUnit.gx, nearUnit.gy, {
              kind: "unit",
              unitId: nearUnit.id,
              focusCenter: true,
            });
            return;
          }
          if (phaseRef.current !== "playing") {
            const near = findBuildingNear(buildingsRef.current, hit.gx, hit.gy, 0.2);
            if (near && !shiftDown(e)) {
              setSelectionAt(near.gx, near.gy, {
                kind: "building",
                buildingId: near.id,
                focusCenter: true,
              });
            }
            return;
          }
          const near = findBuildingNear(buildingsRef.current, hit.gx, hit.gy, 0.2);
          if (mutualAimRef.current && !shiftDown(e)) {
            const source = buildingsRef.current.find((b) => b.id === mutualAimRef.current);
            if (!source) {
              setMutualAim(null);
              return;
            }
            if (!near || near.id === source.id) {
              setMutualAimNote("选择相邻/对角的己方建筑");
              logLocalReject({
                action: "mutual_defense",
                summary: "互防",
                reason: "选择相邻/对角的己方建筑",
                detail: `from ${source.id.slice(0, 8)}`,
              });
              return;
            }
            if (near.ownerId !== myPlayerIdRef.current) {
              setMutualAimNote("只能与己方建筑互防");
              logLocalReject({
                action: "mutual_defense",
                summary: "互防",
                reason: "只能与己方建筑互防",
              });
              return;
            }
            onMutualDefense?.(source.id, near.id);
            setMutualAim(null);
            clearSelection();
            return;
          }
          if (fireAimRef.current && !shiftDown(e)) {
            const source = buildingsRef.current.find((b) => b.id === fireAimRef.current);
            if (!source) {
              exitFireAim();
              return;
            }
            const sourceScreen = gridScreenAt(source.gx, source.gy);
            if (
              sourceScreen &&
              hitFireAimCancel(local.x, local.y, sourceScreen.x, sourceScreen.y)
            ) {
              exitFireAim();
              return;
            }
            const canHitUnits = source.buildingId === "gun";
            const aimHint = canHitUnits ? "选择敌方建筑或单位" : "选择敌方建筑";

            if (canHitUnits) {
              const aimUnit = findUnitNear(unitsRef.current, hit.gx, hit.gy, 0.35);
              if (aimUnit) {
                if (aimUnit.ownerId === myPlayerIdRef.current) {
                  setFireAimNote("只能攻击敌方单位");
                  logLocalReject({
                    action: "fire",
                    summary: "建筑开火",
                    reason: "只能攻击敌方单位",
                  });
                  return;
                }
                if (
                  !isInsideWorkRange(
                    aimUnit.gx,
                    aimUnit.gy,
                    source,
                    buildingsRef.current,
                    connectedIdsRef.current,
                  )
                ) {
                  setFireAimNote("不在射程内");
                  logLocalReject({
                    action: "fire",
                    summary: `建筑开火 → 单位 ${aimUnit.id.slice(0, 8)}`,
                    reason: "不在射程内",
                  });
                  return;
                }
                log.info(
                  "building-action",
                  "fire",
                  source.buildingId,
                  "→ unit",
                  aimUnit.kind,
                  aimUnit.id.slice(0, 8),
                );
                onFireRef.current?.(source.id, { targetUnitId: aimUnit.id });
                setFireAimNote("选择目标");
                return;
              }
            }

            if (!near || near.id === source.id) {
              setFireAimNote(aimHint);
              logLocalReject({
                action: "fire",
                summary: "建筑开火",
                reason: aimHint,
                detail: `from ${source.id.slice(0, 8)}`,
              });
              return;
            }
            if (near.ownerId === myPlayerIdRef.current) {
              setFireAimNote("只能攻击敌方建筑");
              logLocalReject({
                action: "fire",
                summary: "建筑开火",
                reason: "只能攻击敌方建筑",
              });
              return;
            }
            if (near.buildingId === "artificial_island") {
              setFireAimNote("不能攻击人工岛");
              logLocalReject({
                action: "fire",
                summary: "建筑开火",
                reason: "不能攻击人工岛",
              });
              return;
            }
            if (
              !isInsideWorkRange(
                near.gx,
                near.gy,
                source,
                buildingsRef.current,
                connectedIdsRef.current,
              )
            ) {
              setFireAimNote("不在射程内");
              logLocalReject({
                action: "fire",
                summary: `建筑开火 → (${near.gx}, ${near.gy})`,
                reason: "不在射程内",
              });
              return;
            }
            log.info("building-action", "fire", source.buildingId, "→", near.buildingId);
            onFireRef.current?.(source.id, { targetId: near.id });
            setFireAimNote("选择目标");
            return;
          }
          if (near) {
            const mine =
              myPlayerIdRef.current != null && near.ownerId === myPlayerIdRef.current;
            const withShift = shiftDown(e);
            if (mine && withShift) {
              const now = performance.now();
              if (shiftDbl && shiftDbl.id === near.id && now - shiftDbl.at < SHIFT_DBL_MS) {
                shiftDbl = null;
                log.info("building-action", "shift-dbl-demolish", near.buildingId, near.gx, near.gy);
                pendingDemolishIdsRef.current.add(near.id);
                onDemolishRef.current?.(near.id);
                clearSelection();
                return;
              }
              shiftDbl = { id: near.id, at: now };
            }
            // Shift+click: keep demolish dbl detection only — no focus pan / inspect HUD.
            if (withShift) {
              cancelPendingBuildingFocus();
              return;
            }
            if (near.buildingId === "artificial_island") {
              log.info("select", "artificial_island → point menu", near.gx, near.gy);
              setSelectionAt(near.gx, near.gy, { kind: "point" });
              return;
            }
            log.info("select", "building", near.buildingId, near.gx, near.gy);
            setSelectionAt(near.gx, near.gy, {
              kind: "building",
              buildingId: near.id,
              focusCenter: true,
            });
            return;
          }
        }
        if (phaseRef.current === "playing" && myPlayerIdRef.current) {
          const cursor = cursorGridAt(e.clientX, e.clientY);
          const seg = cursor
            ? findLiaisonSegmentNear(liaisonsRef.current, cursor.gx, cursor.gy, 0.45)
            : undefined;
          if (seg && seg.line.ownerId !== myPlayerIdRef.current) {
            if ((seg.line.buildTicksRemaining ?? 0) > 0) {
              logLocalReject({
                action: "attack_units",
                summary: "进攻联络线",
                reason: "联络线建造或升级中，不能作为进攻目标",
              });
              return;
            }
            const a = seg.line.nodes[seg.segmentIndex];
            const b = seg.line.nodes[seg.segmentIndex + 1];
            if (a && b) {
              const mid = snapToUnitCoord((a.gx + b.gx) / 2, (a.gy + b.gy) / 2);
              const screen = gridScreenAt(mid.gx, mid.gy);
              if (screen) {
                selectionRef.current = null;
                setSelectionUi(null);
                setEnemyLiaison({
                  id: seg.line.id,
                  ax: a.gx,
                  ay: a.gy,
                  bx: b.gx,
                  by: b.gy,
                  gx: mid.gx,
                  gy: mid.gy,
                  screenX: screen.x,
                  screenY: screen.y,
                });
                log.info("select", "enemy liaison", seg.line.kind, seg.line.id.slice(0, 8));
                return;
              }
            }
          }
        }
        setSelectionAt(hit.gx, hit.gy, { kind: "point" });
      } else if (fireAimRef.current) {
        const source = buildingsRef.current.find((b) => b.id === fireAimRef.current);
        const aimHint =
          source?.buildingId === "gun" ? "选择敌方建筑或单位" : "选择敌方建筑";
        setFireAimNote(aimHint);
        logLocalReject({
          action: "fire",
          summary: "建筑开火",
          reason: aimHint,
        });
      } else clearSelection();
    };

    const onPointerLeave = (e: PointerEvent) => {
      rememberPointer(e.clientX, e.clientY);
      const rect = canvas.getBoundingClientRect();
      pointerRef.current = {
        x: Math.min(rect.width, Math.max(0, pointerRef.current.x)),
        y: Math.min(rect.height, Math.max(0, pointerRef.current.y)),
      };
    };

    const onWindowMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      if (
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom
      ) {
        rememberPointer(e.clientX, e.clientY);
      }
    };

    const onDblClick = (e: MouseEvent) => {
      if (!liaisonEditActiveRef.current || !shiftDown(e)) return;
      const hit = ownedLiaisonAt(e.clientX, e.clientY);
      if (!hit) return;
      e.preventDefault();
      demolishLiaisonNow(hit.id, hit.kind);
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("dblclick", onDblClick);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("pointerleave", onPointerLeave);
    window.addEventListener("pointermove", onWindowMove);

    return () => {
      pointersRef.current.clear();
      pinchRef.current = null;
      pinchWasActiveRef.current = false;
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("dblclick", onDblClick);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("pointermove", onWindowMove);
    };
  }, []);

  useEffect(() => {
    const mini = miniRef.current;
    const m = map;
    if (!mini || !m || miniSize.width <= 0) return;

    const hitPad = 4;

    const localPos = (e: PointerEvent) => {
      const rect = mini.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const onDown = (e: PointerEvent) => {
      e.stopPropagation();
      const { width: viewW, height: viewH } = sizeRef.current;
      const { width: miniW, height: miniH } = miniSizeRef.current;
      const box = getViewRectOnMinimap(
        miniW,
        miniH,
        viewW,
        viewH,
        m,
        panRef.current,
        zoomRef.current,
      );
      const p = localPos(e);
      const inside =
        p.x >= box.x0 - hitPad &&
        p.x <= box.x1 + hitPad &&
        p.y >= box.y0 - hitPad &&
        p.y <= box.y1 + hitPad;
      if (!inside) return;

      e.preventDefault();
      mini.setPointerCapture(e.pointerId);
      dragRef.current = null;
      if (mobilizeRef.current != null || trainUiRef.current != null) {
        cancelPendingBuildingFocus();
        if (cameraAnimRef.current != null) {
          cancelAnimationFrame(cameraAnimRef.current);
          cameraAnimRef.current = null;
        }
        followUnitIdRef.current = null;
      } else {
        clearSelection();
      }
      miniDragRef.current = {
        grabDu: p.x / miniW - box.uc,
        grabDv: p.y / miniH - box.vc,
      };
      mini.classList.add("dragging");
    };

    const onMove = (e: PointerEvent) => {
      const drag = miniDragRef.current;
      if (!drag) return;
      e.preventDefault();
      const { width: viewW, height: viewH } = sizeRef.current;
      const { width: miniW, height: miniH } = miniSizeRef.current;
      const p = localPos(e);
      const uc = p.x / miniW - drag.grabDu;
      const vc = p.y / miniH - drag.grabDv;
      panRef.current = panFromBoardUV(uc, vc, viewW, viewH, m, zoomRef.current);
      applyClamp();
    };

    const onUp = () => {
      miniDragRef.current = null;
      mini.classList.remove("dragging");
    };

    const onHoverMove = (e: PointerEvent) => {
      if (miniDragRef.current) return;
      const { width: viewW, height: viewH } = sizeRef.current;
      const { width: miniW, height: miniH } = miniSizeRef.current;
      const box = getViewRectOnMinimap(
        miniW,
        miniH,
        viewW,
        viewH,
        m,
        panRef.current,
        zoomRef.current,
      );
      const p = localPos(e);
      const inside =
        p.x >= box.x0 - hitPad &&
        p.x <= box.x1 + hitPad &&
        p.y >= box.y0 - hitPad &&
        p.y <= box.y1 + hitPad;
      mini.style.cursor = inside ? "grab" : "default";
    };

    mini.addEventListener("pointerdown", onDown);
    mini.addEventListener("pointermove", onMove);
    mini.addEventListener("pointermove", onHoverMove);
    mini.addEventListener("pointerup", onUp);
    mini.addEventListener("pointercancel", onUp);

    return () => {
      mini.removeEventListener("pointerdown", onDown);
      mini.removeEventListener("pointermove", onMove);
      mini.removeEventListener("pointermove", onHoverMove);
      mini.removeEventListener("pointerup", onUp);
      mini.removeEventListener("pointercancel", onUp);
    };
  }, [map, miniSize.width, miniSize.height]);

  const groundAt = (gx: number, gy: number): GroundContext => {
    const t = terrainRef.current;
    if (!t) return "land";
    // A build node sits at the corner of up to 4 cells. If ANY adjacent cell is
    // land/mountain (i.e. coastline), treat as land; only pure open sea is ocean.
    let hasLand = false;
    for (let dy = -1; dy <= 0; dy++) {
      for (let dx = -1; dx <= 0; dx++) {
        const cx = Math.floor(gx) + dx;
        const cy = Math.floor(gy) + dy;
        const cell = cellAt(t, cx, cy);
        if (cell && cell.ground !== "ocean") hasLand = true;
      }
    }
    return hasLand ? "land" : "ocean";
  };

  const openBuildAt = (
    anchor: { gx: number; gy: number; screenX: number; screenY: number },
    mode: "buildings" | "liaison",
  ) => {
    const m = mapRef.current;
    if (!m || phaseRef.current !== "playing") return;
    const node = snapToBuildNode(anchor.gx, anchor.gy, m);
    const existing = findBuildingAt(buildingsRef.current, node.gx, node.gy);
    const currentBuildingId = existing?.buildingId ?? null;
    const ground = groundAt(node.gx, node.gy);
    let fromX = anchor.screenX;
    let fromY = anchor.screenY;
    if (mode === "buildings") {
      const build = POINT_ACTIONS.find((a) => a.id === "build");
      const angleDeg = build?.angleDeg ?? 32;
      const rad = (angleDeg * Math.PI) / 180;
      fromX = anchor.screenX + Math.cos(rad) * ACTION_ARC_RADIUS;
      fromY = anchor.screenY + Math.sin(rad) * ACTION_ARC_RADIUS;
    }
    log.info("build-ui", mode === "liaison" ? "open liaison" : "open menu", {
      node,
      currentBuildingId,
      ground,
    });
    clearSelection();
    setBuildMode({
      fromX,
      fromY,
      gx: node.gx,
      gy: node.gy,
      currentBuildingId,
      ground,
      initialMode: mode,
      liaisonNonce: mode === "liaison" ? 1 : 0,
    });
  };
  const openBuildAtRef = useRef(openBuildAt);
  openBuildAtRef.current = openBuildAt;

  const anchorFromPointer = (): {
    gx: number;
    gy: number;
    screenX: number;
    screenY: number;
  } | null => {
    const m = mapRef.current;
    if (!m) return null;
    const { width: w, height: h } = sizeRef.current;
    const hit = pickGridPoint(
      pointerRef.current.x,
      pointerRef.current.y,
      w,
      h,
      m,
      panRef.current,
      zoomRef.current,
    );
    if (!hit) return null;
    const node = snapToBuildNode(hit.gx, hit.gy, m);
    const { cell, originX, originY } = getBoardLayout(w, h, m);
    const screen = layoutToScreen(
      originX + node.gx * cell,
      originY + node.gy * cell,
      w,
      h,
      panRef.current,
      zoomRef.current,
    );
    return { gx: node.gx, gy: node.gy, screenX: screen.x, screenY: screen.y };
  };
  const anchorFromPointerRef = useRef(anchorFromPointer);
  anchorFromPointerRef.current = anchorFromPointer;

  const onPointAction = (id: PointActionId) => {
    if (!selectionUi || !map) return;

    if (id === "set_capital") {
      const node = snapToBuildNode(selectionUi.gx, selectionUi.gy, map);
      const t = terrainRef.current;
      if (t) {
        const reason = capitalSiteRejectReason(t, node.gx, node.gy);
        if (reason) {
          log.warn("capital-ui", capitalSiteRejectMessage(reason), node);
        }
      }
      log.info("capital-ui", "place", node);
      onPlaceCapital?.(node.gx, node.gy);
      clearSelection();
      return;
    }

    if (id === "build" && phaseRef.current === "playing") {
      openBuildAt(selectionUi, "buildings");
      return;
    }

    if (id === "mobilize" && phaseRef.current === "playing") {
      const dest = snapToUnitCoord(selectionUi.gx, selectionUi.gy);
      setMobilize({ mode: "move", gx: dest.gx, gy: dest.gy, sources: {}, unitIds: [] });
      return;
    }

    if (id === "lockdown" && phaseRef.current === "playing") {
      const dest = snapToUnitCoord(selectionUi.gx, selectionUi.gy);
      setMobilize({ mode: "blockade", gx: dest.gx, gy: dest.gy, sources: {}, unitIds: [] });
      return;
    }

    log.info("action", id, selectionUi ? `(${selectionUi.gx}, ${selectionUi.gy})` : null);
  };

  const onPickBuilding = (b: BuildingDef) => {
    if (!buildMode) {
      log.error("build-ui", "pick ignored: no buildMode", b.id);
      return;
    }
    if (b.id === "port") {
      const t = terrainRef.current;
      if (!t || !isValidPortSite(t, buildMode.gx, buildMode.gy)) {
        setLiaisonLocalError("港口只能建在海岸线上");
        log.warn("build-ui", "port rejected: not coastline", {
          gx: buildMode.gx,
          gy: buildMode.gy,
        });
        logLocalReject({
          action: "build",
          summary: `建造 港口 (${buildMode.gx}, ${buildMode.gy})`,
          reason: "港口只能建在海岸线上",
        });
        return;
      }
    }
    const args = {
      buildingId: b.id,
      gx: buildMode.gx,
      gy: buildMode.gy,
      ground: buildMode.ground,
    };
    log.info("build-ui", "pick building → onBuild", args, b.name);
    if (!onBuild) {
      log.error("build-ui", "onBuild prop is undefined");
    } else {
      setLiaisonLocalError(null);
      onBuild(args);
      // Don't close immediately - wait for server response
      // Will close when building appears at this position or user clicks X
      setBuildMode({ ...buildMode, pendingBuildingId: b.id });
    }
  };

  const inspectedBuilding =
    selectionUi?.kind === "building" && selectionUi.buildingId
      ? buildings.find((b) => b.id === selectionUi.buildingId) ??
        findBuildingAt(buildings, selectionUi.gx, selectionUi.gy)
      : null;
  const inspectedUnit =
    selectionUi?.kind === "unit" && selectionUi.unitId
      ? units.find((u) => u.id === selectionUi.unitId) ?? null
      : null;
  const inspectOpen =
    !!inspectedBuilding &&
    !buildMode &&
    (phase === "playing" || phase === "spectating" || phase === "ended");
  const canAct = phase === "playing";
  const fireAimBuilding = fireAim
    ? buildings.find((b) => b.id === fireAim) ?? null
    : null;
  workRangeRef.current =
    fireAimBuilding && !buildMode && canAct
      ? workRangeCircles(fireAimBuilding, buildings, connectedBuildingIds)
      : inspectOpen
        ? workRangeCircles(inspectedBuilding, buildings, connectedBuildingIds)
        : [];

  // Keep inspect HUD on building node if HP/state updates
  useEffect(() => {
    if (!selectionUi || selectionUi.kind !== "building" || !selectionUi.buildingId) return;
    const live = buildings.find((b) => b.id === selectionUi.buildingId);
    if (!live) {
      clearSelection();
      return;
    }
    if (live.gx !== selectionUi.gx || live.gy !== selectionUi.gy) {
      setSelectionAt(live.gx, live.gy, {
        kind: "building",
        buildingId: live.id,
      });
    }
  }, [buildings, selectionUi?.buildingId]);

  // Fire-aim exits only via ×; also drop if the launcher itself vanishes.
  useEffect(() => {
    if (!fireAim) return;
    if (!buildings.some((b) => b.id === fireAim)) {
      exitFireAim();
    }
  }, [buildings, fireAim]);

  // Keep unit inspect HUD on the moving unit; camera follows while followUnitIdRef is set
  useEffect(() => {
    if (!selectionUi || selectionUi.kind !== "unit" || !selectionUi.unitId) return;
    const live = units.find((u) => u.id === selectionUi.unitId);
    if (!live) {
      clearSelection();
      return;
    }
    if (followUnitIdRef.current === live.id) {
      const { width: w, height: h } = sizeRef.current;
      panGridToScreen(live.gx, live.gy, w / 2, h / 2);
    }
    const screen = gridScreenAt(live.gx, live.gy);
    if (!screen) return;
    if (
      live.gx !== selectionUi.gx ||
      live.gy !== selectionUi.gy ||
      Math.abs(screen.x - selectionUi.screenX) > 0.5 ||
      Math.abs(screen.y - selectionUi.screenY) > 0.5
    ) {
      selectionRef.current = null;
      setSelectionUi({
        kind: "unit",
        gx: live.gx,
        gy: live.gy,
        screenX: screen.x,
        screenY: screen.y,
        unitId: live.id,
      });
    }
  }, [units, selectionUi?.unitId, selectionUi?.gx, selectionUi?.gy, selectionUi?.screenX, selectionUi?.screenY]);

  // Close build mode when building successfully appears at target position
  useEffect(() => {
    if (!buildMode?.pendingBuildingId) return;
    const atTarget = findBuildingAt(buildings, buildMode.gx, buildMode.gy);
    if (atTarget && atTarget.buildingId === buildMode.pendingBuildingId) {
      log.info("build-ui", "build success, closing overlay");
      setBuildMode(null);
    }
  }, [buildings, buildMode?.pendingBuildingId, buildMode?.gx, buildMode?.gy]);

  // Clear pending liaison once a new line appears (keep overlay open for more)
  const liaisonCountRef = useRef(liaisons.length);
  useEffect(() => {
    const prev = liaisonCountRef.current;
    liaisonCountRef.current = liaisons.length;
    if (!buildMode?.pendingLiaisonKind) return;
    if (liaisons.length > prev) {
      setBuildMode((bm) =>
        bm?.pendingLiaisonKind ? { ...bm, pendingLiaisonKind: undefined } : bm,
      );
    }
  }, [liaisons, buildMode?.pendingLiaisonKind]);

  const liaisonDraftCost =
    liaisonKind && liaisonDraft && liaisonDraft.length >= 2
      ? (() => {
          const base = previewLiaisonCost(liaisonKind, liaisonDraft);
          if ((liaisonKind === "road" || liaisonKind === "railway") && terrain) {
            return withLiaisonTerrainSurcharge(
              base,
              roadRailTerrainSurchargeE(terrain, liaisonDraft, liaisonKind),
            );
          }
          return base;
        })()
      : null;

  const demolishTarget =
    liaisonDemolishId != null
      ? liaisons.find((l) => l.id === liaisonDemolishId) ?? null
      : null;

  // Drop stale demolish selection
  useEffect(() => {
    if (liaisonDemolishId && !liaisons.some((l) => l.id === liaisonDemolishId)) {
      setLiaisonDemolishId(null);
    }
  }, [liaisons, liaisonDemolishId]);

  const confirmBuildLiaison = useCallback(() => {
    if (!liaisonKind || !liaisonDraft || liaisonDraft.length < 2) return;
    let nodes = liaisonDraft;
    if (myPlayerId && liaisonKind === "railway") {
      nodes = anchorRailwayEndpoints(
        liaisonDraft,
        buildings,
        myPlayerId,
        connectedBuildingIds,
      );
      const railErr = railwayEndpointRejectReason(
        liaisonKind,
        nodes,
        buildings,
        myPlayerId,
        connectedBuildingIds,
      );
      if (railErr) {
        setLiaisonLocalError(railErr);
        setLiaisonAwaitConfirm(false);
        setLiaisonDraft(null);
        logLocalReject({
          action: "build_liaison",
          summary: "铺设铁路",
          reason: railErr,
        });
        return;
      }
    }
    log.info("liaison-ui", "confirm build", liaisonKind, nodes.length);
    onBuildLiaison?.({ kind: liaisonKind, nodes: nodes.map((n) => ({ ...n })) });
    setBuildMode((prev) =>
      prev ? { ...prev, pendingLiaisonKind: liaisonKind, pendingBuildingId: undefined } : prev,
    );
    setLiaisonAwaitConfirm(false);
    setLiaisonDraft(null);
    setLiaisonLocalError(null);
  }, [liaisonKind, liaisonDraft, onBuildLiaison, myPlayerId, buildings, connectedBuildingIds]);

  const cancelBuildLiaison = useCallback(() => {
    setLiaisonAwaitConfirm(false);
    setLiaisonDraft(null);
  }, []);

  const confirmDemolishLiaison = useCallback(() => {
    if (!liaisonDemolishId) return;
    log.info("liaison-ui", "confirm demolish", liaisonDemolishId.slice(0, 8));
    onDemolishLiaison?.(liaisonDemolishId);
    setLiaisonDemolishId(null);
  }, [liaisonDemolishId, onDemolishLiaison]);

  useLayoutEffect(() => {
    if (!shiftDemolishHint || !shiftHintRef.current) return;
    shiftHintRef.current.style.left = `${mouseClientRef.current.x + 14}px`;
    shiftHintRef.current.style.top = `${mouseClientRef.current.y + 18}px`;
  }, [shiftDemolishHint]);

  useLayoutEffect(() => {
    if (!fireAim || !fireHintRef.current) return;
    fireHintRef.current.style.left = `${mouseClientRef.current.x + 14}px`;
    fireHintRef.current.style.top = `${mouseClientRef.current.y + 18}px`;
  }, [fireAim, fireAimNote]);

  useLayoutEffect(() => {
    if (!mutualAim || !mutualHintRef.current) return;
    mutualHintRef.current.style.left = `${mouseClientRef.current.x + 14}px`;
    mutualHintRef.current.style.top = `${mouseClientRef.current.y + 18}px`;
  }, [mutualAim, mutualAimNote]);

  useEffect(() => {
    const typing = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
    };
    const placeHint = (x: number, y: number) => {
      const el = shiftHintRef.current;
      if (!el) return;
      el.style.left = `${x + 14}px`;
      el.style.top = `${y + 18}px`;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        shiftHeldRef.current = true;
        setShiftDemolishHint(true);
        return;
      }
      if (e.key === "Escape" && mutualAimRef.current) {
        e.preventDefault();
        setMutualAim(null);
        return;
      }
      if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      if (typing(e.target)) return;
      if (phaseRef.current !== "playing") return;

      if (e.code === "KeyQ") {
        const sel = selectionUiRef.current;
        if (!sel || sel.kind !== "point" || buildModeRef.current) return;
        e.preventDefault();
        openBuildAtRef.current(sel, "buildings");
        return;
      }
      if (e.code === "KeyE") {
        e.preventDefault();
        if (buildModeRef.current && liaisonEditActiveRef.current) {
          // BuildModeOverlay handles E→close with liaison exit animation.
          return;
        }
        if (buildModeRef.current) {
          if (!liaisonEditActiveRef.current) {
            setBuildMode((prev) =>
              prev ? { ...prev, liaisonNonce: (prev.liaisonNonce ?? 0) + 1 } : prev,
            );
          }
          return;
        }
        const sel = selectionUiRef.current;
        const anchor = sel ?? anchorFromPointerRef.current();
        if (anchor) openBuildAtRef.current(anchor, "liaison");
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        shiftHeldRef.current = false;
        setShiftDemolishHint(false);
      }
    };
    const onMove = (e: PointerEvent) => {
      mouseClientRef.current = { x: e.clientX, y: e.clientY };
      if (e.shiftKey) placeHint(e.clientX, e.clientY);
      const fireEl = fireHintRef.current;
      if (fireEl) {
        fireEl.style.left = `${e.clientX + 14}px`;
        fireEl.style.top = `${e.clientY + 18}px`;
      }
      const mutualEl = mutualHintRef.current;
      if (mutualEl) {
        mutualEl.style.left = `${e.clientX + 14}px`;
        mutualEl.style.top = `${e.clientY + 18}px`;
      }
    };
    const onBlur = () => {
      shiftHeldRef.current = false;
      setShiftDemolishHint(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Enter confirms build / demolish; Escape cancels pending confirm
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        if (liaisonAwaitConfirm) {
          e.preventDefault();
          confirmBuildLiaison();
          return;
        }
        if (liaisonDemolishId) {
          e.preventDefault();
          confirmDemolishLiaison();
        }
        return;
      }
      if (e.key === "Escape") {
        if (liaisonAwaitConfirm) {
          e.preventDefault();
          cancelBuildLiaison();
          return;
        }
        if (liaisonDemolishId) {
          e.preventDefault();
          setLiaisonDemolishId(null);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    liaisonAwaitConfirm,
    liaisonDemolishId,
    confirmBuildLiaison,
    cancelBuildLiaison,
    confirmDemolishLiaison,
  ]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="game-canvas"
        width={width * devicePixelRatio}
        height={height * devicePixelRatio}
        style={{
          width,
          height,
          cursor: liaisonKind || liaisonEditActive ? "crosshair" : undefined,
        }}
      />
      {selectionUi &&
        selectionUi.kind === "point" &&
        !buildMode &&
        phase !== "need_init" &&
        phase !== "spectating" &&
        phase !== "ended" && (
          <PointActionMenu
            screenX={selectionUi.screenX}
            screenY={selectionUi.screenY}
            arcRadius={ACTION_ARC_RADIUS}
            actions={phase === "pick_capital" ? CAPITAL_PICK_ACTIONS : POINT_ACTIONS}
            onAction={onPointAction}
          />
        )}
      {selectionUi &&
        selectionUi.kind === "building" &&
        inspectedBuilding &&
        inspectHudReady &&
        !buildMode &&
        !fireAim &&
        (phase === "playing" || phase === "spectating" || phase === "ended") && (
          <BuildingInspectHud
            building={inspectedBuilding}
            screenX={selectionUi.screenX}
            screenY={selectionUi.screenY}
            myPlayerId={myPlayerId}
            playerNames={playerNames}
            tick={tick}
            commsLinked={isBuildingCommsLinked(inspectedBuilding.id, connectedBuildingIds)}
            energy={energy}
            organization={organization}
            readOnly={phase !== "playing"}
            nukeReloadBlockReason={
              inspectedBuilding.buildingId === "nuke_missile" && myPlayerId
                ? nukeReloadRejectReason(
                    buildings,
                    myPlayerId,
                    terrain,
                    connectedBuildingIds,
                  )
                : null
            }
            onAction={(action: BuildingInspectAction, b, detail) => {
              log.info("building-action", action, b.buildingId, b.gx, b.gy, detail);
              if (action === "attack") {
                const dest = snapToUnitCoord(b.gx, b.gy);
                setMobilize({
                  mode: "attack",
                  gx: dest.gx,
                  gy: dest.gy,
                  sources: {},
                  unitIds: [],
                  targetBuildingId: b.id,
                });
                return;
              }
              if (action === "garrison") {
                const dest = snapToUnitCoord(b.gx, b.gy);
                setMobilize({
                  mode: "hold",
                  gx: dest.gx,
                  gy: dest.gy,
                  sources: {},
                  unitIds: [],
                  holdBuildingId: b.id,
                });
                return;
              }
              if (action === "mutual_defense") {
                setMutualAimNote("选择相邻/对角的己方建筑");
                setMutualAim((cur) => (cur === b.id ? null : b.id));
                return;
              }
              if (action === "end_mutual_defense") {
                onEndMutualDefense?.(b.id);
                return;
              }
              if (action === "supply") {
                const dest = snapToUnitCoord(b.gx, b.gy);
                setMobilize({
                  mode: "supply",
                  gx: dest.gx,
                  gy: dest.gy,
                  sources: {},
                  unitIds: [],
                  supplyBuildingId: b.id,
                });
                return;
              }
              const linked = isBuildingCommsLinked(b.id, connectedIdsRef.current);
              if (action === "demolish") {
                pendingDemolishIdsRef.current.add(b.id);
                onDemolish?.(b.id);
                clearSelection();
                return;
              }
              if (b.polluted) {
                logLocalReject({
                  action,
                  category: "building",
                  summary: `建筑操作 ${action} ${b.buildingId}`,
                  reason: "污染区内建筑已失效，只能拆除",
                  detail: `(${b.gx}, ${b.gy})`,
                });
                return;
              }
              if (!linked) {
                logLocalReject({
                  action,
                  category: "building",
                  summary: `建筑操作 ${action} ${b.buildingId}`,
                  reason: "建筑未接入通信，无法执行该命令",
                  detail: `(${b.gx}, ${b.gy})`,
                });
                return;
              }
              if (action === "fire") {
                setFireAimNote("选择目标");
                setFireAim(b.id);
                const circles = workRangeCircles(
                  b,
                  buildings,
                  connectedBuildingIds,
                );
                if (circles.length > 0) fitWorkRangeCircles(circles);
                return;
              }
              if (action === "repair") {
                onRepair?.(b.id);
                clearSelection();
                return;
              }
              if (action === "level_upgrade") {
                onLevelUpgrade?.(b.id);
                return;
              }
              if (action === "relocate_capital") {
                onRelocateCapital?.(b.id);
                return;
              }
              if (action === "reload") {
                if (b.buildingId === "nuke_missile" && myPlayerId) {
                  const reason = nukeReloadRejectReason(
                    buildings,
                    myPlayerId,
                    terrainRef.current,
                    connectedIdsRef.current,
                  );
                  if (reason) {
                    logLocalReject({
                      action,
                      category: "building",
                      summary: `装填 ${b.buildingId}`,
                      reason,
                      detail: `(${b.gx}, ${b.gy})`,
                    });
                    return;
                  }
                }
                const count = detail?.count ?? 1;
                if (count >= 1) onReload?.(b.id, count);
                return;
              }
              if (action === "build_carrier") {
                onBuildCarrier?.(b.id);
                return;
              }
              if (action === "deploy") {
                const count = detail?.count ?? 0;
                if (count >= 1) {
                  onDeploy?.(b.id, count);
                  return;
                }
                const kind = unitKindFromBuilding(b.buildingId);
                if (!kind) {
                  logLocalReject({
                    action: "deploy",
                    category: "building",
                    summary: "部署",
                    reason: "该建筑无法部署",
                  });
                  return;
                }
                const dest = snapToUnitCoord(b.gx, b.gy);
                setFocusMarks([]);
                setMobilize({
                  mode: "assign",
                  gx: dest.gx,
                  gy: dest.gy,
                  sources: {},
                  unitIds: [],
                  assignBuildingId: b.id,
                });
                return;
              }
              if (action === "train") {
                setFocusMarks([]);
                setTrainUi({
                  sourceId: b.id,
                  kind: "infantry",
                  u: 1,
                  targetIds: [],
                });
                return;
              }
              if (action === "upgrade") {
                const ground = groundAt(b.gx, b.gy);
                setBuildMode({
                  fromX: selectionUi.screenX,
                  fromY: selectionUi.screenY,
                  gx: b.gx,
                  gy: b.gy,
                  currentBuildingId: b.buildingId,
                  ground,
                });
                clearSelection();
              }
            }}
          />
        )}
      {selectionUi &&
        selectionUi.kind === "unit" &&
        inspectedUnit &&
        inspectHudReady &&
        !buildMode &&
        (phase === "playing" || phase === "spectating" || phase === "ended") && (
          <UnitInspectHud
            unit={inspectedUnit}
            screenX={selectionUi.screenX}
            screenY={selectionUi.screenY}
            myPlayerId={phase === "playing" ? myPlayerId : null}
            energy={energy}
            organization={organization}
            terrain={terrain}
            liaisons={liaisons}
            units={units}
            buildings={buildings}
            onAction={(action: UnitInspectAction, u, detail) => {
              if (phase !== "playing") return;
              log.info("unit-action", action, u.kind, u.id.slice(0, 8));
              if (action === "retreat" || action === "stop") {
                onStopUnits?.([u.id], action === "retreat");
                return;
              }
              if (action === "attack") {
                const dest = snapToUnitCoord(u.gx, u.gy);
                setMobilize({
                  mode: "attack",
                  gx: dest.gx,
                  gy: dest.gy,
                  sources: {},
                  unitIds: [],
                  targetUnitId: u.id,
                });
                return;
              }
              if (action === "embark_air") {
                const airId = detail?.airUnitId;
                if (airId) onEmbarkAir?.(u.id, airId);
                else {
                  logLocalReject({
                    action: "embark_air",
                    summary: `空军上舰 → ${u.id.slice(0, 8)}`,
                    reason: "未选择空军单位",
                  });
                }
                return;
              }
              if (action === "disembark_air") {
                onDisembarkAir?.(u.id);
                return;
              }
            }}
          />
        )}
      {enemyLiaison && !buildMode && phase === "playing" && !mobilize && (
        <div className="building-inspect" aria-label="进攻联络线">
          <div
            className="unit-inspect-row"
            style={{ left: enemyLiaison.screenX + 36, top: enemyLiaison.screenY - 20 }}
          >
            <button
              type="button"
              className="building-inspect-op"
              title="选择己方单位进攻这一段联络线"
              aria-label="进攻"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setMobilize({
                  mode: "attack",
                  gx: enemyLiaison.gx,
                  gy: enemyLiaison.gy,
                  sources: {},
                  unitIds: [],
                  targetLiaisonId: enemyLiaison.id,
                  liaisonAx: enemyLiaison.ax,
                  liaisonAy: enemyLiaison.ay,
                  liaisonBx: enemyLiaison.bx,
                  liaisonBy: enemyLiaison.by,
                });
                setEnemyLiaison(null);
              }}
            >
              <span className="point-action-icon" aria-hidden>
                <img src="/icons/symbol/operation/attack.png" alt="" draggable={false} />
              </span>
              <span className="point-action-label">进攻</span>
            </button>
          </div>
        </div>
      )}
      {mobilize && phase === "playing" && (
        <MobilizePanel
          mode={mobilize.mode}
          destGx={mobilize.gx}
          destGy={mobilize.gy}
          buildings={buildings}
          units={units}
          myPlayerId={myPlayerId}
          organization={organization}
          energy={energy}
          sources={mobilize.sources}
          unitIds={mobilize.unitIds}
          assignBuildingId={mobilize.assignBuildingId}
          planError={planError}
          onToggleSource={(buildingId, u) => {
            const turningOn = mobilize.sources[buildingId] == null;
            const b = buildings.find((x) => x.id === buildingId);
            let path: Array<{ gx: number; gy: number }> | null = null;
            if (
              turningOn &&
              b &&
              map &&
              terrain &&
              myPlayerId != null &&
              mobilize.mode !== "assign" &&
              !(mobilize.mode === "attack" && mobilize.targetLiaisonId)
            ) {
              let n = 0;
              const result = previewUnitMove(
                {
                  ownerId: myPlayerId,
                  gx: mobilize.gx,
                  gy: mobilize.gy,
                  sources: [{ buildingId, u }],
                  asBlockade: mobilize.mode === "blockade",
                  asSupply: mobilize.mode === "supply",
                  supplyBuildingId: mobilize.supplyBuildingId,
                  asHold: mobilize.mode === "hold",
                  holdBuildingId: mobilize.holdBuildingId,
                  attackTargetUnitId:
                    mobilize.mode === "attack" ? mobilize.targetUnitId : undefined,
                  attackTargetBuildingId:
                    mobilize.mode === "attack" ? mobilize.targetBuildingId : undefined,
                },
                {
                  map,
                  terrain,
                  buildings,
                  liaisons,
                  units,
                  connectedIds: connectedBuildingIds,
                  nextId: () => `preview-${++n}`,
                },
              );
              path =
                result.paths[0] ??
                [
                  { gx: b.gx, gy: b.gy },
                  { gx: mobilize.gx, gy: mobilize.gy },
                ];
            }
            if (b)
              syncFocus(`b:${buildingId}`, b.gx, b.gy, turningOn, {
                kind: "building",
                buildingId,
                path,
              });
            setMobilize((cur) => {
              if (!cur) return cur;
              const next = { ...cur.sources };
              if (next[buildingId] != null) delete next[buildingId];
              else next[buildingId] = u;
              return { ...cur, sources: next };
            });
          }}
          onToggleUnit={(id) => {
            const turningOn = !mobilize.unitIds.includes(id);
            const u = units.find((x) => x.id === id);
            let path: Array<{ gx: number; gy: number }> | null = null;
            if (
              turningOn &&
              u &&
              map &&
              terrain &&
              myPlayerId != null &&
              mobilize.mode !== "assign" &&
              !(mobilize.mode === "attack" && mobilize.targetLiaisonId)
            ) {
              let n = 0;
              const result = previewUnitMove(
                {
                  ownerId: myPlayerId,
                  gx: mobilize.gx,
                  gy: mobilize.gy,
                  unitIds: [id],
                  asBlockade: mobilize.mode === "blockade",
                  asSupply: mobilize.mode === "supply",
                  supplyBuildingId: mobilize.supplyBuildingId,
                  asHold: mobilize.mode === "hold",
                  holdBuildingId: mobilize.holdBuildingId,
                  attackTargetUnitId:
                    mobilize.mode === "attack" ? mobilize.targetUnitId : undefined,
                  attackTargetBuildingId:
                    mobilize.mode === "attack" ? mobilize.targetBuildingId : undefined,
                },
                {
                  map,
                  terrain,
                  buildings,
                  liaisons,
                  units,
                  connectedIds: connectedBuildingIds,
                  nextId: () => `preview-${++n}`,
                },
              );
              path =
                result.paths[0] ??
                [
                  { gx: u.gx, gy: u.gy },
                  { gx: mobilize.gx, gy: mobilize.gy },
                ];
            }
            if (u)
              syncFocus(`u:${id}`, u.gx, u.gy, turningOn, {
                kind: "unit",
                unitId: id,
                path,
              });
            setMobilize((cur) => {
              if (!cur) return cur;
              const has = cur.unitIds.includes(id);
              return {
                ...cur,
                unitIds: has ? cur.unitIds.filter((x) => x !== id) : [...cur.unitIds, id],
              };
            });
          }}
          onStop={() => {
            const pool =
              mobilize.unitIds.length > 0
                ? units.filter((u) => mobilize.unitIds.includes(u.id))
                : units.filter(
                    (u) =>
                      isMovingState(u.state) ||
                      u.state === "blockading" ||
                      u.state === "holding",
                  );
            const stoppable = pool
              .filter(
                (u) =>
                  myPlayerId != null &&
                  u.ownerId === myPlayerId &&
                  canUnitStop(u, { buildings, units }),
              )
              .map((u) => u.id);
            if (stoppable.length > 0) onStopUnits?.(stoppable, false);
            else {
              logLocalReject({
                action: "stop_units",
                summary: "停止",
                reason: "没有可停止的单位",
              });
            }
          }}
          onGo={() => {
            const sources = Object.entries(mobilize.sources).map(([buildingId, u]) => ({
              buildingId,
              u,
            }));
            const args = {
              gx: mobilize.gx,
              gy: mobilize.gy,
              sources: sources.length > 0 ? sources : undefined,
              unitIds: mobilize.unitIds.length > 0 ? mobilize.unitIds : undefined,
            };
            if (mobilize.mode === "assign" && mobilize.assignBuildingId) {
              onAssignHome?.({
                buildingId: mobilize.assignBuildingId,
                unitIds: mobilize.unitIds,
              });
            } else if (mobilize.mode === "blockade") onBlockadeUnits?.(args);
            else if (mobilize.mode === "supply" && mobilize.supplyBuildingId) {
              onSupplyUnits?.({
                ...args,
                supplyBuildingId: mobilize.supplyBuildingId,
              });
            } else if (mobilize.mode === "attack") {
              onAttackUnits?.({
                sources: args.sources,
                unitIds: args.unitIds,
                targetUnitId: mobilize.targetUnitId,
                targetBuildingId: mobilize.targetBuildingId,
                targetLiaisonId: mobilize.targetLiaisonId,
                liaisonAx: mobilize.liaisonAx,
                liaisonAy: mobilize.liaisonAy,
                liaisonBx: mobilize.liaisonBx,
                liaisonBy: mobilize.liaisonBy,
              });
            } else if (mobilize.mode === "hold" && mobilize.holdBuildingId) {
              onHoldUnits?.({
                holdBuildingId: mobilize.holdBuildingId,
                sources: args.sources,
                unitIds: args.unitIds,
              });
            } else onMoveUnits?.(args);
            closeMobilize();
            clearSelection();
          }}
          onEndBlockade={() => {
            const ids = mobilize.unitIds.filter((id) => {
              const u = units.find((x) => x.id === id);
              return u != null && u.state === "blockading";
            });
            if (ids.length > 0) onEndBlockade?.(ids);
            else {
              logLocalReject({
                action: "end_blockade",
                summary: "结束封锁",
                reason: "未选中封锁中的单位",
              });
            }
            closeMobilize();
            clearSelection();
          }}
          onEndHold={() => {
            const ids = mobilize.unitIds.filter((id) => {
              const u = units.find((x) => x.id === id);
              return u != null && u.state === "holding";
            });
            if (ids.length > 0) onEndHold?.(ids);
            else {
              logLocalReject({
                action: "end_hold",
                summary: "结束驻守",
                reason: "未选中驻守中的单位",
              });
            }
            closeMobilize();
            clearSelection();
          }}
          onClose={closeMobilize}
        />
      )}
      {trainUi && phase === "playing" && (() => {
        const source = buildings.find((b) => b.id === trainUi.sourceId);
        if (!source) return null;
        return (
          <TrainPanel
            source={source}
            buildings={buildings}
            units={units}
            myPlayerId={myPlayerId}
            energy={energy}
            kind={trainUi.kind}
            u={trainUi.u}
            targetIds={trainUi.targetIds}
            onKind={(kind) => {
              setFocusMarks([]);
              setTrainUi((cur) => (cur ? { ...cur, kind, targetIds: [] } : cur));
            }}
            onU={(u) => setTrainUi((cur) => (cur ? { ...cur, u } : cur))}
            onToggleTarget={(id) => {
              const turningOn = !trainUi.targetIds.includes(id);
              const b = buildings.find((x) => x.id === id);
              const source = buildings.find((x) => x.id === trainUi.sourceId);
              let path: Array<{ gx: number; gy: number }> | null = null;
              if (turningOn && b && source && map && terrain && myPlayerId != null) {
                let n = 0;
                const result = previewTrainingDeliveryPath(
                  myPlayerId,
                  trainUi.kind,
                  source.gx,
                  source.gy,
                  b.gx,
                  b.gy,
                  b.id,
                  {
                    map,
                    terrain,
                    buildings,
                    liaisons,
                    units,
                    connectedIds: connectedBuildingIds,
                    nextId: () => `preview-${++n}`,
                  },
                );
                path =
                  result.path.length >= 1
                    ? result.path
                    : [
                        { gx: source.gx, gy: source.gy },
                        { gx: b.gx, gy: b.gy },
                      ];
              }
              if (b)
                syncFocus(`t:${id}`, b.gx, b.gy, turningOn, {
                  kind: "building",
                  buildingId: id,
                  path,
                });
              setTrainUi((cur) => {
                if (!cur) return cur;
                const on = cur.targetIds.includes(id);
                const targetIds = on
                  ? cur.targetIds.filter((x) => x !== id)
                  : [...cur.targetIds, id];
                const maxU = targetIds.reduce((sum, tid) => {
                  const tb = buildings.find((x) => x.id === tid);
                  if (!tb) return sum;
                  return sum + availableTrainingRoom(tb, buildings, units);
                }, 0);
                return {
                  ...cur,
                  targetIds,
                  u: maxU >= 1 ? maxU : cur.u,
                };
              });
            }}
            onGo={(amount) => {
              if (trainUi.targetIds.length === 0) {
                logLocalReject({
                  action: "train",
                  summary: `训练 ${trainUi.kind} U${amount}`,
                  reason: "请选择至少一个目标建筑",
                });
                return;
              }
              onTrain?.({
                id: trainUi.sourceId,
                kind: trainUi.kind,
                u: amount,
                targetIds: trainUi.targetIds,
              });
              setFocusMarks([]);
              setTrainUi(null);
              clearSelection();
            }}
            onClose={() => {
              setFocusMarks([]);
              setTrainUi(null);
            }}
          />
        );
      })()}
      {buildMode && phase === "playing" && (
        <BuildModeOverlay
          fromX={buildMode.fromX}
          fromY={buildMode.fromY}
          currentBuildingId={buildMode.currentBuildingId}
          ground={buildMode.ground}
          initialMode={buildMode.initialMode}
          enterLiaisonNonce={buildMode.liaisonNonce ?? 0}
          errorMessage={liaisonLocalError}
          liaisonDraftCost={liaisonDraftCost}
          onClose={() => {
            setLiaisonKind(null);
            setLiaisonDraft(null);
            setLiaisonAwaitConfirm(false);
            setLiaisonDemolishId(null);
            setLiaisonEditActive(false);
            setBuildMode(null);
          }}
          onPickBuilding={onPickBuilding}
          onLiaisonKindChange={onLiaisonKindChange}
          onLiaisonEditActiveChange={onLiaisonEditActiveChange}
        />
      )}
      {liaisonAwaitConfirm && liaisonKind && liaisonDraftCost && (
        <div className="liaison-confirm-bar" role="dialog" aria-label="确认建造联络线">
          <div className="liaison-confirm-text">
            确认建造{LIAISON_BY_ID[liaisonKind].name}？
            <span>
              {liaisonDraftCost.lengthDu.toFixed(2)} Du · {liaisonDraftCost.energy} E
            </span>
          </div>
          <div className="liaison-confirm-actions">
            <button type="button" className="liaison-confirm-btn is-ghost" onClick={cancelBuildLiaison}>
              取消
            </button>
            <button type="button" className="liaison-confirm-btn is-primary" onClick={confirmBuildLiaison}>
              确认建造 (Enter)
            </button>
          </div>
        </div>
      )}
      {demolishTarget && !liaisonAwaitConfirm && (
        <div className="liaison-confirm-bar" role="dialog" aria-label="确认拆除联络线">
          <div className="liaison-confirm-text">
            拆除{LIAISON_BY_ID[demolishTarget.kind].name}？
            <span>返还 {demolishLiaisonRefundE(demolishTarget.investedE)} E</span>
          </div>
          <div className="liaison-confirm-actions">
            <button
              type="button"
              className="liaison-confirm-btn is-ghost"
              onClick={() => setLiaisonDemolishId(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="liaison-confirm-btn is-danger"
              onClick={confirmDemolishLiaison}
            >
              确认拆除
            </button>
          </div>
        </div>
      )}
      {fireAim && (
        <div ref={fireHintRef} className="shift-demolish-hint">
          {fireAimNote}
        </div>
      )}
      {mutualAim && (
        <div ref={mutualHintRef} className="shift-demolish-hint">
          {mutualAimNote}
        </div>
      )}
      {shiftDemolishHint && (
        <div ref={shiftHintRef} className="shift-demolish-hint">
          {liaisonEditActive ? "双击联络线拆除" : "双击建筑拆除"}
        </div>
      )}
      {map && miniSize.width > 0 && (
        <div className="minimap-stack" style={{ width: miniSize.width }}>
          <ChatPanel
            messages={chatMessages}
            width={miniSize.width}
            onSend={(text) => onSendChat?.(text)}
          />
          <canvas
            ref={miniRef}
            className="minimap"
            width={Math.round(miniSize.width * devicePixelRatio)}
            height={Math.round(miniSize.height * devicePixelRatio)}
            style={{ width: miniSize.width, height: miniSize.height }}
          />
        </div>
      )}
    </>
  );
}
