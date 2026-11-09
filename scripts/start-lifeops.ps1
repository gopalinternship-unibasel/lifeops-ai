<#
.SYNOPSIS
  Starts the whole LifeOps AI (MONDAY) stack on this PC.

.DESCRIPTION
  1. Local Supabase (Docker) on ports 55320-55329 with the migrations in supabase/migrations.
  2. Writes .env.local and fastapi-backend/.env from `supabase status` (no secrets printed).
  3. Installs npm packages and the FastAPI virtualenv on first run.
  4. Creates the local test user (.local-test-user.json) if it does not exist.
  5. Starts the FastAPI planner on http://127.0.0.1:8010 and the web app on http://localhost:5190
     in the background. Logs go to .run\*.log, process ids to .run\pids.json.
  Stop everything with scripts\stop-lifeops.ps1.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\start-lifeops.ps1
#>
[CmdletBinding()]
param(
  # Skip `npm install` / `pip install` even when node_modules or the venv are missing.
  [switch]$SkipInstall
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
  & $supabase start --ignore-health-check
  if ($LASTEXITCODE -ne 0) { Fail "supabase start failed (exit $LASTEXITCODE)." }
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
    if ($names -notcontains $llmModel) {
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

function Wait-Http($url, $seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -lt 500) { return $true }
    } catch { Start-Sleep -Seconds 2 }
  }
  return $false
}

Step "Waiting for both servers"
if (-not (Wait-Http "http://127.0.0.1:8010/" 90)) { Fail "FastAPI did not come up. See .run\fastapi.err.log" }
if (-not (Wait-Http "http://localhost:5190/login" 180)) { Fail "The web app did not come up. See .run\web.log and .run\web.err.log" }

Write-Host ""
Write-Host "LifeOps AI is running:" -ForegroundColor Green
Write-Host "  Web app          http://localhost:5190            (sign in with .local-test-user.json)"
Write-Host "  Planner API      http://127.0.0.1:8010/docs"
Write-Host "  Supabase Studio  http://127.0.0.1:55323"
Write-Host "  Mailpit          http://127.0.0.1:55324"
Write-Host "Stop everything with: powershell -ExecutionPolicy Bypass -File scripts\stop-lifeops.ps1"
