# Start number N -> generates 10 files: N..N+9, start_worker_XX.bat (same layout as start_worker_01.bat)
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\generate_worker_starts.ps1 -Start 1
#   powershell -ExecutionPolicy Bypass -File .\generate_worker_starts.ps1 -Start 11
# Or: $env:WORKER_START = 11; .\generate_worker_starts.ps1

param(
    [int]$Start = 0
)

$ErrorActionPreference = 'Stop'

$base = $null
if ($Start -gt 0) {
    $base = $Start
} else {
    $ws = $env:WORKER_START
    if ($ws -and ($ws.Trim() -match '^\d+$')) {
        $base = [int]$ws.Trim()
    } else {
        $in = Read-Host 'Enter start number (e.g. 1 -> 1-10, 11 -> 11-20)'
        if (-not ($in -match '^\d+$')) {
            Write-Host 'Invalid: need a non-negative integer.' -ForegroundColor Red
            exit 1
        }
        $base = [int]$in
    }
}

if ($base -lt 1) {
    Write-Host 'Start number must be >= 1.' -ForegroundColor Red
    exit 1
}

$dir = $PSScriptRoot
if (-not $dir) { $dir = Get-Location }

function Get-WorkerSuffix([int]$n) {
    if ($n -lt 100) { return ('{0:D2}' -f $n) }
    if ($n -lt 1000) { return ('{0:D3}' -f $n) }
    return $n.ToString()
}

$enc = [System.Text.Encoding]::GetEncoding(936)

for ($k = 0; $k -lt 10; $k++) {
    $num = $base + $k
    $suffix = Get-WorkerSuffix $num
    $fname = "start_worker_$suffix.bat"
    $path = Join-Path $dir $fname

    $lines = @(
        '@echo off',
        'set NODE_ENV=production',
        "set WORKER_NAME=worker_$suffix",
        'set DOTENV_CONFIG_QUIET=true',
        "echo 启动 Worker $num [worker_$suffix]...",
        'cd /d "%~dp0"',
        'node worker_main.js',
        'pause'
    )
    $body = ($lines -join "`r`n") + "`r`n"
    [System.IO.File]::WriteAllText($path, $body, $enc)
    Write-Host "Generated: $fname"
}

Write-Host 'Done.' -ForegroundColor Green
