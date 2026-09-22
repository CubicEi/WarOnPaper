import { useSyncExternalStore } from "react";
import {
  PlayerActionLog,
  categoryForAction,
  shouldLogClientAction,
  summarizeClientAction,
  type ClientToServer,
  type PlayerActionCategory,
  type PlayerActionLogEntry,
  type PlayerActionResultMsg,
  type PlayerActionStatus,
} from "@wop/shared";

export const playerActionLog = new PlayerActionLog(200);

export function usePlayerActionLog(): readonly PlayerActionLogEntry[] {
  return useSyncExternalStore(
    playerActionLog.subscribe,
    playerActionLog.getSnapshot,
    playerActionLog.getSnapshot,
  );
}

export function logOutgoingAction(
  msg: ClientToServer,
  playerId: string | null,
  sent: boolean,
): void {
  if (!shouldLogClientAction(msg.type)) return;
  const s = summarizeClientAction(msg);
  playerActionLog.push({
    playerId,
    source: "client",
    category: s.category,
    action: msg.type,
    summary: s.summary,
    ok: sent ? "pending" : "fail",
    reason: sent ? undefined : "连接未就绪，发送失败",
    detail: s.detail,
  });
}

export function applyServerActionResult(msg: PlayerActionResultMsg): void {
  const patch = {
    ok: (msg.ok ? "ok" : "fail") as PlayerActionStatus,
    reason: msg.reason,
    tick: msg.tick,
    playerId: msg.playerId,
    summary: msg.summary,
    detail: msg.detail,
    source: "server" as const,
    category: msg.category,
  };
  const done = playerActionLog.completePending(msg.action, patch);
  if (!done) {
    playerActionLog.push({
      ...patch,
      action: msg.action,
      category: msg.category,
      summary: msg.summary,
    });
  }
}

export function logLocalReject(args: {
  action: string;
  summary: string;
  reason: string;
  category?: PlayerActionCategory;
  detail?: string;
  playerId?: string | null;
}): PlayerActionLogEntry {
  return playerActionLog.push({
    playerId: args.playerId ?? null,
    source: "client",
    category: args.category ?? categoryForAction(args.action),
    action: args.action,
    summary: args.summary,
    ok: "fail",
    reason: args.reason,
    detail: args.detail,
  });
}
