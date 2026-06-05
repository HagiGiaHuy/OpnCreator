# OpnCreator Extension Build Script
# Packages the extension into a .vsix file using @vscode/vsce
# Run: powershell -ExecutionPolicy Bypass -File "H:\Trunk\OpnCreator\build.ps1"

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ExtDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Step($msg) { Write-Host "  $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  OK  $msg" -ForegroundColor Green }
function Write-Err($msg)  { Write-Host "  ERR $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "OpnCreator - Build VSIX" -ForegroundColor Yellow
Write-Host "========================" -ForegroundColor Yellow
Write-Host ""

# Check node/npm
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Err "node.js not found. Install from https://nodejs.org" }
if (-not (Get-Command npm  -ErrorAction SilentlyContinue)) { Write-Err "npm not found." }

Write-Step "Node  : $(node --version)"
Write-Step "npm   : $(npm --version)"
Write-Host ""

# Package
Write-Step "Running vsce package..."
Push-Location $ExtDir
try {
    npx --yes "@vscode/vsce" package --no-dependencies --allow-missing-repository 2>&1
    $vsixFile = Get-ChildItem -Path $ExtDir -Filter "*.vsix" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($vsixFile) {
        Write-Host ""
        Write-Ok "Package created:"
        Write-Host "    $($vsixFile.FullName)" -ForegroundColor White
        Write-Host "    Size: $([math]::Round($vsixFile.Length / 1KB, 1)) KB" -ForegroundColor Gray
        Write-Host ""
        Write-Host "  Install with:" -ForegroundColor Yellow
        Write-Host "    code --install-extension `"$($vsixFile.FullName)`"" -ForegroundColor Gray
        Write-Host "    -- or --" -ForegroundColor Gray
        Write-Host "    VS Code: Extensions > Install from VSIX..." -ForegroundColor Gray
    } else {
        Write-Err "VSIX file not found after packaging."
    }
} finally {
    Pop-Location
}
Write-Host ""
