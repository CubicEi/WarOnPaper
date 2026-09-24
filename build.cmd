@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem Rebuild products served by manager on :4358
rem   core/shared + core/server + core/client
rem   manager server + manager/client (title UI)
rem
rem Usage (from repo root, CMD or double-click):
rem   build.cmd
rem
rem Prefer npm.cmd so PowerShell ExecutionPolicy cannot block npm.ps1.

where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo [wop-build] error: npm.cmd not found in PATH
  echo [wop-build] install Node.js LTS, then retry.
  exit /b 1
)

echo [wop-build] core: shared + server + client ...
pushd "%~dp0core"
call npm.cmd run build
if errorlevel 1 (
  echo [wop-build] core build failed
  popd
  exit /b 1
)
popd

echo [wop-build] manager server ...
pushd "%~dp0manager"
call npm.cmd run build:server
if errorlevel 1 (
  echo [wop-build] manager server build failed
  popd
  exit /b 1
)
popd

echo [wop-build] manager title client ...
pushd "%~dp0manager\client"
call npm.cmd run build
if errorlevel 1 (
  echo [wop-build] manager client build failed
  popd
  exit /b 1
)
popd

echo [wop-build] done.
echo [wop-build] restart manager ^(e.g. manager\start.sh / npm run start^) to load new dist.
exit /b 0
