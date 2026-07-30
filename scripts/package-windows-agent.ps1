[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$')]
  [string] $Version
)

$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runnerPack = Join-Path $workspace 'apps\runner\dist-pack'
$manifestPath = Join-Path $runnerPack 'runner-tarball.json'
$stageRoot = Join-Path $workspace 'dist-agent\windows'
$payload = Join-Path $stageRoot 'payload'
$installerOutput = Join-Path $stageRoot 'installer'
$appPayload = Join-Path $payload 'app'

if (-not (Test-Path $manifestPath)) {
  throw 'Runner tarball is missing. Build and pack @norns/runner first.'
}

$manifest = Get-Content -Raw $manifestPath | ConvertFrom-Json
$tarball = Join-Path $runnerPack $manifest.filename
if (-not (Test-Path $tarball)) {
  throw "Runner tarball $($manifest.filename) is missing."
}

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $stageRoot
New-Item -ItemType Directory -Force -Path $payload, $installerOutput, $appPayload | Out-Null

& npm install --prefix $appPayload --omit=dev --no-audit --no-fund $tarball
if ($LASTEXITCODE -ne 0) { throw 'Installing the runner payload failed.' }

$runtime = Join-Path $payload 'runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
Copy-Item -Force (Get-Command node.exe).Source (Join-Path $runtime 'node.exe')

$minGitUrl = 'https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.3/MinGit-2.55.0.3-64-bit.zip'
$minGitSha256 = 'f48e2d2dc74a24454adc6d8fd0ac25bf9c2386f19cfb06202b9465aaad4f9f05'
$minGitArchive = Join-Path $stageRoot 'mingit.zip'
Invoke-WebRequest -Uri $minGitUrl -OutFile $minGitArchive
$actualMinGitSha256 = (Get-FileHash -Algorithm SHA256 $minGitArchive).Hash.ToLowerInvariant()
if ($actualMinGitSha256 -ne $minGitSha256) {
  throw "MinGit digest mismatch: expected $minGitSha256, received $actualMinGitSha256"
}
Expand-Archive -Path $minGitArchive -DestinationPath (Join-Path $payload 'git')
Remove-Item -Force $minGitArchive

Copy-Item -Force (Join-Path $workspace 'packaging\windows\start-agent.vbs') $payload
Copy-Item -Force (Join-Path $workspace 'packaging\windows\stop-agent.vbs') $payload
Copy-Item -Force (Join-Path $workspace 'packaging\windows\open-control-center.vbs') $payload
Copy-Item -Force (Join-Path $workspace 'packaging\windows\open-control-center.ps1') $payload
Copy-Item -Force (Join-Path $workspace 'packaging\windows\NornsLocalAgent.ico') $payload

$isccCommand = Get-Command iscc.exe -ErrorAction SilentlyContinue
$isccPath = if ($isccCommand) { $isccCommand.Source } else { $null }
if (-not $isccPath) {
  $fallback = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
  if (Test-Path $fallback) { $isccPath = $fallback }
}
if (-not $isccPath) { throw 'Inno Setup 6 is required to build the installer.' }

& $isccPath "/DMyAppVersion=$Version" (Join-Path $workspace 'packaging\windows\NornsLocalAgent.iss')
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup failed.' }

$installer = Join-Path $installerOutput 'Norns-Local-Agent-Setup.exe'
if (-not (Test-Path $installer)) { throw 'Installer output is missing.' }
$digest = (Get-FileHash -Algorithm SHA256 $installer).Hash.ToLowerInvariant()
Write-Host "Built $installer"
Write-Host "SHA256 $digest"
