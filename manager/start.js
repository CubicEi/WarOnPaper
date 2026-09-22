#!/usr/bin/env node
/**
 * Cross-platform WarOnPaper game server launcher.
 * Resolves paths relative to this file (…/WarOnPaper/server).
 *
 * Usage:
 *   node start.js
 *   ./start.sh
 *   start.bat
 *
 * Optional env:
 *   PORT=8787
 *   WOP_BUILD=1   force rebuild shared + server before start
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Repo layout: WarOnPaper/server → WarOnPaper/develop */
const DEVELOP_ROOT = join(__dirname, "..", "develop");
const SERVER_DIR = join(DEVELOP_ROOT, "server");
const SHARED_DIST = join(DEVELOP_ROOT, "shared", "dist", "index.js");
const SERVER_ENTRY = join(SERVER_DIR, "dist", "index.js");
const NODE_MODULES = join(DEVELOP_ROOT, "node_modules");

function fail(message) {
  console.error(`[wop-start] ${message}`);
  process.exit(1);
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) reject(new Error(`killed by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

async function ensureDeps() {
  if (existsSync(NODE_MODULES)) return;
  console.log("[wop-start] node_modules missing — running npm install…");
  const code = await run("npm", ["install"], DEVELOP_ROOT);
  if (code !== 0) fail(`npm install failed (exit ${code})`);
}

async function ensureBuild(force) {
  const need =
    force || !existsSync(SHARED_DIST) || !existsSync(SERVER_ENTRY);
  if (!need) return;
  console.log("[wop-start] building shared + server…");
  let code = await run("npm", ["run", "build", "-w", "shared"], DEVELOP_ROOT);
  if (code !== 0) fail(`shared build failed (exit ${code})`);
  code = await run("npm", ["run", "build", "-w", "server"], DEVELOP_ROOT);
  if (code !== 0) fail(`server build failed (exit ${code})`);
}

async function main() {
  if (!existsSync(DEVELOP_ROOT)) {
    fail(`develop tree not found at relative path: ${DEVELOP_ROOT}`);
  }
  if (!existsSync(SERVER_DIR)) {
    fail(`server package not found at: ${SERVER_DIR}`);
  }

  const forceBuild =
    process.env.WOP_BUILD === "1" ||
    process.argv.includes("--build");

  await ensureDeps();
  await ensureBuild(forceBuild);

  if (!existsSync(SERVER_ENTRY)) {
    fail(`server entry missing: ${SERVER_ENTRY}`);
  }

  const port = process.env.PORT ?? "8787";
  console.log(`[wop-start] starting server (PORT=${port})`);
  console.log(`[wop-start] entry: ${SERVER_ENTRY}`);

  const code = await run(process.execPath, [SERVER_ENTRY], SERVER_DIR);
  process.exit(code);
}

main().catch((err) => {
  console.error("[wop-start]", err);
  process.exit(1);
});
