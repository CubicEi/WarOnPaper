import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync, statSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configJsonPath = path.resolve(__dirname, "../../config.json");
const coreAssetsPath = path.resolve(__dirname, "../../core/assets");
const CONFIG_PUBLIC_ID = "\0wop-config-public";
const ICON_PRELOAD_ID = "\0wop-icon-preload-urls";

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

/** Walk core/assets icons + ui PNGs into stable `/icons/...` / `/ui/...` URLs. */
function collectIconPreloadUrls(): string[] {
  const roots = ["icons", "ui"] as const;
  const urls: string[] = [];

  const walk = (absDir: string, urlPrefix: string) => {
    let entries;
    try {
      entries = readdirSync(absDir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith("_") || name.startsWith(".")) continue;
      const abs = path.join(absDir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      const seg = encodeURIComponent(name);
      if (st.isDirectory()) {
        walk(abs, `${urlPrefix}/${seg}`);
        continue;
      }
      if (!st.isFile()) continue;
      const lower = name.toLowerCase();
      if (!lower.endsWith(".png") && !lower.endsWith(".svg")) continue;
      urls.push(`${urlPrefix}/${seg}`);
    }
  };

  for (const root of roots) {
    walk(path.join(coreAssetsPath, root), `/${root}`);
  }
  urls.sort();
  return urls;
}

function iconPreloadUrlsPlugin(): Plugin {
  return {
    name: "wop-icon-preload-urls",
    resolveId(id) {
      if (id === "@wop/icon-preload-urls") return ICON_PRELOAD_ID;
    },
    load(id) {
      if (id !== ICON_PRELOAD_ID) return;
      const urls = collectIconPreloadUrls();
      return `export const ICON_PRELOAD_URLS = ${JSON.stringify(urls)};\n`;
    },
    configureServer(server) {
      server.watcher.add(path.join(coreAssetsPath, "icons"));
      server.watcher.add(path.join(coreAssetsPath, "ui"));
      const reload = (file: string) => {
        const f = file.toLowerCase();
        if (!f.endsWith(".png") && !f.endsWith(".svg")) return;
        const mod = server.moduleGraph.getModuleById(ICON_PRELOAD_ID);
        if (mod) void server.reloadModule(mod);
      };
      server.watcher.on("add", reload);
      server.watcher.on("unlink", reload);
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    iconPreloadUrlsPlugin(),
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
      "/icons": {
        target: "http://localhost:4358",
      },
      "/ui": {
        target: "http://localhost:4358",
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
