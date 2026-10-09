import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configJsonPath = path.resolve(__dirname, "../../config.json");
const repoRoot = path.resolve(__dirname, "../..");
const sharedDir = path.resolve(__dirname, "../shared");
const outFile = path.resolve(sharedDir, "_tmp_navy_verify_out.txt");
const CONFIG_PUBLIC_ID = "\0wop-config-public";

/** Client-safe slice of config.json (never ship saveKey to the browser). */
function loadPublicConfigModule(): string {
  try {
    const raw = JSON.parse(readFileSync(configJsonPath, "utf8")) as {
      version?: string;
    };
    return `export default ${JSON.stringify({ version: raw.version ?? "unknown" })}`;
  } catch {
    return `export default ${JSON.stringify({ version: "unknown" })}`;
  }
}

function runCapture(cmd: string, args: string[], cwd: string): string {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, npm_config_yes: "true" },
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string; status?: number };
    return `${err.stdout ?? ""}${err.stderr ?? ""}\n(error status=${err.status ?? "?"} ${err.message ?? ""})\n`;
  }
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: "wop-config-public",
      resolveId(id) {
        if (id === "@config.json") return CONFIG_PUBLIC_ID;
      },
      load(id) {
        if (id === CONFIG_PUBLIC_ID) return loadPublicConfigModule();
      },
      configureServer(server) {
        server.watcher.add(configJsonPath);
        server.watcher.on("change", (file) => {
          if (path.resolve(file) === configJsonPath) {
            const mod = server.moduleGraph.getModuleById(CONFIG_PUBLIC_ID);
            if (mod) void server.reloadModule(mod);
          }
        });
        // TEMP agent verify endpoint — remove after use.
        server.middlewares.use("/__tmp_navy_verify", (_req, res) => {
          const parts: string[] = [];
          parts.push("===== git status --short =====\n");
          parts.push(runCapture("git", ["-C", repoRoot, "status", "--short"], repoRoot));
          parts.push("\n===== git diff --stat =====\n");
          parts.push(runCapture("git", ["-C", repoRoot, "diff", "--stat"], repoRoot));
          parts.push("\n===== navy verify script =====\n");
          parts.push(
            runCapture(
              process.platform === "win32" ? "npx.cmd" : "npx",
              ["--yes", "tsx", "_tmp_navy_verify_run.ts"],
              sharedDir,
            ),
          );
          const body = parts.join("");
          try {
            writeFileSync(outFile, body, "utf8");
          } catch {
            /* ignore */
          }
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end(body);
        });
      },
    },
  ],
  resolve: {
    alias: {
      "@wop/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
  server: {
    host: true,
    port: 5173,
    fs: {
      allow: [path.resolve(__dirname, "../..")],
    },
    watch: {
      // Avoid EBUSY when OS locks temp/download files under assets
      ignored: ["**/assets/**/*.jpg", "**/assets/**/*.JPG", "**/__pycache__/**"],
    },
    proxy: {
      // Prefer manager (:4358). Fallback: core debug server still works if manager not up
      // and you point VITE_WS_URL at ws://localhost:8787.
      "/ws": {
        target: "ws://localhost:4358",
        ws: true,
      },
    },
  },
  publicDir: path.resolve(__dirname, "../assets"),
});
