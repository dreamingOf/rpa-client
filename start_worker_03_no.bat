@echo off
set NODE_ENV=production
set WORKER_NAME=worker_03
set DOTENV_CONFIG_QUIET=true
set HEADLESS=true
echo Æô¶¯ Worker 3 [worker_03]...
cd /d "%~dp0"
node worker_main.js
pause
