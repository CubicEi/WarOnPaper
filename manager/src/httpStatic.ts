import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import {
  CORE_ASSETS,
  CORE_CLIENT_DIST,
  MANAGER_CLIENT_DIST,
} from "./paths.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

function safeJoin(root: string, reqPath: string): string | null {
  const decoded = decodeURIComponent(reqPath.split("?")[0] ?? "");
  const cleaned = decoded.replace(/^\/+/, "");
  const full = normalize(join(root, cleaned));
  const rootNorm = normalize(root + sep);
  if (full !== normalize(root) && !full.startsWith(rootNorm)) {
    return null;
  }
  return full;
}

function sendFile(res: ServerResponse, filePath: string): void {
  const ext = extname(filePath).toLowerCase();
  res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
  res.setHeader("Cache-Control", ext === ".html" ? "no-cache" : "public, max-age=3600");
  createReadStream(filePath).pipe(res);
}

function tryFile(res: ServerResponse, filePath: string): boolean {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;
  sendFile(res, filePath);
  return true;
}

function spaFallback(res: ServerResponse, distRoot: string): boolean {
  return tryFile(res, join(distRoot, "index.html"));
}

function isStaticAssetPath(pathOnly: string): boolean {
  return (
    pathOnly.startsWith("/icons/") ||
    pathOnly.startsWith("/ui/") ||
    pathOnly.endsWith(".png") ||
    pathOnly.endsWith(".svg") ||
    pathOnly.endsWith(".jpg") ||
    pathOnly.endsWith(".jpeg") ||
    pathOnly.endsWith(".webp") ||
    pathOnly.endsWith(".gif") ||
    pathOnly.endsWith(".ico") ||
    pathOnly.endsWith(".woff") ||
    pathOnly.endsWith(".woff2")
  );
}

/**
 * Serve title UI from manager/client/dist, play UI from core/client/dist,
 * and shared assets from core/assets — all via relative paths.
 */
export function handleStatic(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const url = req.url ?? "/";
  const pathOnly = url.split("?")[0] ?? "/";

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end("Method Not Allowed");
    return;
  }

  // Health
  if (pathOnly === "/health" || pathOnly === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "wop-manager" }));
    return;
  }

  // Core play client: /play/...
  if (pathOnly === "/play" || pathOnly.startsWith("/play/")) {
    if (!existsSync(CORE_CLIENT_DIST)) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Play client not built. Run core client build (core/client/dist).");
      return;
    }
    const sub =
      pathOnly === "/play" || pathOnly === "/play/"
        ? "index.html"
        : pathOnly.slice("/play/".length);
    const file = safeJoin(CORE_CLIENT_DIST, sub);
    if (file && tryFile(res, file)) return;
    if (spaFallback(res, CORE_CLIENT_DIST)) return;
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  // Vite hashed bundles live in */client/dist/assets — not core/assets (icons/ui).
  // Title SPA and play SPA both request absolute /assets/... from the browser.
  if (pathOnly.startsWith("/assets/")) {
    const rel = pathOnly.slice(1); // "assets/..."
    const fromManager = safeJoin(MANAGER_CLIENT_DIST, rel);
    if (fromManager && tryFile(res, fromManager)) return;
    const fromCoreClient = safeJoin(CORE_CLIENT_DIST, rel);
    if (fromCoreClient && tryFile(res, fromCoreClient)) return;
    const fromCoreAssets = safeJoin(CORE_ASSETS, pathOnly.slice("/assets/".length));
    if (fromCoreAssets && tryFile(res, fromCoreAssets)) return;
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  // Title / lobby SPA + shared game icons (/icons, /ui) from core
  if (!existsSync(MANAGER_CLIENT_DIST)) {
    res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><body style="font-family:system-ui;padding:2rem">
      <h1>WarOnPaper manager</h1>
      <p>Title UI not built yet. Run <code>npm run build</code> in <code>manager/</code>.</p>
      <p>WebSocket: <code>/ws</code> · Play (when built): <a href="/play/">/play/</a></p>
      </body></html>`,
    );
    return;
  }

  const rel = pathOnly === "/" ? "index.html" : pathOnly.slice(1);

  const fromManager = safeJoin(MANAGER_CLIENT_DIST, rel);
  if (fromManager && tryFile(res, fromManager)) return;

  // Game UI icons live in core (Vite publicDir → client/dist, or assets/)
  const fromCoreClient = safeJoin(CORE_CLIENT_DIST, rel);
  if (fromCoreClient && tryFile(res, fromCoreClient)) return;
  const fromCoreAssets = safeJoin(CORE_ASSETS, rel);
  if (fromCoreAssets && tryFile(res, fromCoreAssets)) return;

  // Do not SPA-fallback image routes to index.html (breaks <img> decode).
  if (isStaticAssetPath(pathOnly)) {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  if (spaFallback(res, MANAGER_CLIENT_DIST)) return;

  res.writeHead(404);
  res.end("Not Found");
}
