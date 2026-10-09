import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configJsonPath = path.resolve(__dirname, "../../config.json");
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
      },
    },
  ],
  resolve: {
    alias: {},
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
