/** Client debug logger — filter DevTools by `[wop]`. */

type Level = "debug" | "info" | "warn" | "error";

const ENABLED =
  typeof window === "undefined" ||
  localStorage.getItem("wop:log") !== "0";

function emit(level: Level, scope: string, ...args: unknown[]): void {
  if (!ENABLED && level === "debug") return;
  const tag = `[wop:${scope}]`;
  const fn =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : level === "info"
          ? console.info
          : console.debug;
  fn(tag, ...args);
}

export const log = {
  debug: (scope: string, ...args: unknown[]) => emit("debug", scope, ...args),
  info: (scope: string, ...args: unknown[]) => emit("info", scope, ...args),
  warn: (scope: string, ...args: unknown[]) => emit("warn", scope, ...args),
  error: (scope: string, ...args: unknown[]) => emit("error", scope, ...args),
};
