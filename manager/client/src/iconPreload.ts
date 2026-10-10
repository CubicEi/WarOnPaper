/** Cache Storage name for core/assets icon + UI PNGs. */
export const ICON_CACHE_NAME = "wop-core-assets-icons-v1";

export type IconPreloadProgress = {
  completed: number;
  total: number;
  /** True when every URL was already in Cache Storage (no download UI). */
  skipped: boolean;
};

const FETCH_CONCURRENCY = 8;

function toRequestUrl(path: string): string {
  // Absolute same-origin URL so Cache keys stay stable across navigations.
  return new URL(path, window.location.origin).href;
}

async function putOne(
  cache: Cache,
  url: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  const existing = await cache.match(url);
  if (existing) return;
  const res = await fetch(url, {
    signal,
    credentials: "same-origin",
    cache: "force-cache",
  });
  if (!res.ok) {
    throw new Error(`icon preload failed: ${url} (${res.status})`);
  }
  await cache.put(url, res.clone());
}

/**
 * Ensure every icon URL is present in Cache Storage.
 * If all are already cached, resolves immediately with `skipped: true`
 * without implying a visible download.
 */
export async function preloadIconAssets(
  paths: readonly string[],
  onProgress?: (p: IconPreloadProgress) => void,
  signal?: AbortSignal,
): Promise<IconPreloadProgress> {
  const urls = paths.map(toRequestUrl);
  const total = urls.length;

  if (total === 0) {
    const done: IconPreloadProgress = {
      completed: 0,
      total: 0,
      skipped: true,
    };
    onProgress?.(done);
    return done;
  }

  if (typeof caches === "undefined") {
    // No Cache API — still warm the HTTP cache via fetch; never "skip".
    let completed = 0;
    onProgress?.({ completed: 0, total, skipped: false });
    await runPool(urls, FETCH_CONCURRENCY, async (url) => {
      if (signal?.aborted) return;
      try {
        await fetch(url, {
          signal,
          credentials: "same-origin",
          cache: "force-cache",
        });
      } catch {
        /* best-effort */
      }
      completed += 1;
      onProgress?.({ completed, total, skipped: false });
    });
    const done: IconPreloadProgress = {
      completed: total,
      total,
      skipped: false,
    };
    onProgress?.(done);
    return done;
  }

  const cache = await caches.open(ICON_CACHE_NAME);
  if (signal?.aborted) {
    return { completed: 0, total, skipped: false };
  }

  const missing: string[] = [];
  for (const url of urls) {
    if (!(await cache.match(url))) missing.push(url);
  }

  if (missing.length === 0) {
    const done: IconPreloadProgress = {
      completed: total,
      total,
      skipped: true,
    };
    onProgress?.(done);
    return done;
  }

  let completed = total - missing.length;
  onProgress?.({ completed, total, skipped: false });

  await runPool(missing, FETCH_CONCURRENCY, async (url) => {
    if (signal?.aborted) return;
    try {
      await putOne(cache, url, signal);
    } catch {
      /* best-effort: still advance so the UI can unblock */
    }
    completed += 1;
    onProgress?.({ completed, total, skipped: false });
  });

  const done: IconPreloadProgress = {
    completed: total,
    total,
    skipped: false,
  };
  onProgress?.(done);
  return done;
}

async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        await worker(items[i]!);
      }
    },
  );
  await Promise.all(runners);
}
