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
  server: {
    host: true,
    port: 5174,
    proxy: {
      "/ws": {
        target: "ws://localhost:4358",
        ws: true,
      },
      "/play": {
        target: "http://localhost:4358",
      },
      "/assets": {
        target: "http://localhost:4358",
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
