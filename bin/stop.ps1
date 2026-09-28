# Stop local FOI backend via data/server.pid
$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root "data/server.pid"
if (-not (Test-Path $pidFile)) {
  Write-Host "No server.pid found; service may not be running."
  exit 0
}
$info = Get-Content $pidFile -Raw | ConvertFrom-Json
Stop-Process -Id $info.pid -Force -ErrorAction SilentlyContinue
Write-Host ("Stopped pid {0} ({1})" -f $info.pid, $info.url)
Remove-Item -LiteralPath $pidFile -Force
