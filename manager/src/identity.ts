import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { IDENTITY_DATA_PATH } from "./paths.js";

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 500;
const CLEAN_INTERVAL_MS = 60 * 60 * 1000;

export interface IdentityRecord {
  playerId: string;
  name: string;
  /** Unix ms when last disconnected (or last written while offline). Online → null. */
  lastSeenAt: number | null;
}

interface IdentityFile {
  version: 1;
  identities: IdentityRecord[];
}

function sanitizeName(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim().slice(0, 24);
  if (trimmed.length > 0) return trimmed;
  return `指挥官-${Math.floor(Math.random() * 9000 + 1000)}`;
}

function isUuid(value: string | undefined): value is string {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/**
 * UUID ↔ display name store with 7-day TTL from disconnect.
 * Persists JSON under manager/data/identities.json (relative path).
 */
export class IdentityStore {
  private readonly byId = new Map<string, IdentityRecord>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanTimer: ReturnType<typeof setInterval> | null = null;
  private readonly online = new Set<string>();

  async load(): Promise<void> {
    try {
      const raw = await readFile(IDENTITY_DATA_PATH, "utf8");
      const parsed = JSON.parse(raw) as IdentityFile;
      if (parsed?.version === 1 && Array.isArray(parsed.identities)) {
        for (const rec of parsed.identities) {
          if (!rec?.playerId || !rec?.name) continue;
          this.byId.set(rec.playerId, {
            playerId: rec.playerId,
            name: sanitizeName(rec.name),
            lastSeenAt:
              typeof rec.lastSeenAt === "number" ? rec.lastSeenAt : null,
          });
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.warn("[manager] identity load failed:", err);
      }
    }
    this.purgeExpired();
    this.scheduleClean();
  }

  start(): void {
    this.scheduleClean();
  }

  stop(): void {
    if (this.cleanTimer) clearInterval(this.cleanTimer);
    this.cleanTimer = null;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  /**
   * Resolve hello → authoritative playerId + name.
   * Reuses cached UUID when valid and not expired; otherwise allocates new.
   */
  hello(playerId: string | undefined, name: string | undefined): IdentityRecord {
    this.purgeExpired();
    const wantedName = sanitizeName(name);

    if (isUuid(playerId)) {
      const existing = this.byId.get(playerId);
      if (existing && !this.isExpired(existing)) {
        existing.name = wantedName;
        existing.lastSeenAt = null;
        this.online.add(playerId);
        this.queueSave();
        return { ...existing };
      }
    }

    const id = randomUUID();
    const rec: IdentityRecord = {
      playerId: id,
      name: wantedName,
      lastSeenAt: null,
    };
    this.byId.set(id, rec);
    this.online.add(id);
    this.queueSave();
    return { ...rec };
  }

  /** Mark disconnect — TTL clock starts now. */
  markDisconnected(playerId: string): void {
    const rec = this.byId.get(playerId);
    if (!rec) return;
    this.online.delete(playerId);
    rec.lastSeenAt = Date.now();
    this.queueSave();
  }

  getName(playerId: string): string | undefined {
    return this.byId.get(playerId)?.name;
  }

  private isExpired(rec: IdentityRecord): boolean {
    if (this.online.has(rec.playerId)) return false;
    if (rec.lastSeenAt == null) return false;
    return Date.now() - rec.lastSeenAt > TTL_MS;
  }

  private purgeExpired(): void {
    let changed = false;
    for (const [id, rec] of this.byId) {
      if (this.isExpired(rec)) {
        this.byId.delete(id);
        changed = true;
      }
    }
    if (changed) this.queueSave();
  }

  private scheduleClean(): void {
    if (this.cleanTimer) return;
    this.cleanTimer = setInterval(() => this.purgeExpired(), CLEAN_INTERVAL_MS);
    this.cleanTimer.unref?.();
  }

  private queueSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  async flush(): Promise<void> {
    const payload: IdentityFile = {
      version: 1,
      identities: [...this.byId.values()],
    };
    await mkdir(dirname(IDENTITY_DATA_PATH), { recursive: true });
    await writeFile(IDENTITY_DATA_PATH, JSON.stringify(payload, null, 2), "utf8");
  }
}
