#!/usr/bin/env node
/**
 * Stage manager + core dist trees and Node runtime for Tauri bundling.
 * Output: desktop/runtime/ (sibling layout to dev repo: manager/, core/, config.json)
 */
import { spawnSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = join(HERE, "..");
const REPO_ROOT = join(DESKTOP_ROOT, "..");
const RUNTIME_ROOT = join(DESKTOP_ROOT, "runtime");

const NODE_VERSION = process.env.WOP_NODE_VERSION ?? "22.14.0";
const NODE_PLATFORM = process.env.WOP_NODE_PLATFORM ?? "win-x64";

const log = (msg) => console.log(`[wop-stage] ${msg}`);
const fail = (msg) => {
  console.error(`[wop-stage] error: ${msg}`);
  process.exit(1);
};

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function copyTree(src, dest, { optional = false } = {}) {
  if (!(await exists(src))) {
    if (optional) return;
    fail(`missing path: ${src}`);
  }
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true, force: true, dereference: true });
}

/** Persistent Node tree (survives `runtime/` wipe each stage). */
function nodeCacheDir() {
  return join(
    DESKTOP_ROOT,
    ".cache",
    `node-v${NODE_VERSION}-${NODE_PLATFORM}-bundled`,
  );
}

async function copyNodeTreeTo(destDir) {
  const cache = nodeCacheDir();
  const cacheExe = join(cache, "node.exe");
  if (!(await exists(cacheExe))) {
    fail(`Node cache missing ${cacheExe} — delete .cache and re-run stage`);
  }
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(cache);
  for (const name of entries) {
    await cp(join(cache, name), join(destDir, name), { recursive: true });
  }
}

async function ensureNodeCacheFromZip() {
  const cache = nodeCacheDir();
  const cacheExe = join(cache, "node.exe");
  if (await exists(cacheExe)) {
    return;
  }

  if (process.env.WOP_SKIP_NODE_DOWNLOAD === "1") {
    fail(
      "WOP_SKIP_NODE_DOWNLOAD=1 but Node cache is empty — copy a Node tree to " +
        cache,
    );
  }

  if (process.platform !== "win32") {
    fail(
      "Non-Windows: populate Node cache manually at " +
        cache +
        " (see docs/developer/desktop/README.md)",
    );
  }

  const zipName = `node-v${NODE_VERSION}-${NODE_PLATFORM}.zip`;
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${zipName}`;
  const zipPath = join(DESKTOP_ROOT, ".cache", zipName);
  await mkdir(dirname(zipPath), { recursive: true });

  if (!(await exists(zipPath))) {
    log(`Downloading Node ${NODE_VERSION} (${NODE_PLATFORM})…`);
    const res = await fetch(url);
    if (!res.ok) {
      fail(`Node download failed (${res.status}): ${url}`);
    }
    await pipeline(Readable.fromWeb(res.body), createWriteStream(zipPath));
  } else {
    log(`Using cached zip ${zipPath}`);
  }

  const extractDir = join(DESKTOP_ROOT, ".cache", `node-v${NODE_VERSION}-${NODE_PLATFORM}`);
  const inner = join(extractDir, `node-v${NODE_VERSION}-${NODE_PLATFORM}`);
  if (!(await exists(join(inner, "node.exe")))) {
    await rm(extractDir, { recursive: true, force: true });
    await mkdir(extractDir, { recursive: true });
    log(`Expanding ${zipPath}…`);
    const ps = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
      ],
      { stdio: "inherit" },
    );
    if (ps.status !== 0) {
      fail("Expand-Archive failed — extract Node zip manually into .cache");
    }
  } else {
    log(`Using cached extract at ${inner}`);
  }

  await rm(cache, { recursive: true, force: true });
  await mkdir(cache, { recursive: true });
  const entries = await readdir(inner);
  for (const name of entries) {
    await cp(join(inner, name), join(cache, name), { recursive: true });
  }
  if (!(await exists(cacheExe))) {
    fail(`node.exe not found after extract (expected ${cacheExe})`);
  }
  log(`Node cached at ${cache}`);
}

async function ensureNodeBinary() {
  const nodeDir = join(RUNTIME_ROOT, "node");
  const nodeExe = join(nodeDir, "node.exe");

  if (process.env.WOP_SKIP_NODE_DOWNLOAD === "1") {
    if (await exists(nodeExe)) {
      log(`Node runtime present: ${nodeExe}`);
      return;
    }
    if (await exists(join(nodeCacheDir(), "node.exe"))) {
      await copyNodeTreeTo(nodeDir);
      log(`Copied Node from cache to ${nodeExe}`);
      return;
    }
    log(
      "WOP_SKIP_NODE_DOWNLOAD=1 — place node.exe at runtime/node/node.exe (see docs/developer/desktop/README.md)",
    );
    await mkdir(nodeDir, { recursive: true });
    return;
  }

  await ensureNodeCacheFromZip();
  await copyNodeTreeTo(nodeDir);
  log(`Bundled ${nodeExe}`);
}

/** `@wop/server` loads from manager; only needs `ws` + `@wop/shared` beside dist (no second npm). */
async function linkServerRuntimeDeps() {
  log("linking runtime/core/server node_modules…");
  const managerWs = join(RUNTIME_ROOT, "manager", "node_modules", "ws");
  if (!(await exists(managerWs))) {
    fail("manager node_modules/ws missing — run manager npm install first");
  }
  const sharedPkg = join(RUNTIME_ROOT, "core", "shared");
  if (!(await exists(join(sharedPkg, "dist", "index.js")))) {
    fail("staged core/shared/dist missing");
  }

  const serverNm = join(RUNTIME_ROOT, "core", "server", "node_modules");
  const sharedDest = join(serverNm, "@wop", "shared");
  await rm(serverNm, { recursive: true, force: true });
  await mkdir(join(serverNm, "@wop"), { recursive: true });
  await cp(managerWs, join(serverNm, "ws"), { recursive: true });

  try {
    await symlink(sharedPkg, sharedDest, "junction");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`junction failed (${msg}); copying @wop/shared into node_modules`);
    await cp(sharedPkg, sharedDest, { recursive: true });
  }
}

async function stageProductTree() {
  log(`Staging into ${RUNTIME_ROOT}`);
  await rm(RUNTIME_ROOT, { recursive: true, force: true });
  await mkdir(RUNTIME_ROOT, { recursive: true });

  const pairs = [
    [join(REPO_ROOT, "config.json"), join(RUNTIME_ROOT, "config.json")],
    [join(REPO_ROOT, "manager", "dist"), join(RUNTIME_ROOT, "manager", "dist")],
    [
      join(REPO_ROOT, "manager", "client", "dist"),
      join(RUNTIME_ROOT, "manager", "client", "dist"),
    ],
    [
      join(REPO_ROOT, "manager", "package.json"),
      join(RUNTIME_ROOT, "manager", "package.json"),
    ],
    [
      join(REPO_ROOT, "manager", "package-lock.json"),
      join(RUNTIME_ROOT, "manager", "package-lock.json"),
    ],
    [
      join(REPO_ROOT, "core", "client", "dist"),
      join(RUNTIME_ROOT, "core", "client", "dist"),
    ],
    [
      join(REPO_ROOT, "core", "server", "dist"),
      join(RUNTIME_ROOT, "core", "server", "dist"),
    ],
    [
      join(REPO_ROOT, "core", "shared", "dist"),
      join(RUNTIME_ROOT, "core", "shared", "dist"),
    ],
    [
      join(REPO_ROOT, "core", "shared", "package.json"),
      join(RUNTIME_ROOT, "core", "shared", "package.json"),
    ],
    [
      join(REPO_ROOT, "core", "server", "package.json"),
      join(RUNTIME_ROOT, "core", "server", "package.json"),
    ],
    [join(REPO_ROOT, "core", "assets"), join(RUNTIME_ROOT, "core", "assets")],
  ];

  for (const [src, dest] of pairs) {
    await copyTree(src, dest, {
      optional: src.endsWith("package-lock.json"),
    });
  }

  const npmInstall = (cwd, label) => {
    log(`npm install --omit=dev (${label})…`);
    const args = "npm install --omit=dev --no-audit --no-fund --loglevel=warn";
    const result =
      process.platform === "win32"
        ? spawnSync("cmd.exe", ["/d", "/s", "/c", args], {
            cwd,
            stdio: "inherit",
          })
        : spawnSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=warn"], {
            cwd,
            stdio: "inherit",
            shell: false,
          });
    if (result.error) {
      fail(`npm spawn failed in ${label}: ${result.error.message}`);
    }
    if (result.status !== 0) {
      fail(`npm install failed in ${label} (exit ${result.status})`);
    }
  };

  npmInstall(join(RUNTIME_ROOT, "manager"), "runtime/manager");
  await linkServerRuntimeDeps();

  const readme = join(RUNTIME_ROOT, "README.txt");
  await writeFile(
    readme,
    [
      "WarOnPaper desktop runtime (staged by desktop/scripts/stage-runtime.mjs).",
      "Do not edit — regenerated on each desktop build.",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function main() {
  const required = [
    join(REPO_ROOT, "manager", "dist", "index.js"),
    join(REPO_ROOT, "manager", "client", "dist", "index.html"),
    join(REPO_ROOT, "core", "client", "dist", "index.html"),
    join(REPO_ROOT, "core", "server", "dist", "room.js"),
  ];
  for (const p of required) {
    if (!(await exists(p))) {
      fail(`build artifact missing: ${p}\nRun build.cmd from repo root first.`);
    }
  }

  await stageProductTree();
  await ensureNodeBinary();
  log("done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
