Set-StrictMode -Version Latest

function Install-NornsHelper {
  [CmdletBinding()]
  param(
    [string] $Server = $env:NORNS_SERVER,
    [string] $Pair = '',
    [string] $Id = 'runner-1',
    [switch] $Uninstall
  )
  $ErrorActionPreference = 'Stop'
  $root = if ($env:NORNS_HOME) { $env:NORNS_HOME } else { Join-Path $HOME '.norns' }
  $source = if ($env:NORNS_HELPER_SOURCE) { $env:NORNS_HELPER_SOURCE } else { 'https://github.com/ruggerdude/TheNorns.git' }
  $ref = if ($env:NORNS_HELPER_REF) { $env:NORNS_HELPER_REF } else { 'main' }
  $src = Join-Path $root 'helper'
  $data = Join-Path $root $Id
  $startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
  $launcher = Join-Path $startup 'TheNorns Helper.cmd'

  if ($Uninstall) {
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
      Where-Object { $_.CommandLine -and $_.CommandLine.Contains('apps\runner\dist\cli.js') } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Remove-Item -Force -ErrorAction SilentlyContinue $launcher
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $src
    Write-Host "The Norns helper was removed. Pairing keys remain in $data."
    return
  }

  if ($Server -notmatch '^https?://') { throw 'A valid -Server URL is required.' }
  if ($Id -notmatch '^[A-Za-z0-9._-]+$') { throw 'Invalid helper id.' }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git is required.' }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 24 or newer is required.' }
  $major = [int](& node -p 'process.versions.node.split(".")[0]')
  if ($major -lt 24) { throw 'Node.js 24 or newer is required.' }

  New-Item -ItemType Directory -Force -Path $root | Out-Null
  if (Test-Path (Join-Path $src '.git')) {
    git -C $src fetch --depth 1 origin $ref
    git -C $src checkout --detach FETCH_HEAD
  } else {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $src
    git clone --depth 1 --branch $ref $source $src
  }
  Push-Location $src
  try {
    if (Get-Command corepack -ErrorAction SilentlyContinue) {
      corepack enable
      corepack prepare pnpm@11.13.0 --activate
    }
    pnpm install --frozen-lockfile --filter '@norns/runner...'
    pnpm --filter '@norns/runner...' run build
  } finally { Pop-Location }

  $cli = Join-Path $src 'apps\runner\dist\cli.js'
  if (-not (Test-Path $cli)) { throw 'Helper build failed.' }
  if ($Pair) {
    & node $cli pair $Pair --server $Server --id $Id --data $data
  } elseif (-not (Test-Path (Join-Path $data 'runner-state.json'))) {
    throw 'Copy a fresh setup command from The Norns; its pairing code is required.'
  }

  New-Item -ItemType Directory -Force -Path $startup | Out-Null
  $node = (Get-Command node).Source
  Set-Content -Encoding ASCII -Path $launcher -Value "@echo off`r`nstart `"`" /b `"$node`" `"$cli`" start --server `"$Server`" --id `"$Id`" --data `"$data`""
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $launcher -WindowStyle Hidden
  Write-Host 'The Norns helper is ready. Return to the browser and choose your folder.'
}
