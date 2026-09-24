import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootVersion = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../version.json"), "utf8"),
).version as string;

export default defineConfig({
  plugins: [react()],
  define: {
    __WOP_VERSION__: JSON.stringify(rootVersion),
  },
  resolve: {
    alias: {
      "@wop/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
  server: {
    host: true,
    port: 5173,
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
