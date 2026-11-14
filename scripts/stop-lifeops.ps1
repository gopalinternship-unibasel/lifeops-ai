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

# A recorded PID is stopped only while it is still this project's process: after a crash or a
# reboot Windows gives the number to another program, which must not be killed (this PC runs
# other projects at the same time).
function Stop-Recorded([int]$processId, [string]$label) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
  if (-not $proc) { return }
  if ($proc.CommandLine -match [regex]::Escape($root)) { Stop-Tree $processId $label }
  else { Write-Host "PID $processId (recorded for the $label) now belongs to another program; left alone." }
}

if (Test-Path $pidFile) {
  $pids = Get-Content $pidFile -Raw | ConvertFrom-Json
  if ($pids.web) { Stop-Recorded ([int]$pids.web) "web app" }
  if ($pids.fastapi) { Stop-Recorded ([int]$pids.fastapi) "FastAPI planner" }
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
    $candidate = Join-Path $env:USERPROFILE "tools\supabase\supabase.exe"
    if (Test-Path $candidate) { $supabase = $candidate } else { $supabase = "supabase" }
  }
  Push-Location $root
  try { & $supabase stop } finally { Pop-Location }
}
Write-Host "Done."
