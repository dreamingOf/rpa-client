@echo off
setlocal
cd /d "%~dp0"
REM Parentheses in set /p prompt break cmd unless escaped with ^
set /p WORKER_START=Enter start number ^(1=1-10, 11=11-20^): 
if "%WORKER_START%"=="" (
  echo Empty input. Exiting.
  pause
  exit /b 1
)

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" (
  echo PowerShell not found: %PS%
  pause
  exit /b 1
)

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0generate_worker_starts.ps1" -Start %WORKER_START%
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" (
  echo.
  echo Failed with exit code %ERR%.
  pause
  exit /b %ERR%
)
echo.
pause
