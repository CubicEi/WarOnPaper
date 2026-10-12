/**
 * Single source of truth for simulation clock rate and seconds ↔ ticks.
 * All tick/second conversions elsewhere must use these exports.
 *
 * Changing only `TICK_HZ` must not change wall-clock game pacing for durations
 * expressed in seconds (build / train / move / combat / economy). Quantization
 * to whole ticks is inevitable at lower Hz.
 */

/** Server-authoritative broadcast / simulation rate (ticks per wall-clock second). */
export const TICK_HZ = 5;

/** Milliseconds per simulation tick. */
export const TICK_MS = 1000 / TICK_HZ;

/** Wall-clock seconds advanced per simulation tick (`TICK_MS / 1000`). */
export const DT_SEC_PER_TICK = TICK_MS / 1000;

/** Ticks in one wall-clock second (= `TICK_HZ`). */
export const TICKS_PER_SEC = TICK_HZ;

/** Ticks in `n` wall-clock seconds (derived from `TICK_HZ` only). */
export function ticksPerSeconds(sec: number): number {
  return TICK_HZ * sec;
}

/** Ticks in 10 wall-clock seconds. */
export const TICKS_PER_10S = ticksPerSeconds(10);

/** Ticks in 30 wall-clock seconds. */
export const TICKS_PER_30S = ticksPerSeconds(30);

/**
 * Convert a positive duration in seconds to ticks (round; at least 1).
 * `sec <= 0` → `0`.
 */
export function durationSecToTicks(sec: number): number {
  if (sec <= 0) return 0;
  return Math.max(1, Math.round(sec * TICK_HZ));
}

/**
 * Convert a positive duration in seconds to ticks (ceil; at least 1).
 * Used for cooldowns that must not undershoot wall time.
 * `sec <= 0` → `0`.
 */
export function durationSecToTicksCeil(sec: number): number {
  if (sec <= 0) return 0;
  return Math.max(1, Math.ceil(sec * TICK_HZ));
}

/** Convert tick count to wall-clock seconds. */
export function ticksToSec(ticks: number): number {
  return ticks / TICK_HZ;
}

/**
 * Comm diffusion wave restart interval in wall-clock seconds
 * (`TICK_HZ` ticks via `durationSecToTicks`).
 */
export const COMM_WAVE_INTERVAL_SEC = 1;

/** Ticks between full comm diffusion wave restarts (wall-clock via helpers). */
export const COMM_WAVE_INTERVAL_TICKS = durationSecToTicks(COMM_WAVE_INTERVAL_SEC);
