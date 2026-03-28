@echo off
set NODE_ENV=production
set WORKER_NAME=worker_01
set DOTENV_CONFIG_QUIET=true
echo Æô¶¯ Worker 1 [worker_01]...
cd /d "%~dp0"
node worker_main.js
pause
