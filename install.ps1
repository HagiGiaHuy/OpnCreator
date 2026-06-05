# OpnCreator Extension Installer
# Installs the extension directly into VS Code's extensions folder.
# Run from any location: powershell -ExecutionPolicy Bypass -File "H:\Trunk\OpnCreator\install.ps1"

param(
    [switch]$Uninstall,
    [switch]$Reload
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ExtensionName    = "opncreator-1.0.0"
$ExtensionSrcDir  = Split-Path -Parent $MyInvocation.MyCommand.Path   # This script's directory
$VsCodeExtDir     = Join-Path $env:USERPROFILE ".vscode\extensions"
$TargetDir        = Join-Path $VsCodeExtDir $ExtensionName

# Files to copy (exclude Prompt examples and this script itself)
$ExcludePatterns  = @("Prompt", "install.ps1", ".vscodeignore", "*.vsix")

function Write-Step($msg) { Write-Host "  $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  OK  $msg" -ForegroundColor Green }
function Write-Err($msg)  { Write-Host "  ERR $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "OpnCreator VS Code Extension" -ForegroundColor Yellow
Write-Host "=============================" -ForegroundColor Yellow

# ── Uninstall ────────────────────────────────────────────────────────────────
if ($Uninstall) {
    if (Test-Path $TargetDir) {
        Write-Step "Removing $TargetDir ..."
        Remove-Item $TargetDir -Recurse -Force
        Write-Ok "Extension uninstalled."
    } else {
        Write-Host "  Extension not found at $TargetDir" -ForegroundColor Gray
    }
    exit 0
}

# ── Install ──────────────────────────────────────────────────────────────────
Write-Step "Source : $ExtensionSrcDir"
Write-Step "Target : $TargetDir"
Write-Host ""

# Ensure target exists
if (-not (Test-Path $VsCodeExtDir)) {
    New-Item -ItemType Directory -Path $VsCodeExtDir | Out-Null
}

# Remove old version if present
if (Test-Path $TargetDir) {
    Write-Step "Removing old version..."
    Remove-Item $TargetDir -Recurse -Force
}
New-Item -ItemType Directory -Path $TargetDir | Out-Null

# Copy files
Write-Step "Copying extension files..."
$items = Get-ChildItem -Path $ExtensionSrcDir -Force |
         Where-Object { $_.Name -notin $ExcludePatterns }

foreach ($item in $items) {
    $dest = Join-Path $TargetDir $item.Name
    if ($item.PSIsContainer) {
        Copy-Item -Path $item.FullName -Destination $dest -Recurse -Force
    } else {
        Copy-Item -Path $item.FullName -Destination $dest -Force
    }
    Write-Host "    + $($item.Name)" -ForegroundColor DarkGray
}

Write-Host ""
Write-Ok "Extension installed to:"
Write-Host "    $TargetDir" -ForegroundColor White

# ── Reload hint ───────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor Yellow
Write-Host "    1. Restart VS Code (or run: code --reuse-window)" -ForegroundColor Gray
Write-Host "    2. Press Alt+Shift+O  (or Command Palette: 'OpnCreator: Create Operation')" -ForegroundColor Gray
Write-Host ""
