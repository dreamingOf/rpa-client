@echo off
chcp 65001 >nul
set NODE_ENV=development
set WORKER_NAME=worker_dev
set DOTENV_CONFIG_QUIET=true
echo Æô¶¯ Worker [development]...
cd /d "%~dp0"
node worker_main.js
pause
