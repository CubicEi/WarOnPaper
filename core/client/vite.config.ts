import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const versionJsonPath = path.resolve(__dirname, "../../version.json");
const repoRoot = path.resolve(__dirname, "../..");
const sharedDir = path.resolve(__dirname, "../shared");
const outFile = path.resolve(sharedDir, "_tmp_navy_verify_out.txt");

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
      name: "watch-version-json",
      configureServer(server) {
        server.watcher.add(versionJsonPath);
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
      "@version.json": versionJsonPath,
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
