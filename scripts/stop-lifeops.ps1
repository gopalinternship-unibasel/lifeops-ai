<#
.SYNOPSIS
  Stops everything scripts\start-lifeops.ps1 started: the web app (5190), the FastAPI planner
  (8010) and the local Supabase containers. Supabase data is kept (no --no-backup).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\stop-lifeops.ps1
  powershell -ExecutionPolicy Bypass -File scripts\stop-lifeops.ps1 -KeepSupabase
#>
[CmdletBinding()]
param(
  # Leave the Supabase containers running.
  [switch]$KeepSupabase
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root ".run\pids.json"

function Stop-Tree([int]$processId, [string]$label) {
  if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
    & taskkill.exe /PID $processId /T /F | Out-Null
    Write-Host "Stopped $label (PID $processId)"
  }
}

if (Test-Path $pidFile) {
  $pids = Get-Content $pidFile -Raw | ConvertFrom-Json
  if ($pids.web) { Stop-Tree ([int]$pids.web) "web app" }
  if ($pids.fastapi) { Stop-Tree ([int]$pids.fastapi) "FastAPI planner" }
  Remove-Item $pidFile -ErrorAction SilentlyContinue
}

# Anything of THIS project still listening on our ports (for example a server started by hand).
foreach ($port in 5190, 8010) {
  $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if ($proc -and ($proc.CommandLine -match [regex]::Escape($root) -or $proc.ExecutablePath -match [regex]::Escape($root))) {
      Stop-Tree ([int]$listener.OwningProcess) "process on port $port"
    } elseif ($proc) {
      Write-Host "Port $port is used by another program (PID $($listener.OwningProcess)); left alone."
    }
  }
}

if (-not $KeepSupabase) {
  $supabase = $env:SUPABASE_CLI
  if (-not $supabase) {
    $candidate = "C:\Users\gopal\tools\supabase\supabase.exe"
    if (Test-Path $candidate) { $supabase = $candidate } else { $supabase = "supabase" }
  }
  Push-Location $root
  try { & $supabase stop } finally { Pop-Location }
}
Write-Host "Done."
