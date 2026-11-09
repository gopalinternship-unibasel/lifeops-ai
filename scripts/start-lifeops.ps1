<#
.SYNOPSIS
  Starts the whole LifeOps AI (MONDAY) stack on this PC.

.DESCRIPTION
  1. Local Supabase (Docker) on ports 55320-55329 with the migrations in supabase/migrations
     (new migrations are applied to an existing database too).
  2. Writes .env.local and fastapi-backend/.env from `supabase status` (no secrets printed).
  3. Installs npm packages and the FastAPI virtualenv on first run.
  4. Creates the local test user (.local-test-user.json) if it does not exist.
  5. Starts the FastAPI planner on http://127.0.0.1:8010 and the web app on http://localhost:5190
     in the background. Logs go to .run\*.log, process ids to .run\pids.json.
  Stop everything with scripts\stop-lifeops.ps1.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\start-lifeops.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\start-lifeops.ps1 -WaitSeconds 1200
#>
[CmdletBinding()]
param(
  # Skip `npm install` / `pip install` even when node_modules or the venv are missing.
  [switch]$SkipInstall,
  # How long to wait for EACH server to answer. A first start (fresh virtualenv, Vite's first
  # dependency scan) on a busy PC took 158 s for FastAPI alone, so the default is generous.
  # The wait ends early when a server process exits.
  [ValidateRange(30, 7200)]
  [int]$WaitSeconds = 600
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$runDir = Join-Path $root ".run"
$backendDir = Join-Path $root "fastapi-backend"
$python = Join-Path $backendDir ".venv\Scripts\python.exe"
New-Item -ItemType Directory -Force $runDir | Out-Null

function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host "ERROR: $text" -ForegroundColor Red; exit 1 }

$supabase = $env:SUPABASE_CLI
if (-not $supabase) {
  $candidate = "C:\Users\gopal\tools\supabase\supabase.exe"
  if (Test-Path $candidate) { $supabase = $candidate } else { $supabase = "supabase" }
}

# Refuse to start twice.
foreach ($port in 5190, 8010) {
  $busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($busy) { Fail "Port $port is already in use (PID $($busy[0].OwningProcess)). Run scripts\stop-lifeops.ps1 first." }
}

Step "Checking Docker"
docker info --format "{{.ServerVersion}}" 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  $helper = "C:\Users\gopal\Downloads\start-docker-desktop.ps1"
  if (Test-Path $helper) {
    Fail "Docker Desktop is not running. Start it with: powershell -ExecutionPolicy Bypass -File $helper  (then run this script again)"
  }
  Fail "Docker Desktop is not running. Start Docker Desktop, then run this script again."
}

Step "Starting local Supabase (first run downloads images; this can take several minutes)"
Push-Location $root
try {
  # Its progress goes to stderr and stays visible; the status it prints on stdout at the end
  # holds the local keys, so it is dropped (write-local-env.mjs reads them without printing).
  & $supabase start --ignore-health-check | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "supabase start failed (exit $LASTEXITCODE)." }
  # `supabase start` runs the migrations only when it creates the database. On an existing
  # database (data kept by `supabase stop`) apply the ones added since; a no-op when none are.
  & $supabase migration up
  if ($LASTEXITCODE -ne 0) { Fail "supabase migration up failed (exit $LASTEXITCODE)." }
} finally { Pop-Location }

Step "Writing .env.local and fastapi-backend\.env"
Push-Location $root
try {
  node scripts\write-local-env.mjs
  if ($LASTEXITCODE -ne 0) { Fail "Could not write the env files." }
} finally { Pop-Location }

if (-not (Test-Path (Join-Path $root "node_modules"))) {
  if ($SkipInstall) { Fail "node_modules is missing. Run npm install." }
  Step "Installing npm packages (first run)"
  Push-Location $root
  try { npm install --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { Fail "npm install failed." } } finally { Pop-Location }
}

if (-not (Test-Path $python)) {
  if ($SkipInstall) { Fail "fastapi-backend\.venv is missing." }
  Step "Creating the FastAPI virtualenv (first run)"
  Push-Location $backendDir
  try {
    python -m venv .venv
    & $python -m pip install --disable-pip-version-check -q -r requirements-dev.txt
    if ($LASTEXITCODE -ne 0) { Fail "pip install failed." }
  } finally { Pop-Location }
}

Step "Making sure the local test user exists"
Push-Location $root
try {
  node scripts\create-test-user.mjs
  if ($LASTEXITCODE -ne 0) { Fail "Could not create the local test user." }
} finally { Pop-Location }

# The model and provider the web app will use (from .env.local; values other than these two
# are not read here).
$llmBase = ""; $llmModel = ""
foreach ($line in Get-Content (Join-Path $root ".env.local") -Encoding UTF8) {
  $clean = $line.TrimStart([char]0xFEFF)
  if ($clean -match '^\s*LLM_BASE_URL\s*=\s*(.*)$') { $llmBase = $Matches[1].Trim() }
  if ($clean -match '^\s*LLM_MODEL\s*=\s*(.*)$') { $llmModel = $Matches[1].Trim() }
}
if ($llmBase -match '(localhost|127\.0\.0\.1):11434') {
  Step "Checking the local AI model ($llmModel on Ollama, port 11434)"
  try {
    $tags = Invoke-RestMethod -Uri "http://localhost:11434/api/tags" -TimeoutSec 10
    $names = @($tags.models | ForEach-Object { $_.name })
    # Ollama lists "name:latest" for a model asked for as "name".
    $present = ($names -contains $llmModel) -or ($names -contains "${llmModel}:latest")
    $modelfile = Join-Path $root "ollama\$llmModel.Modelfile"
    if (-not $present -and (Test-Path $modelfile)) {
      # A local variant (for example qwen2.5-3b-4threads) is created from its Modelfile, not pulled.
      Write-Host "WARNING: Ollama is up but $llmModel is missing. Create it once (see the Modelfile):" -ForegroundColor Yellow
      Write-Host "  docker exec cvfix-ollama ollama pull qwen2.5:3b" -ForegroundColor Yellow
      Write-Host "  Get-Content ollama\$llmModel.Modelfile | docker exec -i cvfix-ollama sh -c `"cat > /tmp/Modelfile && ollama create $llmModel -f /tmp/Modelfile`"" -ForegroundColor Yellow
    } elseif (-not $present) {
      Write-Host "WARNING: Ollama is up but $llmModel is missing. Run: docker exec cvfix-ollama ollama pull $llmModel" -ForegroundColor Yellow
    } else {
      Write-Host "Ollama has $llmModel."
    }
  } catch {
    Write-Host "WARNING: Ollama is not reachable on http://localhost:11434. AI answers will fail until it runs (the planner service falls back to its keyword planner)." -ForegroundColor Yellow
  }
} else {
  Write-Host "AI provider: $llmBase (model $llmModel); not checked here."
}

Step "Starting the FastAPI planner on http://127.0.0.1:8010"
# Start a server in the background with its output in .run\*.log. It goes through cmd.exe and
# Start-Process WITHOUT -Redirect* switches, because with them PowerShell 5.1 starts the
# process with handle inheritance: the server then holds this script's own stdout open, and
# anything that reads this script's output through a pipe (`| Tee-Object`, CI, an agent)
# waits until the servers stop. The returned PID is cmd.exe; stop-lifeops.ps1 ends its tree.
function Start-Background($exe, [string[]]$arguments, $workDir, $logName) {
  $quoted = (@($exe) + $arguments | ForEach-Object { "`"$_`"" }) -join " "
  $out = Join-Path $runDir "$logName.log"
  $err = Join-Path $runDir "$logName.err.log"
  $commandLine = "/d /s /c `"$quoted > `"$out`" 2> `"$err`"`""
  Start-Process -FilePath "cmd.exe" -ArgumentList $commandLine -WorkingDirectory $workDir -WindowStyle Hidden -PassThru
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Fail "node is not on PATH." }

$fastapi = Start-Background $python @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8010") $backendDir "fastapi"

Step "Starting the web app on http://localhost:5190"
$vite = Start-Background $node @("$root\node_modules\vite\bin\vite.js", "dev") $root "web"

@{ fastapi = $fastapi.Id; web = $vite.Id; started = (Get-Date).ToString("s") } |
  ConvertTo-Json | Set-Content -Encoding ascii (Join-Path $runDir "pids.json")

# Wait until $url answers, the server process exits, or $seconds pass. Returns "up", "exited"
# or "timeout" and prints a progress line every 30 s, so a slow first start does not look hung.
function Wait-Server($name, $url, $process, [int]$seconds) {
  $started = Get-Date
  $deadline = $started.AddSeconds($seconds)
  $nextNote = $started.AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    if ($process.HasExited) { return "exited" }
    try {
      $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -lt 500) {
        Write-Host ("    {0} is up after {1:N0} s" -f $name, ((Get-Date) - $started).TotalSeconds)
        return "up"
      }
    } catch { Start-Sleep -Seconds 2 }
    if ((Get-Date) -ge $nextNote) {
      Write-Host ("    still waiting for {0} ({1:N0} s of at most {2} s)" -f $name, ((Get-Date) - $started).TotalSeconds, $seconds)
      $nextNote = (Get-Date).AddSeconds(30)
    }
  }
  return "timeout"
}

# On failure, stop what this run started (Supabase keeps running), so the next run is not
# refused with "port already in use", and show the end of the server's logs.
function Fail-Server($name, $state, [string[]]$logs) {
  Write-Host ""
  foreach ($log in $logs) {
    $path = Join-Path $runDir $log
    if (Test-Path $path) {
      Write-Host "--- last lines of .run\$log ---" -ForegroundColor Yellow
      Get-Content $path -Tail 15 | ForEach-Object { Write-Host "    $_" }
    }
  }
  Write-Host "Stopping the servers this run started (Supabase stays up)..." -ForegroundColor Yellow
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "stop-lifeops.ps1") -KeepSupabase | Out-Host
  if ($state -eq "exited") {
    $why = "stopped on its own"
  } else {
    $why = "did not answer within $WaitSeconds s (on a very busy PC rerun with -WaitSeconds 1200)"
  }
  Fail "$name $why. See .run\$($logs[0])"
}

Step "Waiting for both servers (up to $WaitSeconds s each)"
$state = Wait-Server "FastAPI planner" "http://127.0.0.1:8010/" $fastapi $WaitSeconds
if ($state -ne "up") { Fail-Server "The FastAPI planner" $state @("fastapi.err.log", "fastapi.log") }
$state = Wait-Server "web app" "http://localhost:5190/login" $vite $WaitSeconds
if ($state -ne "up") { Fail-Server "The web app" $state @("web.err.log", "web.log") }

Write-Host ""
Write-Host "LifeOps AI is running:" -ForegroundColor Green
Write-Host "  Web app          http://localhost:5190            (sign in with .local-test-user.json)"
Write-Host "  Planner API      http://127.0.0.1:8010/docs"
Write-Host "  Supabase Studio  http://127.0.0.1:55323"
Write-Host "  Mailpit          http://127.0.0.1:55324"
Write-Host "Stop everything with: powershell -ExecutionPolicy Bypass -File scripts\stop-lifeops.ps1"
