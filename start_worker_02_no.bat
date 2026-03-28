@echo off
set NODE_ENV=production
set WORKER_NAME=worker_02
set DOTENV_CONFIG_QUIET=true
set HEADLESS=true
echo Æô¶¯ Worker 2 [worker_02]...
cd /d "%~dp0"
node worker_main.js
pause
