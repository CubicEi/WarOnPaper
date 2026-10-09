import { useCallback, useEffect, useRef, useState } from "react";
import {
  capitalSiteRejectMessage,
  capitalSiteRejectReason,
  capitalExclusionRejectReason,
  mergeGameStateSnapshot,
  type GameStateSnapshot,
  type GroundContext,
  type GridNode,
  type LiaisonKind,
  type TerrainMap,
} from "@wop/shared";
import { GameCanvas } from "./canvas/GameCanvas";
import { DebugOverlay, type DebugErrorEntry } from "./components/DebugOverlay";
import { ErrorToast } from "./components/ErrorToast";
import { HudOverlay } from "./components/HudOverlay";
import { TeamPanel, TeamPanelButton } from "./components/TeamPanel";
import { useGameSocket } from "./net/useGameSocket";
import { log } from "./net/log";
import { logLocalReject } from "./debug/playerActionLog";
import { applyTerrainSeed, syncTerrainResources } from "./game/initGame";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

export function App() {
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [state, setState] = useState<GameStateSnapshot | null>(null);
  const [terrain, setTerrain] = useState<TerrainMap | null>(null);
  const onState = useCallback((next: GameStateSnapshot) => {
    // Server is sole source of truth for you.energy / you.organization.
    // Bootstrap / change-only / entity-delta fields may be omitted — merge retains cache.
    setState((prev) => {
      const merged = mergeGameStateSnapshot(prev, next);
      const buildingDelta =
        (merged.buildings?.length ?? 0) !== (prev?.buildings?.length ?? 0) ||
        (merged.liaisons?.length ?? 0) !== (prev?.liaisons?.length ?? 0) ||
        (merged.units?.length ?? 0) !== (prev?.units?.length ?? 0) ||
        merged.you.energy !== prev?.you.energy ||
        merged.you.organization !== prev?.you.organization ||
        merged.phase !== prev?.phase ||
        merged.terrainSeed !== prev?.terrainSeed;
      if (buildingDelta) {
        log.info("app", "state apply", {
          tick: merged.tick,
          phase: merged.phase,
          E: merged.you.energy,
          O: merged.you.organization,
          buildings: merged.buildings?.length ?? 0,
          liaisons: merged.liaisons?.length ?? 0,
          terrainSeed: merged.terrainSeed,
          sample: merged.buildings?.[0],
        });
      }
      return merged;
    });
  }, []);

  const pushErrorRef = useRef<(friendly: string, raw: string) => void>(() => {});

  const { status, send, lastError, clearError, lastTip, clearTip, playerId, chatMessages, leaveRoom } =
    useGameSocket(onState, {
      onRoomLifecycle: (ev) => {
        log.info("app", "room lifecycle", ev);
        if (ev.type === "game_over") {
          const teamWin =
            ev.winnerNames && ev.winnerNames.length > 1
              ? `胜负已分：${ev.winnerNames.join("、")} 队伍获胜`
              : `胜负已分：${ev.winnerName} 获胜`;
          pushErrorRef.current(
            teamWin,
            `game_over:${ev.winnerTeamId ?? ev.winnerId}`,
          );
        } else if (ev.type === "room_closed") {
          pushErrorRef.current(
            ev.reason === "idle" ? "房间因空闲已关闭" : "房间已关闭",
            `room_closed:${ev.reason}`,
          );
          setState(null);
        }
      },
    });

  const onReturnToMenu = useCallback(() => {
    leaveRoom();
    setState(null);
    // Manager hosts title at `/`; /play/ is a separate SPA so navigate away.
    window.location.assign("/");
  }, [leaveRoom]);

  const [debugOpen, setDebugOpen] = useState(false);
  const [showEnemyVision, setShowEnemyVision] = useState(false);
  const [showCommStatus, setShowCommStatus] = useState(false);
  const [teamPanelOpen, setTeamPanelOpen] = useState(false);
  const [errorLog, setErrorLog] = useState<DebugErrorEntry[]>([]);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastKey, setToastKey] = useState(0);
  const [toastVariant, setToastVariant] = useState<"error" | "warn">("error");
  const errorIdRef = useRef(0);

  const pushError = useCallback((friendly: string, raw: string) => {
    errorIdRef.current += 1;
    const id = errorIdRef.current;
    setErrorLog((prev) => [...prev.slice(-49), { id, text: raw }]);
    setToastVariant("error");
    setToastMessage(friendly);
    setToastKey(id);
  }, []);
  const pushTip = useCallback((friendly: string) => {
    errorIdRef.current += 1;
    const id = errorIdRef.current;
    setToastVariant("warn");
    setToastMessage(friendly);
    setToastKey(id);
  }, []);
  pushErrorRef.current = pushError;
  useEffect(() => {
    if (!lastError) return;
    pushError(lastError.message, lastError.raw);
  }, [lastError, pushError]);
  useEffect(() => {
    if (!lastTip) return;
    pushTip(lastTip);
    clearTip();
  }, [lastTip, pushTip, clearTip]);

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key !== "F2" || ev.repeat) return;
      if (isEditableTarget(ev.target) || isEditableTarget(document.activeElement)) return;
      ev.preventDefault();
      setDebugOpen((v) => !v);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Sync terrain from authoritative seed, then apply depletion patches
  useEffect(() => {
    const map = state?.map;
    const seed = state?.terrainSeed;
    if (!map || seed == null) {
      if (state?.phase === "need_init") setTerrain(null);
      return;
    }
    setTerrain((prev) => {
      const base = applyTerrainSeed(map, seed, prev);
      return syncTerrainResources(base, state.resourceTerrain);
    });
  }, [state?.map, state?.terrainSeed, state?.phase, state?.resourceTerrain]);

  const windowHudSize = Math.max(viewport.w, viewport.h) / 16;

  const onBuild = useCallback(
    (args: { buildingId: string; gx: number; gy: number; ground: GroundContext }) => {
      log.info("app", "onBuild", args);
      const ok = send({
        type: "build",
        buildingId: args.buildingId,
        gx: args.gx,
        gy: args.gy,
        ground: args.ground,
      });
      if (!ok) log.error("app", "build send returned false", args);
    },
    [send],
  );

  const onBuildLiaison = useCallback(
    (args: { kind: LiaisonKind; nodes: GridNode[] }) => {
      log.info("app", "onBuildLiaison", args.kind, args.nodes.length);
      const ok = send({
        type: "build_liaison",
        kind: args.kind,
        nodes: args.nodes,
      });
      if (!ok) log.error("app", "build_liaison send returned false", args);
    },
    [send],
  );

  const onDemolishLiaison = useCallback(
    (id: string) => {
      log.info("app", "demolish_liaison", id);
      const ok = send({ type: "demolish_liaison", id });
      if (!ok) log.error("app", "demolish_liaison send returned false", id);
    },
    [send],
  );

  const onDemolish = useCallback(
    (id: string) => {
      log.info("app", "demolish", id);
      const ok = send({ type: "demolish", id });
      if (!ok) log.error("app", "demolish send returned false", id);
    },
    [send],
  );

  const onRepair = useCallback(
    (id: string) => {
      log.info("app", "repair", id);
      const ok = send({ type: "repair", id });
      if (!ok) log.error("app", "repair send returned false", id);
    },
    [send],
  );

  const onLevelUpgrade = useCallback(
    (id: string) => {
      log.info("app", "level_upgrade", id);
      const ok = send({ type: "level_upgrade", id });
      if (!ok) log.error("app", "level_upgrade send returned false", id);
    },
    [send],
  );

  const onRelocateCapital = useCallback(
    (id: string) => {
      log.info("app", "relocate_capital", id);
      const ok = send({ type: "relocate_capital", id });
      if (!ok) log.error("app", "relocate_capital send returned false", id);
    },
    [send],
  );

  const onReload = useCallback(
    (id: string, count: number) => {
      log.info("app", "reload", id, count);
      const ok = send({ type: "reload", id, count });
      if (!ok) log.error("app", "reload send returned false", id, count);
    },
    [send],
  );

  const onBuildCarrier = useCallback(
    (id: string) => {
      log.info("app", "build_carrier", id);
      const ok = send({ type: "build_carrier", id });
      if (!ok) log.error("app", "build_carrier send returned false", id);
    },
    [send],
  );

  const onEmbarkAir = useCallback(
    (carrierId: string, airUnitId: string, u?: number) => {
      log.info("app", "embark_air", carrierId, airUnitId, u);
      const ok = send({ type: "embark_air", carrierId, airUnitId, u });
      if (!ok) log.error("app", "embark_air send returned false");
    },
    [send],
  );

  const onDisembarkAir = useCallback(
    (carrierId: string, u?: number) => {
      log.info("app", "disembark_air", carrierId, u);
      const ok = send({ type: "disembark_air", carrierId, u });
      if (!ok) log.error("app", "disembark_air send returned false");
    },
    [send],
  );

  const onDeploy = useCallback(
    (id: string, count: number) => {
      log.info("app", "deploy", id, count);
      const ok = send({ type: "deploy", id, count });
      if (!ok) log.error("app", "deploy send returned false", id, count);
    },
    [send],
  );

  const onTrain = useCallback(
    (args: {
      id: string;
      kind: "infantry" | "armor" | "navy" | "air";
      u: number;
      targetIds: string[];
    }) => {
      log.info("app", "train", args);
      const ok = send({ type: "train", ...args });
      if (!ok) log.error("app", "train send returned false", args);
    },
    [send],
  );

  const onFire = useCallback(
    (id: string, target: { targetId?: string; targetUnitId?: string }) => {
      log.info("app", "fire", id, target);
      const ok = send({ type: "fire", id, ...target });
      if (!ok) log.error("app", "fire send returned false", id, target);
    },
    [send],
  );

  const onMoveUnits = useCallback(
    (args: {
      gx: number;
      gy: number;
      sources?: Array<{ buildingId: string; u: number }>;
      unitIds?: string[];
    }) => {
      log.info("app", "move_units", args);
      send({ type: "move_units", ...args });
    },
    [send],
  );

  const onAssignHome = useCallback(
    (args: { buildingId: string; unitIds: string[] }) => {
      log.info("app", "assign_home", args);
      send({ type: "assign_home", ...args });
    },
    [send],
  );

  const onStopUnits = useCallback(
    (unitIds: string[], retreat?: boolean) => {
      log.info("app", "stop_units", unitIds, retreat ? "retreat" : "stop");
      send({ type: "stop_units", unitIds, retreat: retreat || undefined });
    },
    [send],
  );

  const onBlockadeUnits = useCallback(
    (args: {
      gx: number;
      gy: number;
      sources?: Array<{ buildingId: string; u: number }>;
      unitIds?: string[];
    }) => {
      log.info("app", "blockade_units", args);
      send({ type: "blockade_units", ...args });
    },
    [send],
  );

  const onEndBlockade = useCallback(
    (unitIds: string[]) => {
      log.info("app", "end_blockade", unitIds);
      send({ type: "end_blockade", unitIds });
    },
    [send],
  );

  const onAttackUnits = useCallback(
    (args: {
      sources?: Array<{ buildingId: string; u: number }>;
      unitIds?: string[];
      targetUnitId?: string;
      targetBuildingId?: string;
      targetLiaisonId?: string;
      liaisonAx?: number;
      liaisonAy?: number;
      liaisonBx?: number;
      liaisonBy?: number;
    }) => {
      log.info("app", "attack_units", args);
      send({ type: "attack_units", ...args });
    },
    [send],
  );

  const onHoldUnits = useCallback(
    (args: {
      holdBuildingId: string;
      sources?: Array<{ buildingId: string; u: number }>;
      unitIds?: string[];
    }) => {
      log.info("app", "hold_units", args);
      send({ type: "hold_units", ...args });
    },
    [send],
  );

  const onEndHold = useCallback(
    (unitIds: string[]) => {
      log.info("app", "end_hold", unitIds);
      send({ type: "end_hold", unitIds });
    },
    [send],
  );

  const onMutualDefense = useCallback(
    (buildingId: string, partnerBuildingId: string) => {
      log.info("app", "mutual_defense", buildingId, partnerBuildingId);
      send({ type: "mutual_defense", buildingId, partnerBuildingId });
    },
    [send],
  );

  const onEndMutualDefense = useCallback(
    (buildingId: string) => {
      log.info("app", "end_mutual_defense", buildingId);
      send({ type: "end_mutual_defense", buildingId });
    },
    [send],
  );

  const onSupplyUnits = useCallback(
    (args: {
      supplyBuildingId: string;
      gx: number;
      gy: number;
      sources?: Array<{ buildingId: string; u: number }>;
      unitIds?: string[];
    }) => {
      log.info("app", "supply_units", args);
      send({ type: "supply_units", ...args });
    },
    [send],
  );

  const onPlaceCapital = useCallback(
    (gx: number, gy: number) => {
      if (!terrain) {
        log.warn("app", "place capital without terrain");
        const msg = "请先初始化";
        pushError(msg, msg);
        logLocalReject({
          action: "place_capital",
          summary: `定都 (${gx}, ${gy})`,
          reason: msg,
          playerId,
        });
        return;
      }
      const reason = capitalSiteRejectReason(terrain, gx, gy);
      if (reason) {
        const msg = capitalSiteRejectMessage(reason);
        log.warn("app", "invalid capital site", reason, msg);
        pushError(msg, msg);
        logLocalReject({
          action: "place_capital",
          summary: `定都 (${gx}, ${gy})`,
          reason: msg,
          playerId,
        });
        return;
      }
      const tooClose = capitalExclusionRejectReason(
        gx,
        gy,
        state?.buildings ?? [],
        playerId,
      );
      if (tooClose) {
        const msg = capitalSiteRejectMessage(tooClose);
        log.warn("app", "capital too close", msg);
        pushError(msg, msg);
        logLocalReject({
          action: "place_capital",
          summary: `定都 (${gx}, ${gy})`,
          reason: msg,
          playerId,
        });
        return;
      }
      log.info("app", "place_capital", { gx, gy });
      send({ type: "place_capital", gx, gy });
    },
    [send, terrain, state?.buildings, playerId, pushError],
  );

  const buildingCount = state?.buildings?.length ?? 0;
  const liaisonCount = state?.liaisons?.length ?? 0;
  const phase = state?.phase ?? "need_init";
  const role = state?.role ?? "player";

  const foreignCapital =
    phase === "pick_capital" &&
    (state?.buildings ?? []).some(
      (b) => b.buildingId === "capital" && b.ownerId !== playerId,
    );
  const phaseHint =
    phase === "need_init"
      ? "等待房间地图…"
      : phase === "pick_capital"
        ? foreignCapital
          ? "请选择首都位置（红圈内不能设都）"
          : "请选择首都位置"
        : phase === "spectating"
          ? "观战中（不可操作）"
          : phase === "ended"
            ? state?.winnerNames && state.winnerNames.length > 1
              ? `对局结束 · ${state.winnerNames.join("、")} 队伍获胜`
              : state?.winnerName
                ? `对局结束 · ${state.winnerName} 获胜`
                : "对局结束"
            : null;

  const statusLine =
    (status === "connected" ? `tick ${state?.tick ?? 0}` : status) +
    ` · ${phase}` +
    ` · 建筑 ${buildingCount}` +
    ` · 线 ${liaisonCount}` +
    ` · 通 ${state?.connectedBuildingIds?.length ?? 0}` +
    (terrain ? ` · seed ${terrain.seed}` : "");

  const dismissToast = useCallback(() => {
    setToastMessage(null);
    clearError();
    clearTip();
  }, [clearError, clearTip]);

  const onSendChat = useCallback(
    (text: string) => {
      const ok = send({ type: "chat", text });
      if (!ok) log.error("app", "chat send returned false");
    },
    [send],
  );

  return (
    <div className="app">
      <GameCanvas
        map={state?.map ?? null}
        terrain={terrain}
        buildings={state?.buildings ?? []}
        liaisons={state?.liaisons ?? []}
        resourceSight={state?.resourceSight ?? []}
        connectedBuildingIds={state?.connectedBuildingIds ?? []}
        pollutionZones={state?.pollutionZones ?? []}
        units={state?.units ?? []}
        width={viewport.w}
        height={viewport.h}
        phase={phase}
        myPlayerId={playerId}
        teams={state?.teams ?? null}
        teamMode={!!state?.teamMode}
        allyGarrisonRequests={state?.allyGarrisonRequests ?? []}
        onAllyGarrisonRequest={(unitId, buildingId) =>
          send({ type: "ally_garrison_request", unitId, buildingId })
        }
        onAllyGarrisonAccept={(requestId) =>
          send({ type: "ally_garrison_accept", requestId })
        }
        onAllyGarrisonReject={(requestId) =>
          send({ type: "ally_garrison_reject", requestId })
        }
        onBuild={onBuild}
        onBuildLiaison={onBuildLiaison}
        onDemolishLiaison={onDemolishLiaison}
        onDemolish={onDemolish}
        onRepair={onRepair}
        onLevelUpgrade={onLevelUpgrade}
        onRelocateCapital={onRelocateCapital}
        onReload={onReload}
        onBuildCarrier={onBuildCarrier}
        onEmbarkAir={onEmbarkAir}
        onDisembarkAir={onDisembarkAir}
        onDeploy={onDeploy}
        onTrain={onTrain}
        onFire={onFire}
        onPlaceCapital={onPlaceCapital}
        onMoveUnits={onMoveUnits}
        onAssignHome={onAssignHome}
        onStopUnits={onStopUnits}
        onBlockadeUnits={onBlockadeUnits}
        onEndBlockade={onEndBlockade}
        onSupplyUnits={onSupplyUnits}
        onAttackUnits={onAttackUnits}
        onHoldUnits={onHoldUnits}
        onEndHold={onEndHold}
        onMutualDefense={onMutualDefense}
        onEndMutualDefense={onEndMutualDefense}
        // Affordance only — balances come from server state.you, never local math.
        energy={state?.you.energy ?? 0}
        organization={state?.you.organization ?? 0}
        tick={state?.tick ?? 0}
        playerNames={state?.players ?? []}
        showEnemyVision={showEnemyVision}
        showCommStatus={showCommStatus}
        chatMessages={chatMessages}
        onSendChat={onSendChat}
      />
      {state && (
        <HudOverlay
          hud={state.you}
          windowHudSize={windowHudSize}
          belowRing={
            <TeamPanelButton
              visible={
                phase === "pick_capital" &&
                (state.players?.length ?? 0) >= 3 &&
                !!playerId
              }
              onClick={() => setTeamPanelOpen(true)}
            />
          }
        />
      )}
      {playerId && state ? (
        <TeamPanel
          open={teamPanelOpen}
          onClose={() => setTeamPanelOpen(false)}
          myPlayerId={playerId}
          players={state.players ?? []}
          teams={state.teams ?? {}}
          invites={state.teamInvites ?? []}
          frozen={(state.buildings ?? []).some(
            (b) => b.buildingId === "capital" && b.hp > 0,
          )}
          onInvite={(id) => send({ type: "team_invite", toPlayerId: id })}
          onAccept={(id) => send({ type: "team_invite_accept", fromPlayerId: id })}
          onReject={(id) => send({ type: "team_invite_reject", fromPlayerId: id })}
          onLeave={() => send({ type: "team_leave" })}
        />
      ) : null}
      <ErrorToast
        message={toastMessage}
        toastKey={toastKey}
        variant={toastVariant}
        onDismiss={dismissToast}
      />
      <DebugOverlay
        open={debugOpen}
        status={status}
        statusLine={statusLine}
        phaseHint={phaseHint}
        errors={errorLog}
      />
      <button
        type="button"
        className="return-menu-btn return-menu-btn--top"
        title="返回主页"
        aria-label="返回主页"
        onClick={onReturnToMenu}
      >
        返回
      </button>
      <div className="corner-tools">
        <div className="corner-tools-col">
          <button
            type="button"
            className={`comm-status-btn${showCommStatus ? " is-on" : ""}`}
            title="显示我方通信状态"
            aria-label="显示我方通信状态"
            aria-pressed={showCommStatus}
            onClick={() => setShowCommStatus((v) => !v)}
          >
            <img src="/ui/advanced_view/comm.png" alt="" draggable={false} />
          </button>
          <button
            type="button"
            className={`enemy-vision-btn${showEnemyVision ? " is-on" : ""}`}
            title="显示已知对手视野范围"
            aria-label="显示已知对手视野范围"
            aria-pressed={showEnemyVision}
            onClick={() => setShowEnemyVision((v) => !v)}
          >
            <img src="/ui/advanced_view/view.png" alt="" draggable={false} />
          </button>
        </div>
        <div className="corner-tools-col">
          {phaseHint && (
            <div className="status-chip" data-status="connecting">
              {phaseHint}
              {role === "spectator" ? " · 观战" : ""}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
