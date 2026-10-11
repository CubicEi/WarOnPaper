/**
 * Rocket-force staged research unlock (missile → advenced_missile → nuke_missile).
 * Timed attempts: durationSec = energyCost / ROCKET_RESEARCH_DURATION_E_PER_SEC.
 * RNG is rolled by the server; helpers here stay pure.
 */

import { durationSecToTicks } from "../time.js";
import type { TerrainMap } from "../terrain/types.js";
import type { PlacedBuilding } from "./actions.js";
import { nukeUraniumInfraRejectReason } from "./economy.js";
import type { RocketForceBuildingId } from "../units/antiAir.js";

/** Same ids as rocket-force weapons (typo `advenced_missile` kept). */
export const ROCKET_RESEARCH_IDS = [
  "missile",
  "advenced_missile",
  "nuke_missile",
] as const;

export type RocketResearchId = (typeof ROCKET_RESEARCH_IDS)[number];

/** Energy spent per second of research wall-clock time (duration = energyCost / 50). */
export const ROCKET_RESEARCH_DURATION_E_PER_SEC = 50;

/** Mid-research nuke uranium infra re-check interval (wall-clock seconds). */
export const NUKE_RESEARCH_INFRA_CHECK_INTERVAL_SEC = 5;

/** Tick cadence for nuke uranium infra re-checks (`durationSecToTicks(5)`). */
export const NUKE_RESEARCH_INFRA_CHECK_INTERVAL_TICKS = durationSecToTicks(
  NUKE_RESEARCH_INFRA_CHECK_INTERVAL_SEC,
);

export interface RocketResearchStage {
  energy: number;
  organization: number;
  /** Success chance as percent 0–100. */
  chancePercent: number;
}

/** Per-building progress. `stage` is 0-based index of the next attempt. */
export interface RocketResearchEntry {
  stage: number;
  unlocked: boolean;
}

/** In-progress timed attempt (at most one per player). */
export interface ActiveRocketResearch {
  buildingId: RocketResearchId;
  /** Absolute simulation tick when the attempt resolves. */
  endsAtTick: number;
  /** 0-based stage index being researched. */
  stage: number;
}

export type RocketResearchProgressMap = Partial<
  Record<RocketResearchId, RocketResearchEntry>
>;

const ROCKET_RESEARCH_SET = new Set<string>(ROCKET_RESEARCH_IDS);

/** Stage tables (1-based rows in the balance plan → 0-based arrays). */
export const ROCKET_RESEARCH_STAGES: Record<
  RocketResearchId,
  readonly RocketResearchStage[]
> = {
  missile: [
    { energy: 200, organization: 5, chancePercent: 30 },
    { energy: 400, organization: 5, chancePercent: 50 },
    { energy: 800, organization: 5, chancePercent: 80 },
    { energy: 1600, organization: 10, chancePercent: 100 },
  ],
  advenced_missile: [
    { energy: 600, organization: 10, chancePercent: 20 },
    { energy: 1200, organization: 10, chancePercent: 40 },
    { energy: 2400, organization: 10, chancePercent: 60 },
    { energy: 4800, organization: 10, chancePercent: 80 },
    { energy: 9600, organization: 20, chancePercent: 100 },
  ],
  nuke_missile: [
    { energy: 3000, organization: 20, chancePercent: 10 },
    { energy: 6000, organization: 20, chancePercent: 30 },
    { energy: 12000, organization: 20, chancePercent: 50 },
    { energy: 24000, organization: 20, chancePercent: 75 },
    { energy: 48000, organization: 40, chancePercent: 100 },
  ],
};

/** Research unlock dependency: advanced needs missile; nuke needs advanced. */
export const ROCKET_RESEARCH_PREREQ: Record<
  RocketResearchId,
  RocketResearchId | null
> = {
  missile: null,
  advenced_missile: "missile",
  nuke_missile: "advenced_missile",
};

export function isRocketResearchTarget(
  buildingId: string | null | undefined,
): buildingId is RocketResearchId {
  return !!buildingId && ROCKET_RESEARCH_SET.has(buildingId);
}

/** Alias: rocket research targets ≡ rocket-force building ids. */
export function isRocketResearchId(
  buildingId: string | null | undefined,
): buildingId is RocketResearchId {
  return isRocketResearchTarget(buildingId);
}

export function emptyRocketResearchEntry(): RocketResearchEntry {
  return { stage: 0, unlocked: false };
}

export function emptyRocketResearchProgress(): RocketResearchProgressMap {
  return {};
}

export function getRocketResearchEntry(
  progress: RocketResearchProgressMap | null | undefined,
  buildingId: RocketResearchId,
): RocketResearchEntry {
  const e = progress?.[buildingId];
  if (!e) return emptyRocketResearchEntry();
  return {
    stage: Math.max(0, Math.floor(e.stage)),
    unlocked: !!e.unlocked,
  };
}

export function isRocketResearchUnlocked(
  progress: RocketResearchProgressMap | null | undefined,
  buildingId: RocketResearchId,
): boolean {
  return getRocketResearchEntry(progress, buildingId).unlocked;
}

export function getRocketResearchStages(
  buildingId: RocketResearchId,
): readonly RocketResearchStage[] {
  return ROCKET_RESEARCH_STAGES[buildingId];
}

/**
 * Cost/chance for the next attempt (`entry.stage` 0-based).
 * Returns null when unlocked or stage is past the table.
 */
export function getNextRocketResearchStage(
  buildingId: RocketResearchId,
  entry: Pick<RocketResearchEntry, "stage" | "unlocked">,
): RocketResearchStage | null {
  if (entry.unlocked) return null;
  const stages = ROCKET_RESEARCH_STAGES[buildingId];
  const i = Math.max(0, Math.floor(entry.stage));
  return stages[i] ?? null;
}

export function rocketResearchDurationSec(energyCost: number): number {
  if (energyCost <= 0) return 0;
  return energyCost / ROCKET_RESEARCH_DURATION_E_PER_SEC;
}

export function rocketResearchDurationTicks(energyCost: number): number {
  return durationSecToTicks(rocketResearchDurationSec(energyCost));
}

export type RocketResearchRejectReason =
  | "unknown_target"
  | "already_unlocked"
  | "prereq_locked"
  | "busy"
  | "no_stage"
  | "not_enough_energy"
  | "not_enough_org"
  | "nuke_uranium_infra";

export interface RocketResearchCheckOk {
  ok: true;
  buildingId: RocketResearchId;
  stageIndex: number;
  stage: RocketResearchStage;
  durationTicks: number;
}

export interface RocketResearchCheckFail {
  ok: false;
  reason: RocketResearchRejectReason;
  message: string;
}

export type RocketResearchCheckResult =
  | RocketResearchCheckOk
  | RocketResearchCheckFail;

const RESEARCH_NAME: Record<RocketResearchId, string> = {
  missile: "导弹",
  advenced_missile: "远程导弹",
  nuke_missile: "核导弹",
};

export function rocketResearchDisplayName(buildingId: RocketResearchId): string {
  return RESEARCH_NAME[buildingId];
}

/**
 * Whether the player may start a research attempt (pure; no side effects).
 * Does not require owning a gun / prereq building — that is a build-chain concern.
 * Nuke research additionally requires working, comms-linked uranium miner + factory
 * (same gate spirit as nuke reload); pass world args for that check.
 */
export function canStartRocketResearch(args: {
  buildingId: string;
  progress: RocketResearchProgressMap | null | undefined;
  activeResearch: ActiveRocketResearch | null | undefined;
  energy: number;
  organization: number;
  /** Required for `nuke_missile` uranium infra gate. */
  buildings?: readonly PlacedBuilding[];
  ownerId?: string;
  terrain?: TerrainMap | null;
  connectedIds?: ReadonlySet<string> | readonly string[] | null;
}): RocketResearchCheckResult {
  const { buildingId, progress, activeResearch, energy, organization } = args;
  if (!isRocketResearchTarget(buildingId)) {
    return {
      ok: false,
      reason: "unknown_target",
      message: "未知研究目标",
    };
  }
  if (activeResearch) {
    return {
      ok: false,
      reason: "busy",
      message: "已有研究进行中",
    };
  }
  const entry = getRocketResearchEntry(progress, buildingId);
  if (entry.unlocked) {
    return {
      ok: false,
      reason: "already_unlocked",
      message: `${RESEARCH_NAME[buildingId]}已解锁`,
    };
  }
  const prereq = ROCKET_RESEARCH_PREREQ[buildingId];
  if (prereq && !isRocketResearchUnlocked(progress, prereq)) {
    return {
      ok: false,
      reason: "prereq_locked",
      message: `须先解锁${RESEARCH_NAME[prereq]}`,
    };
  }
  if (buildingId === "nuke_missile") {
    const infraMsg = nukeUraniumInfraRejectReason(
      args.buildings ?? [],
      args.ownerId ?? "",
      args.terrain ?? null,
      args.connectedIds,
      "research",
    );
    if (infraMsg) {
      return {
        ok: false,
        reason: "nuke_uranium_infra",
        message: infraMsg,
      };
    }
  }
  const stage = getNextRocketResearchStage(buildingId, entry);
  if (!stage) {
    return {
      ok: false,
      reason: "no_stage",
      message: "无可用研究阶段",
    };
  }
  if (energy < stage.energy) {
    return {
      ok: false,
      reason: "not_enough_energy",
      message: `能源不足（需要 ${stage.energy} E）`,
    };
  }
  if (organization < stage.organization) {
    return {
      ok: false,
      reason: "not_enough_org",
      message: `组织度不足（需要 ${stage.organization} O）`,
    };
  }
  return {
    ok: true,
    buildingId,
    stageIndex: entry.stage,
    stage,
    durationTicks: rocketResearchDurationTicks(stage.energy),
  };
}

/** Pure success test: `roll01` in [0,1) from the caller's RNG. */
export function rollRocketResearchSuccess(
  chancePercent: number,
  roll01: number,
): boolean {
  const p = Math.max(0, Math.min(100, chancePercent)) / 100;
  return roll01 < p;
}

/**
 * Apply attempt outcome without RNG. Success unlocks; failure advances `stage`
 * by 1 but never past the last table row (re-attempt last stage).
 */
export function applyRocketResearchOutcome(
  buildingId: RocketResearchId,
  entry: RocketResearchEntry,
  success: boolean,
): RocketResearchEntry {
  if (entry.unlocked) return { ...entry, unlocked: true };
  if (success) return { stage: entry.stage, unlocked: true };
  const maxStage = Math.max(0, ROCKET_RESEARCH_STAGES[buildingId].length - 1);
  return {
    stage: Math.min(entry.stage + 1, maxStage),
    unlocked: false,
  };
}

/** Whether a rocket building may be built/upgraded (research unlocked). */
export function isRocketBuildUnlocked(
  progress: RocketResearchProgressMap | null | undefined,
  buildingId: string,
): boolean {
  if (!isRocketResearchTarget(buildingId)) return true;
  return isRocketResearchUnlocked(progress, buildingId);
}

/** Normalize wire/save payloads (old saves may omit fields). */
export function normalizeRocketResearchProgress(
  raw: unknown,
): RocketResearchProgressMap {
  const out: RocketResearchProgressMap = {};
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  for (const id of ROCKET_RESEARCH_IDS) {
    const v = obj[id];
    if (!v || typeof v !== "object") continue;
    const e = v as Record<string, unknown>;
    out[id] = {
      stage: Math.max(0, Math.floor(Number(e.stage) || 0)),
      unlocked: !!e.unlocked,
    };
  }
  return out;
}

export function normalizeActiveRocketResearch(
  raw: unknown,
): ActiveRocketResearch | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const buildingIdRaw = o.buildingId;
  if (typeof buildingIdRaw !== "string" || !isRocketResearchTarget(buildingIdRaw)) {
    return null;
  }
  const endsAtTick = Math.floor(Number(o.endsAtTick));
  const stage = Math.max(0, Math.floor(Number(o.stage) || 0));
  if (!Number.isFinite(endsAtTick)) return null;
  return { buildingId: buildingIdRaw, endsAtTick, stage };
}

/** Type-level assert research ids ⊆ rocket-force weapon ids. */
export type _RocketResearchIsForce = RocketResearchId extends RocketForceBuildingId
  ? true
  : never;
