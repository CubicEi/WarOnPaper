import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute dir of this file's package root (`manager/`), resolved from compiled or source. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** `manager/` whether running from `src/` (tsx) or `dist/`. */
export const MANAGER_ROOT = join(HERE, "..");

/** Repo `core/` sibling of manager. */
export const CORE_ROOT = join(MANAGER_ROOT, "..", "core");

export const MANAGER_CLIENT_DIST = join(MANAGER_ROOT, "client", "dist");
export const CORE_CLIENT_DIST = join(CORE_ROOT, "client", "dist");
export const CORE_ASSETS = join(CORE_ROOT, "assets");
export const IDENTITY_DATA_PATH = join(MANAGER_ROOT, "data", "identities.json");

/** Optional GameRoom module once sibling lands it (no listen side effects). */
export const CORE_GAME_ROOM_MODULE = join(CORE_ROOT, "server", "dist", "room.js");
