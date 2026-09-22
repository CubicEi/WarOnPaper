@echo on
pause
setlocal
pause
cd /d "%~dp0"
pause
node "%~dp0start.js" %*
pause
exit /b %ERRORLEVEL%
pause