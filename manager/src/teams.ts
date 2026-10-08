/** Mirror of core/shared teams helpers for lobby matchmaking. */

export type TeamFormat =
  | "2v2"
  | "3v3"
  | "4v4"
  | "2v2v2"
  | "3v3v3"
  | "2v2v2v2";

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
