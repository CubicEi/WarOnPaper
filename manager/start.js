#!/usr/bin/env node
/**
 * Cross-platform WarOnPaper product launcher (manager entry on :4358).
 * Resolves paths relative to this file (…/WarOnPaper/manager).
 *
 * Usage:
 *   node start.js
 *   ./start.sh
 *   start.bat
 *
 * Optional env:
 *   PORT=4358          (default)
 *   WOP_BUILD=1        force rebuild core + manager before start
 *   WOP_SAVE_KEY=…     set by start.cmd / start.sh (not defaulted here)
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Repo layout: WarOnPaper/manager → WarOnPaper/core */
const CORE_ROOT = join(__dirname, "..", "core");
const MANAGER_ROOT = __dirname;
const SHARED_DIST = join(CORE_ROOT, "shared", "dist", "index.js");
const SERVER_DIST = join(CORE_ROOT, "server", "dist", "index.js");
const SERVER_ROOM_DIST = join(CORE_ROOT, "server", "dist", "room.js");
const CORE_CLIENT_DIST = join(CORE_ROOT, "client", "dist", "index.html");
const MANAGER_ENTRY = join(MANAGER_ROOT, "dist", "index.js");
const MANAGER_CLIENT_DIST = join(MANAGER_ROOT, "client", "dist", "index.html");
const CORE_NODE_MODULES = join(CORE_ROOT, "node_modules");
const MANAGER_NODE_MODULES = join(MANAGER_ROOT, "node_modules");
const MANAGER_CLIENT_NODE_MODULES = join(MANAGER_ROOT, "client", "node_modules");

function fail(message) {
  console.error(`[wop-start] ${message}`);
  process.exit(1);
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    // Never use shell:true — on Windows it breaks paths with spaces
    // (e.g. C:\Program Files\nodejs\node.exe → 'C:\Program').
    // npm is a .cmd shim; spawn npm.cmd directly without a shell.
    const cmd =
      process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
    const child = spawn(cmd, args, {
      cwd,
      stdio: "inherit",
      shell: false,
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) reject(new Error(`killed by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

async function npmInstall(cwd, label) {
  console.log(`[wop-start] npm install (${label})…`);
  const code = await run("npm", ["install"], cwd);
  if (code !== 0) fail(`npm install failed in ${label} (exit ${code})`);
}

async function ensureDeps() {
  if (!existsSync(CORE_NODE_MODULES)) {
    await npmInstall(CORE_ROOT, "core");
  }
  if (!existsSync(MANAGER_NODE_MODULES)) {
    await npmInstall(MANAGER_ROOT, "manager");
  }
  if (!existsSync(MANAGER_CLIENT_NODE_MODULES)) {
    await npmInstall(join(MANAGER_ROOT, "client"), "manager/client");
  }
}

async function ensureBuild(force) {
  const needCore =
    force ||
    !existsSync(SHARED_DIST) ||
    !existsSync(SERVER_DIST) ||
    !existsSync(SERVER_ROOM_DIST) ||
    !existsSync(CORE_CLIENT_DIST);
  if (needCore) {
    console.log("[wop-start] building core (shared + server + client)…");
    const code = await run("npm", ["run", "build"], CORE_ROOT);
    if (code !== 0) fail(`core build failed (exit ${code})`);
  }

  const needManager =
    force || !existsSync(MANAGER_ENTRY) || !existsSync(MANAGER_CLIENT_DIST);
  if (needManager) {
    console.log("[wop-start] building manager server…");
    let code = await run("npm", ["run", "build:server"], MANAGER_ROOT);
    if (code !== 0) fail(`manager server build failed (exit ${code})`);
    console.log("[wop-start] building manager title client…");
    code = await run("npm", ["run", "build"], join(MANAGER_ROOT, "client"));
    if (code !== 0) fail(`manager client build failed (exit ${code})`);
  }
}

async function main() {
  if (!existsSync(CORE_ROOT)) {
    fail(`core tree not found at relative path: ${CORE_ROOT}`);
  }

  const forceBuild =
    process.env.WOP_BUILD === "1" || process.argv.includes("--build");

  await ensureDeps();
  await ensureBuild(forceBuild);

  if (!existsSync(MANAGER_ENTRY)) {
    fail(`manager entry missing: ${MANAGER_ENTRY}`);
  }

  const port = process.env.PORT ?? "4358";
  console.log(`[wop-start] starting manager (PORT=${port})`);
  console.log(`[wop-start] entry: ${MANAGER_ENTRY}`);

  const code = await run(process.execPath, [MANAGER_ENTRY], MANAGER_ROOT);
  process.exit(code);
}

main().catch((err) => {
  console.error("[wop-start]", err);
  process.exit(1);
});
