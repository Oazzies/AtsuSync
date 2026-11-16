$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

Write-Host ''
Write-Host '=== AtsuSync Setup ===' -ForegroundColor Cyan
Write-Host "Folder: $repoRoot"
Write-Host ''

# 1. Check Node.js >= 22.5.0
function Get-NodeVersion {
  try {
    $v = (& node -v 2>$null).Trim()
    if ($v -match '^v?(\d+)\.(\d+)\.(\d+)') {
      return [version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
    }
  } catch {}
  return $null
}

$minNode = [version]'22.5.0'
$nodeVer = Get-NodeVersion
if (-not $nodeVer -or $nodeVer -lt $minNode) {
  Write-Host "Node.js >= 22.5.0 is required (found: $(if ($nodeVer) { $nodeVer } else { 'none' }))." -ForegroundColor Yellow
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    $ans = Read-Host 'Install Node.js LTS via winget now? [Y/n]'
    if ($ans -eq '' -or $ans -match '^[Yy]') {
      & winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
      $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
      $nodeVer = Get-NodeVersion
    }
  }
  if (-not $nodeVer -or $nodeVer -lt $minNode) {
    Write-Host 'Please install Node.js 22+ (LTS recommended) from https://nodejs.org and re-run setup.cmd.' -ForegroundColor Red
    exit 1
  }
}
Write-Host "[OK] Node.js v$nodeVer" -ForegroundColor Green

# 2. Check Git (optional, enables 1-click updates)
if (Get-Command git -ErrorAction SilentlyContinue) {
  Write-Host '[OK] Git found' -ForegroundColor Green
} else {
  Write-Host '[WARN] Git not found - in-app 1-click updates will be unavailable (you can still update via ZIP).' -ForegroundColor Yellow
}

# 3. Install dependencies & build extension
Write-Host ''
Write-Host 'Installing dependencies...' -ForegroundColor Cyan
& npm install
if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }

Write-Host ''
Write-Host 'Building browser extension...' -ForegroundColor Cyan
& npm run build
if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }

# 4. Register atsusync:// protocol handler
Write-Host ''
Write-Host 'Registering atsusync:// protocol handler...' -ForegroundColor Cyan
& (Join-Path $PSScriptRoot 'register-protocol.ps1')

$extDist = Join-Path $repoRoot 'extension\dist'
Write-Host ''
Write-Host '=== Setup Complete ===' -ForegroundColor Green
Write-Host ''
Write-Host 'Next steps to load the browser extension:' -ForegroundColor White
Write-Host '  1. Open chrome://extensions (or edge://extensions / brave://extensions)'
Write-Host '  2. Enable "Developer mode" (top-right toggle)'
Write-Host '  3. Click "Load unpacked" and select:'
Write-Host "     $extDist" -ForegroundColor Yellow
Write-Host '  4. Open https://atsu.moe and click the AtsuSync icon (or "Start Server" in the panel).'
Write-Host ''
