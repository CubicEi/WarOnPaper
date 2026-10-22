@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem Build WarOnPaper desktop (Tauri) installer for Windows.
rem   1. Rebuild manager + core web assets (build.cmd)
rem   2. Stage runtime + bundle Tauri (desktop/)

where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo [wop-desktop] error: npm.cmd not found in PATH
  exit /b 1
)

where cargo >nul 2>&1
if errorlevel 1 (
  echo [wop-desktop] error: cargo/rust not found — install Rust toolchain
  exit /b 1
)

echo [wop-desktop] product build ...
call "%~dp0build.cmd"
if errorlevel 1 exit /b 1

echo [wop-desktop] desktop npm install ...
pushd "%~dp0desktop"
call npm.cmd install
if errorlevel 1 (
  popd
  exit /b 1
)

rem Keep Rust/Tauri output in the repo (Cursor agent sandbox may use %TEMP%\cursor-sandbox-cache\...\cargo-target).
set "CARGO_TARGET_DIR=%~dp0desktop\src-tauri\target"
echo [wop-desktop] tauri build (CARGO_TARGET_DIR=%CARGO_TARGET_DIR%) ...
call npm.cmd run build
set ERR=%ERRORLEVEL%
popd
if not "%ERR%"=="0" exit /b %ERR%

echo [wop-desktop] done. Installers under desktop\src-tauri\target\release\bundle\
exit /b 0
