/** Bounded player-action log for F2 debug (client store; server emits results). */

import { BUILDING_BY_ID } from "../buildings/catalog.js";
import { LIAISON_BY_ID, type LiaisonKind } from "../buildings/liaison.js";
import { UNIT_BY_KIND, type UnitKind } from "../units/catalog.js";

export type PlayerActionCategory =
  | "system"
  | "capital"
  | "build"
  | "liaison"
  | "building"
  | "unit"
  | "train"
  | "combat"
  | "chat"
  | "ui";

export type PlayerActionStatus = "pending" | "ok" | "fail";
export type PlayerActionSource = "client" | "server";

export const PLAYER_ACTION_CATEGORY_LABEL: Record<PlayerActionCategory, string> = {
  system: "系统",
  capital: "定都",
  build: "建造",
  liaison: "联络",
  building: "建筑",
  unit: "单位",
  train: "训练",
  combat: "战斗",
  chat: "聊天",
  ui: "界面",
};

export const PLAYER_ACTION_STATUS_LABEL: Record<PlayerActionStatus, string> = {
  pending: "发送中",
  ok: "成功",
  fail: "失败",
};

const SKIP_CLIENT_ACTIONS = new Set(["ping", "hello"]);

export function shouldLogClientAction(type: string): boolean {
  return !SKIP_CLIENT_ACTIONS.has(type);
}

export interface PlayerActionLogEntry {
  id: number;
  /** Wall-clock ms when the attempt was recorded. */
  t: number;
  tick: number | null;
  playerId: string | null;
  source: PlayerActionSource;
  category: PlayerActionCategory;
  action: string;
  summary: string;
  ok: PlayerActionStatus;
  reason?: string;
  detail?: string;
}

/** Authoritative apply/reject, sent only to the acting player. */
export type PlayerActionResultMsg = {
  type: "action_result";
  action: string;
  category: PlayerActionCategory;
  ok: boolean;
  tick: number;
  playerId: string;
  summary: string;
  reason?: string;
  detail?: string;
};

export interface PlayerActionLogPush {
  t?: number;
  tick?: number | null;
  playerId?: string | null;
  source?: PlayerActionSource;
  category: PlayerActionCategory;
  action: string;
  summary: string;
  ok: PlayerActionStatus;
  reason?: string;
  detail?: string;
}

const DEFAULT_CAPACITY = 200;

export class PlayerActionLog {
  private buf: PlayerActionLogEntry[] = [];
  private snapshot: readonly PlayerActionLogEntry[] = [];
  private nextId = 1;
  private readonly listeners = new Set<() => void>();

  constructor(readonly capacity = DEFAULT_CAPACITY) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Newest-first; stable reference until the log mutates. */
  getSnapshot = (): readonly PlayerActionLogEntry[] => this.snapshot;

  entries(): readonly PlayerActionLogEntry[] {
    return this.snapshot;
  }

  push(partial: PlayerActionLogPush): PlayerActionLogEntry {
    const entry: PlayerActionLogEntry = {
      id: this.nextId++,
      t: partial.t ?? Date.now(),
      tick: partial.tick ?? null,
      playerId: partial.playerId ?? null,
      source: partial.source ?? "client",
      category: partial.category,
      action: partial.action,
      summary: partial.summary,
      ok: partial.ok,
      reason: partial.reason,
      detail: partial.detail,
    };
    this.buf.push(entry);
    this.trim();
    this.emit();
    return entry;
  }

  /**
   * Resolve the newest pending row of this action (attempt + result on one line).
   * Returns null if nothing was pending (caller should `push` a new row).
   */
  completePending(
    action: string,
    patch: Partial<Omit<PlayerActionLogEntry, "id" | "t" | "action">>,
  ): PlayerActionLogEntry | null {
    for (let i = this.buf.length - 1; i >= 0; i--) {
      const cur = this.buf[i]!;
      if (cur.action !== action || cur.ok !== "pending") continue;
      const next: PlayerActionLogEntry = { ...cur, ...patch, action: cur.action, id: cur.id, t: cur.t };
      this.buf.splice(i, 1);
      this.buf.push(next);
      this.trim();
      this.emit();
      return next;
    }
    return null;
  }

  clear(): void {
    this.buf = [];
    this.emit();
  }

  private trim(): void {
    const extra = this.buf.length - this.capacity;
    if (extra > 0) this.buf.splice(0, extra);
  }

  private emit(): void {
    const newestFirst = this.buf.slice();
    newestFirst.reverse();
    this.snapshot = newestFirst;
    for (const fn of this.listeners) fn();
  }
}

type LooseMsg = { type: string } & Record<string, unknown>;

export function categoryForAction(type: string): PlayerActionCategory {
  switch (type) {
    case "init":
      return "system";
    case "place_capital":
      return "capital";
    case "build":
      return "build";
    case "build_liaison":
    case "demolish_liaison":
      return "liaison";
    case "demolish":
    case "repair":
    case "level_upgrade":
    case "reload":
    case "deploy":
    case "build_carrier":
      return "building";
    case "train":
      return "train";
    case "fire":
    case "attack_units":
    case "mutual_defense":
      return "combat";
    case "move_units":
    case "assign_home":
    case "stop_units":
    case "blockade_units":
    case "end_blockade":
    case "supply_units":
    case "hold_units":
    case "end_hold":
    case "embark_air":
    case "disembark_air":
      return "unit";
    case "chat":
      return "chat";
    default:
      return "ui";
  }
}

function buildingName(id: unknown): string {
  if (typeof id !== "string") return "?";
  return BUILDING_BY_ID[id]?.name ?? id;
}

function liaisonName(kind: unknown): string {
  if (kind === "fiber" || kind === "road" || kind === "railway") {
    return LIAISON_BY_ID[kind as LiaisonKind].name;
  }
  return typeof kind === "string" ? kind : "?";
}

function unitKindName(kind: unknown): string {
  if (kind === "infantry" || kind === "armor" || kind === "navy" || kind === "navy_carrier" || kind === "air") {
    return UNIT_BY_KIND[kind as UnitKind].name;
  }
  return typeof kind === "string" ? kind : "?";
}

function xy(gx: unknown, gy: unknown): string {
  return `(${fmtNum(gx)}, ${fmtNum(gy)})`;
}

function fmtNum(n: unknown): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "?";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function shortId(id: unknown): string {
  if (typeof id !== "string" || !id) return "?";
  return id.length > 8 ? id.slice(0, 8) : id;
}

function asCount(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

function sourceU(sources: unknown): number {
  if (!Array.isArray(sources)) return 0;
  let u = 0;
  for (const s of sources) {
    if (s && typeof s === "object" && "u" in s && typeof (s as { u: unknown }).u === "number") {
      u += (s as { u: number }).u;
    }
  }
  return u;
}

export function summarizeClientAction(msg: { readonly type: string }): {
  category: PlayerActionCategory;
  summary: string;
  detail?: string;
} {
  const m = msg as LooseMsg;
  const category = categoryForAction(m.type);
  const bits: string[] = [];
  let summary: string;

  switch (m.type) {
    case "init":
      summary = "初始化地图";
      if (m.mapSize) bits.push(`尺寸 ${String(m.mapSize)}`);
      if (m.seed != null && m.seed !== "") bits.push(`种子 ${String(m.seed)}`);
      break;
    case "place_capital":
      summary = `定都 ${xy(m.gx, m.gy)}`;
      break;
    case "build":
      summary = `建造 ${buildingName(m.buildingId)} ${xy(m.gx, m.gy)}`;
      if (m.ground) bits.push(`地形 ${String(m.ground)}`);
      break;
    case "build_liaison": {
      const n = asCount(m.nodes);
      summary = `铺设${liaisonName(m.kind)} · ${n} 节点`;
      break;
    }
    case "demolish_liaison":
      summary = `拆除联络线 ${shortId(m.id)}`;
      break;
    case "demolish":
      summary = `拆除建筑 ${shortId(m.id)}`;
      break;
    case "repair":
      summary = `修复建筑 ${shortId(m.id)}`;
      break;
    case "level_upgrade":
      summary = `线性升级 ${shortId(m.id)}`;
      break;
    case "reload":
      summary = `装填 ${shortId(m.id)} ×${fmtNum(m.count)}`;
      break;
    case "deploy":
      summary = `部署储能 ${shortId(m.id)} ×${fmtNum(m.count)}`;
      break;
    case "build_carrier":
      summary = `建造航母 ${shortId(m.id)}`;
      break;
    case "train":
      summary = `训练 ${unitKindName(m.kind)} U${fmtNum(m.u)}`;
      bits.push(`训练场 ${shortId(m.id)}`);
      if (Array.isArray(m.targetIds) && m.targetIds.length) {
        bits.push(`目标 ${m.targetIds.length} 座`);
      } else if (m.targetId) {
        bits.push(`目标 ${shortId(m.targetId)}`);
      }
      break;
    case "fire":
      summary = `建筑开火 ${shortId(m.id)} → ${shortId(m.targetId)}`;
      break;
    case "move_units":
      summary = `调动 → ${xy(m.gx, m.gy)}`;
      bits.push(unitOrderBits(m));
      break;
    case "assign_home":
      summary = `部署归属 ${shortId(m.buildingId)}`;
      bits.push(`单位 ${asCount(m.unitIds)}`);
      break;
    case "stop_units":
      summary = m.retreat ? "撤退" : "停止";
      bits.push(`单位 ${asCount(m.unitIds)}`);
      break;
    case "blockade_units":
      summary = `封锁 ${xy(m.gx, m.gy)}`;
      bits.push(unitOrderBits(m));
      break;
    case "end_blockade":
      summary = "结束封锁";
      bits.push(`单位 ${asCount(m.unitIds)}`);
      break;
    case "supply_units":
      summary = `补给 → ${xy(m.gx, m.gy)}`;
      bits.push(`站 ${shortId(m.supplyBuildingId)}`, unitOrderBits(m));
      break;
    case "attack_units":
      summary = m.targetLiaisonId
        ? `进攻联络线 ${shortId(m.targetLiaisonId)}`
        : m.targetBuildingId
          ? `进攻建筑 ${shortId(m.targetBuildingId)}`
          : `进攻单位 ${shortId(m.targetUnitId)}`;
      bits.push(unitOrderBits(m));
      break;
    case "hold_units":
      summary = `驻守 ${shortId(m.holdBuildingId)}`;
      bits.push(unitOrderBits(m));
      break;
    case "end_hold":
      summary = "结束驻守";
      bits.push(`单位 ${asCount(m.unitIds)}`);
      break;
    case "mutual_defense":
      summary = `互防 ${shortId(m.buildingId)} ↔ ${shortId(m.partnerBuildingId)}`;
      break;
    case "embark_air":
      summary = `空军上舰 ${shortId(m.airUnitId)} → ${shortId(m.carrierId)}`;
      if (m.u != null) bits.push(`U${fmtNum(m.u)}`);
      break;
    case "disembark_air":
      summary = `放飞舰载机 ${shortId(m.carrierId)}`;
      if (m.u != null) bits.push(`U${fmtNum(m.u)}`);
      break;
    case "chat":
      summary = `聊天：${String(m.text ?? "").slice(0, 40)}`;
      break;
    default:
      summary = `操作 ${m.type}`;
      bits.push(compactUnknown(m));
      break;
  }

  const detail = bits.filter(Boolean).join(" · ") || undefined;
  return { category, summary, detail };
}

function unitOrderBits(msg: LooseMsg): string {
  const parts: string[] = [];
  const srcN = asCount(msg.sources);
  const srcU = sourceU(msg.sources);
  const unitN = asCount(msg.unitIds);
  if (srcN) parts.push(`建筑组 ${srcN}${srcU ? ` U${srcU}` : ""}`);
  if (unitN) parts.push(`已派出 ${unitN}`);
  if (!srcN && !unitN) parts.push("未选部队");
  return parts.join(" · ");
}

function compactUnknown(msg: LooseMsg): string {
  try {
    const { type: _t, ...rest } = msg;
    const s = JSON.stringify(rest);
    if (!s || s === "{}") return "";
    return s.length > 180 ? `${s.slice(0, 177)}…` : s;
  } catch {
    return "";
  }
}

export function formatActionStamp(t: number, tick: number | null): string {
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return tick != null ? `${hh}:${mm}:${ss} t${tick}` : `${hh}:${mm}:${ss}`;
}

export function formatCostDelta(dE: number, dO: number): string | undefined {
  const parts: string[] = [];
  if (dE !== 0) parts.push(`${dE > 0 ? "+" : ""}${dE}E`);
  if (dO !== 0) parts.push(`${dO > 0 ? "+" : ""}${dO}O`);
  return parts.length ? parts.join(" ") : undefined;
}
