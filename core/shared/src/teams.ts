/**
 * Team roster helpers for matchmaking and ally treatment.
 * Ownership / ops stay `ownerId === session.id`; vision/comm/combat use sameTeam.
 */

export type TeamFormat =
  | "2v2"
  | "3v3"
  | "4v4"
  | "2v2v2"
  | "3v3v3"
  | "2v2v2v2";

/** playerId → teamId */
export type TeamRoster = Record<string, string>;

export const TEAM_FORMATS: readonly TeamFormat[] = [
  "2v2",
  "3v3",
  "4v4",
  "2v2v2",
  "3v3v3",
  "2v2v2v2",
] as const;

const FORMAT_SIZES: Record<TeamFormat, readonly number[]> = {
  "2v2": [2, 2],
  "3v3": [3, 3],
  "4v4": [4, 4],
  "2v2v2": [2, 2, 2],
  "3v3v3": [3, 3, 3],
  "2v2v2v2": [2, 2, 2, 2],
};

export function isTeamFormat(v: unknown): v is TeamFormat {
  return typeof v === "string" && (TEAM_FORMATS as readonly string[]).includes(v);
}

export function formatTeamSizes(format: TeamFormat): readonly number[] {
  return FORMAT_SIZES[format];
}

export function formatSeatCount(format: TeamFormat): number {
  return FORMAT_SIZES[format].reduce((a, b) => a + b, 0);
}

/** Effective team id: roster entry, else solo (playerId). */
export function teamIdOf(
  teams: TeamRoster | null | undefined,
  playerId: string,
): string {
  const tid = teams?.[playerId];
  return tid && tid.length > 0 ? tid : playerId;
}

export function sameTeam(
  teams: TeamRoster | null | undefined,
  a: string,
  b: string,
): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (!teams) return false;
  const ta = teams[a];
  const tb = teams[b];
  return !!ta && !!tb && ta === tb;
}

/** Self or teammate. */
export function isFriendly(
  teams: TeamRoster | null | undefined,
  a: string,
  b: string,
): boolean {
  return a === b || sameTeam(teams, a, b);
}

export function alliesOf(
  teams: TeamRoster | null | undefined,
  playerId: string,
): string[] {
  if (!teams) return [playerId];
  const tid = teams[playerId];
  if (!tid) return [playerId];
  return Object.keys(teams).filter((id) => teams[id] === tid);
}

export function teamMemberSet(
  teams: TeamRoster | null | undefined,
  playerId: string,
): ReadonlySet<string> {
  return new Set(alliesOf(teams, playerId));
}

/** True when any team has 2+ members. */
export function hasMultiPlayerTeam(teams: TeamRoster | null | undefined): boolean {
  if (!teams) return false;
  const counts = new Map<string, number>();
  for (const tid of Object.values(teams)) {
    if (!tid) continue;
    counts.set(tid, (counts.get(tid) ?? 0) + 1);
  }
  for (const n of counts.values()) {
    if (n >= 2) return true;
  }
  return false;
}

/**
 * Shuffle player ids and slice into format team sizes.
 * Team ids are `t0`, `t1`, …
 */
export function assignRandomTeams(
  playerIds: readonly string[],
  format: TeamFormat,
): TeamRoster {
  const sizes = formatTeamSizes(format);
  const need = formatSeatCount(format);
  if (playerIds.length !== need) {
    throw new Error(
      `assignRandomTeams: need ${need} players for ${format}, got ${playerIds.length}`,
    );
  }
  const shuffled = [...playerIds];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = shuffled[i]!;
    shuffled[i] = shuffled[j]!;
    shuffled[j] = tmp;
  }
  const out: TeamRoster = {};
  let offset = 0;
  for (let ti = 0; ti < sizes.length; ti++) {
    const size = sizes[ti]!;
    const tid = `t${ti}`;
    for (let k = 0; k < size; k++) {
      out[shuffled[offset + k]!] = tid;
    }
    offset += size;
  }
  return out;
}

export interface AllyGarrisonRequest {
  id: string;
  fromPlayerId: string;
  unitId: string;
  buildingId: string;
  /** Unit kind for UI. */
  unitKind: string;
  /** Unit U for UI. */
  unitU: number;
  createdAt: number;
}

export interface TeamInvitePending {
  fromPlayerId: string;
  toPlayerId: string;
}
