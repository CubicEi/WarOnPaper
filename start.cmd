@echo off
REM WarOnPaper product launcher (Windows).
REM Optional: set WOP_SAVE_KEY / PORT / WOP_BUILD before running to override.

if not defined WOP_SAVE_KEY (
  REM Example AES-256 key (base64 32 bytes). Replace for production deploys.
  set "WOP_SAVE_KEY=jvFkO2ewJA5Sp5Gu674V3djdkFs9IOePd1JmK/SwuiY="
)

node manager/start.js
pause
