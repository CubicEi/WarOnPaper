# WarOnPaper desktop (Tauri LAN client)

Windows-first Tauri 2 shell around the existing **manager** HTTP/WebSocket server. Host mode bundles Node and starts `manager/dist/index.js`; Join mode opens a WebView to a LAN host URL. Gameplay, room codes, and `/play/` behavior match the browser product.

See also [manager start & hosting](../manager/start-and-hosting.md) and [project overview](../00-project-overview.md).

## Modes

| Mode | CLI | Behavior |
|------|-----|----------|
| **Host** (default) | `WarOnPaper.exe` or `--host` | Spawns bundled Node manager, opens `http://127.0.0.1:4358/`, title UI shows LAN invite URLs via `GET /api/host-info`. |
| **Join** | `--join <host>` or `--join <host:port>` | No Node sidecar; WebView loads `http://<host>:4358/` (port defaults to `4358`). Use room code on the title screen as in the browser. |

User data (identities / nicknames) on Host is stored under `%APPDATA%\WarOnPaper\data` (`WOP_MANAGER_DATA`).

## Prerequisites

- **Node.js LTS** — build `manager` + `core` (`build.cmd`).
- **Rust toolchain** (`rustup`, `cargo`) — Tauri 2.
- **Windows 10/11 x64** — first supported target.

## Build

From repo root (CMD):

```bat
build-desktop.cmd
```

This runs `build.cmd`, then `desktop/npm run build` (stage runtime + `tauri build`). Installers appear under:

`desktop/src-tauri/target/release/bundle/`

`build-desktop.cmd` sets `CARGO_TARGET_DIR` to that tree. If you build from a Cursor agent terminal, artifacts may instead land under `%TEMP%\cursor-sandbox-cache\...\cargo-target\release\bundle\` — the NSIS `WarOnPaper_*_x64-setup.exe` there is the same installer.

### Stage only (no Tauri compile)

```bat
cd desktop
npm install
npm run stage
```

Output tree: `desktop/runtime/` with the same `manager/` + `core/` + `config.json` layout as development. Only **one** `npm install` runs (`runtime/manager`); `runtime/core/server/node_modules` is linked from manager’s `ws` + a junction to `core/shared` (avoids a slow second npm on Windows).

### Node runtime in the bundle

`desktop/scripts/stage-runtime.mjs` copies Node from `desktop/.cache/node-v*-bundled/` into `runtime/node/` on each stage. **Download + Expand-Archive** run only when that cache is missing (zip is reused under `.cache/`). Each `stage` still wipes `runtime/` for dist trees, so `node.exe` is re-copied from cache — not re-extracted every time.

| Variable | Purpose |
|----------|---------|
| `WOP_SKIP_NODE_DOWNLOAD=1` | Skip download; place `node.exe` manually under `desktop/runtime/node/`. |
| `WOP_NODE_VERSION` | Override Node version (default `22.14.0`). |

## Manager env (Host sidecar)

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `4358` | HTTP + WebSocket port (Tauri passes this when spawning manager). |
| `WOP_BIND` | `0.0.0.0` | Listen address (LAN access). |
| `WOP_MANAGER_DATA` | `%APPDATA%\WarOnPaper\data` | Writable `identities.json` directory. |

Firewall: allow inbound TCP on the chosen port on the host PC. The title screen shows a short hint and copyable `http://<LAN-IP>:<port>/` links.

## Uninstall / user data

NSIS uninstaller asks whether to remove `%APPDATA%\WarOnPaper` (optional). Hook: `desktop/src-tauri/windows/hooks.nsh`.

## Local development

1. `build.cmd` — ensure dist artifacts exist.
2. `cd desktop && npm install && npm run dev` — stages runtime, runs `tauri dev` (Host mode spawns manager from `desktop/runtime/`).

To test Join without rebuilding the shell:

```bat
desktop\src-tauri\target\debug\app.exe --join 192.168.1.10
```

## Acceptance checklist

1. Two Windows PCs on the same LAN: A runs Host, creates a room; B runs `--join <A-IP>`, enters room code, reaches `/play/`.
2. Host with only loopback still works for solo testing.
3. Restart Host client — nickname/identity persists under AppData.
4. Installer on a machine **without** global Node runs Host using bundled `runtime/node/node.exe`.

## Troubleshooting (Windows bundle)

### `light` / MSI step appears stuck

Tauri **must** list runtime as a directory in the **array** form of `bundle.resources` (e.g. `"../runtime/"`). The **map** form with a glob (`"../runtime/**/*": "runtime/"`) flattens every file into one folder, which balloons the WiX project and makes `light` run for a very long time.

If a bad build left a flat folder, delete `desktop/src-tauri/target/release/runtime` (thousands of loose files, no `manager/` subfolder) and rebuild.

WiX may still leave an intermediate MSI at `target/release/wix/x64/output.msi` even when `bundle/msi/` is empty; after a successful build the renamed file should appear under `bundle/msi/`. Prefer the **NSIS** installer under `bundle/nsis/` for day-to-day testing (faster than MSI).

## Layout

```
desktop/
  package.json
  scripts/stage-runtime.mjs
  runtime/                 # generated — bundled as Tauri resources
  src-tauri/
    src/lib.rs             # Host/Join, child process lifecycle
    tauri.conf.json
    windows/hooks.nsh      # optional AppData wipe on uninstall
```
