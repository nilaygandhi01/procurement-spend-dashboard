#!/usr/bin/env pwsh
# Convenience wrapper for the Index Analysis unit tests.
# Runs every *.test.mjs under scripts/tests/ via Node's built-in test runner.
# No npm install / build step required.

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $here

Push-Location $repo
try {
    Write-Host "Running scripts/tests/*.test.mjs via node --test ..." -ForegroundColor Cyan
    node --test (Get-ChildItem -Path "scripts/tests" -Filter "*.test.mjs" -File | ForEach-Object { $_.FullName })
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Tests FAILED (exit $LASTEXITCODE)" -ForegroundColor Red
        exit $LASTEXITCODE
    }
    Write-Host "All tests passed." -ForegroundColor Green
}
finally {
    Pop-Location
}
