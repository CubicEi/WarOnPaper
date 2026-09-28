import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getBuildTree,
  BUILDING_BY_ID,
  LIAISON_LINES,
  type BuildingDef,
  type GroundContext,
  type LiaisonKind,
} from "@wop/shared";
import { buildingUiIcon } from "../ui/buildingUiIcon";
import { BuildTreePanel, BUILD_TREE_REVEAL_MS } from "./BuildTreePanel";

const BUILD_ICON = "/icons/symbol/operation/build.png";

/** Liaison button enter/exit — keep in sync with `.liaison-line-btn` anim in styles.css. */
const LIAISON_BTN_ANIM_MS = 300;

const LIAISON_ICONS: Record<LiaisonKind, string> = {
  fiber: buildingUiIcon("/icons/buildings/transport/fiber.png"),
  road: buildingUiIcon("/icons/buildings/transport/road.png"),
  railway: buildingUiIcon("/icons/buildings/transport/railway.png"),
};

type BuildOverlayMode = "buildings" | "liaison";

interface Props {
  /** Screen position of the build button icon center when clicked. */
  fromX: number;
  fromY: number;
  /** Current building on the tile; null = 空地. */
  currentBuildingId: string | null;
  ground: GroundContext;
  /** Error message to display (e.g. from failed build attempt). */
  errorMessage?: string | null;
  /** Live cost while dragging / awaiting confirm. */
  liaisonDraftCost?: {
    energy: number;
    lengthDu: number;
    terrainSurchargeE?: number;
  } | null;
  /** Open directly on the liaison editor (E). */
  initialMode?: BuildOverlayMode;
  /** Increment to switch an already-open overlay into liaison edit. */
  enterLiaisonNonce?: number;
  onClose: () => void;
  onPickBuilding?: (building: BuildingDef) => void;
  onLiaisonKindChange?: (kind: LiaisonKind | null) => void;
  /** True while in 「编辑联络线」 sub-mode (for map demolish picks). */
  onLiaisonEditActiveChange?: (active: boolean) => void;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Build mode: dim fullscreen, fly build icon to top-left with label, X to exit,
 * and show upgrade tree from current building / empty land.
 * 「编辑联络线」switches to a brighter liaison sub-mode with fiber/road/railway.
 */
export function BuildModeOverlay({
  fromX,
  fromY,
  currentBuildingId,
  ground,
  errorMessage = null,
  liaisonDraftCost = null,
  initialMode = "buildings",
  enterLiaisonNonce = 0,
  onClose,
  onPickBuilding,
  onLiaisonKindChange,
  onLiaisonEditActiveChange,
}: Props) {
  const [docked, setDocked] = useState(false);
  const [mode, setMode] = useState<BuildOverlayMode>(initialMode);
  const [selectedLiaison, setSelectedLiaison] = useState<LiaisonKind | null>(null);
  /** Reverse-hide build tree, then call onClose. */
  const [treeExiting, setTreeExiting] = useState(false);
  /** Keep liaison chrome mounted through exit fade. */
  const [liaisonMounted, setLiaisonMounted] = useState(initialMode === "liaison");
  const [liaisonExiting, setLiaisonExiting] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liaisonTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closingRef = useRef(false);

  // Building on an artificial island: same layout as empty land, but limited to
  // small/medium buildings and excluding sea-only structures.
  const onIsland = currentBuildingId === "artificial_island";

  const roots = useMemo(
    () =>
      onIsland
        ? getBuildTree(null, "land", { maxSize: "medium", excludeSeaOnly: true })
        : getBuildTree(currentBuildingId, ground),
    [currentBuildingId, ground, onIsland],
  );

  const currentLabel = onIsland
    ? "人工岛"
    : currentBuildingId == null
      ? "空地"
      : (BUILDING_BY_ID[currentBuildingId]?.name ?? currentBuildingId);

  const selectedDef = useMemo(
    () => LIAISON_LINES.find((l) => l.id === selectedLiaison) ?? null,
    [selectedLiaison],
  );

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current != null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const clearLiaisonTimer = useCallback(() => {
    if (liaisonTimerRef.current != null) {
      clearTimeout(liaisonTimerRef.current);
      liaisonTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => setDocked(true));
    });
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    onLiaisonKindChange?.(mode === "liaison" ? selectedLiaison : null);
  }, [mode, selectedLiaison, onLiaisonKindChange]);

  useEffect(() => {
    onLiaisonEditActiveChange?.(mode === "liaison");
  }, [mode, onLiaisonEditActiveChange]);

  useEffect(() => {
    return () => {
      onLiaisonKindChange?.(null);
      onLiaisonEditActiveChange?.(false);
      clearCloseTimer();
      clearLiaisonTimer();
    };
  }, [onLiaisonKindChange, onLiaisonEditActiveChange, clearCloseTimer, clearLiaisonTimer]);

  const enterLiaisonMode = useCallback(() => {
    clearLiaisonTimer();
    setMode("liaison");
    setSelectedLiaison(null);
    setLiaisonExiting(false);
    setLiaisonMounted(true);
  }, [clearLiaisonTimer]);

  const leaveLiaisonMode = useCallback(() => {
    if (liaisonExiting || !liaisonMounted) {
      setMode("buildings");
      setSelectedLiaison(null);
      setLiaisonMounted(false);
      setLiaisonExiting(false);
      return;
    }
    const ms = prefersReducedMotion() ? 0 : LIAISON_BTN_ANIM_MS;
    setLiaisonExiting(true);
    // Stay in liaison mode until chrome finishes fading so map edit stays active.
    clearLiaisonTimer();
    liaisonTimerRef.current = setTimeout(() => {
      liaisonTimerRef.current = null;
      setMode("buildings");
      setSelectedLiaison(null);
      setLiaisonMounted(false);
      setLiaisonExiting(false);
    }, ms);
  }, [clearLiaisonTimer, liaisonExiting, liaisonMounted]);

  useEffect(() => {
    if (!enterLiaisonNonce) return;
    enterLiaisonMode();
  }, [enterLiaisonNonce, enterLiaisonMode]);

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    clearCloseTimer();
    clearLiaisonTimer();

    const reduced = prefersReducedMotion();

    if (mode === "liaison" || liaisonMounted) {
      setLiaisonExiting(true);
      const ms = reduced ? 0 : LIAISON_BTN_ANIM_MS;
      closeTimerRef.current = setTimeout(() => {
        closeTimerRef.current = null;
        onClose();
      }, ms);
      return;
    }

    setTreeExiting(true);
    const ms = reduced ? 0 : BUILD_TREE_REVEAL_MS;
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      onClose();
    }, ms);
  }, [clearCloseTimer, clearLiaisonTimer, mode, liaisonMounted, onClose]);

  useEffect(() => {
    const typing = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      return (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      );
    };
    /** Digit keys in liaison edit: 1 铁路 / 2 公路 / 3 线缆 (same toggle as buttons). */
    const LIAISON_HOTKEYS: Record<string, LiaisonKind> = {
      Digit1: "railway",
      Digit2: "road",
      Digit3: "fiber",
      Numpad1: "railway",
      Numpad2: "road",
      Numpad3: "fiber",
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (mode === "liaison" && !closingRef.current) {
          leaveLiaisonMode();
          return;
        }
        requestClose();
        return;
      }
      if (
        e.code === "KeyE" &&
        mode === "liaison" &&
        !e.repeat &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        !e.shiftKey &&
        !typing(e.target)
      ) {
        e.preventDefault();
        requestClose();
        return;
      }
      if (mode !== "liaison" || liaisonExiting) return;
      if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      if (typing(e.target)) return;
      const kind = LIAISON_HOTKEYS[e.code];
      if (!kind) return;
      e.preventDefault();
      setSelectedLiaison((prev) => (prev === kind ? null : kind));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose, leaveLiaisonMode, mode, liaisonExiting]);

  const pickLiaison = (id: LiaisonKind) => {
    if (liaisonExiting) return;
    setSelectedLiaison((prev) => (prev === id ? null : id));
  };

  const showBuildTree = docked && mode === "buildings" && !liaisonMounted;
  const showLiaisonPanel = docked && liaisonMounted;
  const liaisonBtnPhase = liaisonExiting ? "is-exiting" : "is-entering";

  return (
    <div
      className={`build-mode${mode === "liaison" ? " is-liaison" : ""}${
        mode === "liaison" && selectedLiaison ? " has-liaison-pick" : ""
      }${treeExiting || liaisonExiting ? " is-closing" : ""}`}
      role="dialog"
      aria-label={mode === "liaison" ? "编辑联络线" : "建造"}
    >
      <div className="build-mode-dim" />
      <div
        className={`build-mode-header${docked ? " docked" : ""}`}
        style={
          docked
            ? undefined
            : {
                left: fromX,
                top: fromY,
              }
        }
      >
        <span className="build-mode-icon">
          <img src={BUILD_ICON} alt="" draggable={false} />
        </span>
        <span className="build-mode-title">
          {mode === "liaison" ? "联络线" : "建造"}
        </span>
      </div>
      <div className="build-mode-top-actions">
        {mode === "buildings" && !liaisonMounted ? (
          <button
            type="button"
            className="build-mode-liaison-btn"
            aria-label="编辑联络线"
            title="编辑联络线"
            disabled={treeExiting}
            onClick={enterLiaisonMode}
          >
            编辑联络线
          </button>
        ) : (
          <button
            type="button"
            className="build-mode-liaison-btn"
            aria-label="返回建筑建造"
            title="返回建筑建造"
            disabled={liaisonExiting || treeExiting}
            onClick={leaveLiaisonMode}
          >
            返回建造
          </button>
        )}
        <button
          type="button"
          className="build-mode-close"
          aria-label="退出建造"
          title="退出建造"
          disabled={treeExiting || liaisonExiting}
          onClick={requestClose}
        >
          ×
        </button>
      </div>
      {errorMessage && (
        <div className="build-mode-error" role="alert">
          {errorMessage}
        </div>
      )}
      {showBuildTree && (
        <BuildTreePanel
          roots={roots}
          currentLabel={currentLabel}
          // Island is a platform, not an upgrade base — cost/duration as from empty land.
          currentBuildingId={onIsland ? null : currentBuildingId}
          exiting={treeExiting}
          onSelect={onPickBuilding}
        />
      )}
      {showLiaisonPanel && (
        <div className={`liaison-panel${liaisonExiting ? " is-exiting" : ""}`}>
          <div className="liaison-line-list" role="list" aria-label="联络线类型">
            {LIAISON_LINES.map((line) => {
              const selected = selectedLiaison === line.id;
              return (
                <button
                  key={line.id}
                  type="button"
                  role="listitem"
                  className={`liaison-line-btn ${liaisonBtnPhase}${selected ? " is-selected" : ""}`}
                  aria-pressed={selected}
                  aria-label={line.name}
                  disabled={liaisonExiting}
                  onClick={() => pickLiaison(line.id)}
                >
                  <span className="liaison-line-icon" aria-hidden>
                    <img src={LIAISON_ICONS[line.id]} alt="" draggable={false} />
                  </span>
                  <span className="liaison-line-name">{line.name}</span>
                </button>
              );
            })}
          </div>
          {selectedDef && (
            <div
              className={`liaison-info-panel ${liaisonBtnPhase}`}
              role="dialog"
              aria-label={`${selectedDef.name} 信息`}
            >
              <div className="liaison-info-title">{selectedDef.name}</div>
              <div className="liaison-info-rows">
                <div className="liaison-info-row">
                  <span>造价</span>
                  <span>+{selectedDef.costPerDu} / Du</span>
                </div>
                <div className="liaison-info-row">
                  <span>最大长度</span>
                  <span>&lt; {selectedDef.maxLengthDu} Du</span>
                </div>
                {liaisonDraftCost && liaisonDraftCost.lengthDu > 0 && (
                  <div className="liaison-info-row">
                    <span>本次</span>
                    <span>
                      {liaisonDraftCost.lengthDu.toFixed(2)} Du · {liaisonDraftCost.energy} E
                      {liaisonDraftCost.terrainSurchargeE
                        ? `（含地形+${liaisonDraftCost.terrainSurchargeE}）`
                        : ""}
                    </span>
                  </div>
                )}
                <div className="liaison-info-note">拖动绘制，松手后确认；点击已有线可拆除</div>
                {(selectedDef.id === "road" || selectedDef.id === "railway") && (
                  <>
                    <div className="liaison-info-note">
                      {selectedDef.id === "railway"
                        ? "山区 +200E/Du，海洋 +250E/Du"
                        : "山区 +150E/Du，海洋 +150E/Du"}
                      ；山脚/海岸线半价
                    </div>
                    <div className="liaison-info-note">
                      穿越林地 +50E/Du；沿林缘不加
                    </div>
                  </>
                )}
                {selectedDef.id === "railway" && (
                  <>
                    <div className="liaison-info-note">
                      铁路须从已建成且接入通信的车站开始，可画到规划中的车站
                    </div>
                    <div className="liaison-info-note">
                      铁路可传信但不直连沿线建筑；需线缆/公路接到铁路
                    </div>
                  </>
                )}
                {selectedDef.moveSpeedDuPerS != null ? (
                  <div className="liaison-info-note">
                    单位在{selectedDef.name}上移动 {selectedDef.moveSpeedDuPerS} Du/s
                  </div>
                ) : (
                  <div className="liaison-info-note">单位移动无加速</div>
                )}
              </div>
            </div>
          )}
          {!selectedDef && (
            <div className={`liaison-info-panel ${liaisonBtnPhase}`} role="status">
              <div className="liaison-info-title">编辑联络线</div>
              <div className="liaison-info-note">选择类型后拖动绘制；或点击已有联络线拆除</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
