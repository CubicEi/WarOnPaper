import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const versionJsonPath = path.resolve(__dirname, "../../version.json");

export default defineConfig({
  plugins: [
    react(),
    {
      name: "watch-version-json",
      configureServer(server) {
        server.watcher.add(versionJsonPath);
      },
    },
  ],
  resolve: {
    alias: {
      "@version.json": versionJsonPath,
    },
  },
  server: {
    host: true,
    port: 5174,
    fs: {
      allow: [path.resolve(__dirname, "../..")],
    },
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
