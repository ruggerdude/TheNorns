$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
Add-Type -TypeDefinition @'
using System;

public static class NornsNativeLaunchCrypto
{
    public static bool FixedTimeEquals(byte[] left, byte[] right)
    {
        if (left == null || right == null || left.Length != right.Length)
            return false;
        int difference = 0;
        for (int index = 0; index < left.Length; index++)
            difference |= left[index] ^ right[index];
        return difference == 0;
    }
}
'@

function ConvertFrom-Base64Url([string] $Value) {
  if ($Value -notmatch '^[A-Za-z0-9_-]{43}$') {
    throw 'Malformed base64url value.'
  }
  $base64 = $Value.Replace('-', '+').Replace('_', '/')
  $base64 += '=' * ((4 - ($base64.Length % 4)) % 4)
  return [Convert]::FromBase64String($base64)
}

function ConvertTo-Base64Url([byte[]] $Value) {
  return [Convert]::ToBase64String($Value).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-RandomIdentifier {
  $bytes = New-Object byte[] 32
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  } finally {
    $generator.Dispose()
  }
  return ConvertTo-Base64Url $bytes
}

function New-NativeLaunchTranscript(
  [string] $Purpose,
  [array] $Fields
) {
  $transcript = $Purpose + "`n"
  foreach ($field in $Fields) {
    $length = [System.Text.Encoding]::UTF8.GetByteCount([string] $field[1])
    $transcript += ([string] $field[0]) + ':' + $length + ':' + ([string] $field[1]) + "`n"
  }
  return $transcript
}

function Get-HmacProof(
  [byte[]] $Key,
  [string] $Transcript
) {
  $hmac = [System.Security.Cryptography.HMACSHA256]::new($Key)
  try {
    return ConvertTo-Base64Url $hmac.ComputeHash(
      [System.Text.Encoding]::UTF8.GetBytes($Transcript)
    )
  } finally {
    $hmac.Dispose()
  }
}

function Request-ControlCenter([string] $DiscoveryFile) {
  $discovery = Get-Content -LiteralPath $DiscoveryFile -Raw | ConvertFrom-Json
  if (
    $discovery.version -ne 1 -or
    $discovery.host -notin @('127.0.0.1', '::1') -or
    $discovery.port -isnot [int] -or
    $discovery.port -lt 1 -or
    $discovery.port -gt 65535 -or
    $discovery.native_launch_secret -notmatch '^[A-Za-z0-9_-]{43}$'
  ) {
    throw 'Malformed AgentHost discovery.'
  }

  $expectedOrigin = if ($discovery.host -eq '::1') {
    "http://[::1]:$($discovery.port)"
  } else {
    "http://127.0.0.1:$($discovery.port)"
  }
  if ($discovery.origin -cne $expectedOrigin) {
    throw 'AgentHost discovery origin changed.'
  }

  $key = ConvertFrom-Base64Url ([string] $discovery.native_launch_secret)
  if ($key.Length -ne 32) {
    throw 'Malformed native launch key.'
  }
  $requestId = New-RandomIdentifier
  $requestTranscript = New-NativeLaunchTranscript `
    'norns:agent-host-native-launch-request:v1' `
    @(
      @('origin', $expectedOrigin),
      @('request_id', $requestId)
    )
  $requestProof = Get-HmacProof $key $requestTranscript
  $body = @{
    request_id = $requestId
    request_proof = $requestProof
  } | ConvertTo-Json -Compress

  $handler = [System.Net.Http.HttpClientHandler]::new()
  $handler.UseProxy = $false
  $client = [System.Net.Http.HttpClient]::new($handler)
  try {
    $client.Timeout = [TimeSpan]::FromSeconds(1)
    $endpoint = [Uri]::new("$expectedOrigin/api/session/native-launch")
    $request = [System.Net.Http.HttpRequestMessage]::new(
      [System.Net.Http.HttpMethod]::Post,
      $endpoint
    )
    $request.Headers.Host = $endpoint.Authority
    [void] $request.Headers.TryAddWithoutValidation('Origin', $expectedOrigin)
    $request.Content = [System.Net.Http.StringContent]::new(
      $body,
      [System.Text.Encoding]::UTF8,
      'application/json'
    )
    $response = $client.SendAsync($request).GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) {
      throw 'Native launch request was refused.'
    }
    $responseText = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    if ([System.Text.Encoding]::UTF8.GetByteCount($responseText) -gt 8192) {
      throw 'Native launch response was too large.'
    }
    $launch = $responseText | ConvertFrom-Json
  } finally {
    $client.Dispose()
    $handler.Dispose()
  }

  $bootstrap = [Uri]::new([string] $launch.bootstrap_url)
  if (
    $bootstrap.Scheme -cne 'http' -or
    $bootstrap.GetLeftPart([System.UriPartial]::Authority) -cne $expectedOrigin -or
    $bootstrap.AbsolutePath -cne '/' -or
    -not [string]::IsNullOrEmpty($bootstrap.Query) -or
    $bootstrap.Fragment -notmatch '^#bootstrap=[A-Za-z0-9_%=-]+$' -or
    $launch.response_proof -notmatch '^[A-Za-z0-9_-]{43}$'
  ) {
    throw 'Malformed native launch response.'
  }

  $responseTranscript = New-NativeLaunchTranscript `
    'norns:agent-host-native-launch-response:v1' `
    @(
      @('origin', $expectedOrigin),
      @('request_id', $requestId),
      @('bootstrap_url', [string] $launch.bootstrap_url)
    )
  $expectedProof = ConvertFrom-Base64Url (Get-HmacProof $key $responseTranscript)
  $actualProof = ConvertFrom-Base64Url ([string] $launch.response_proof)
  if (-not [NornsNativeLaunchCrypto]::FixedTimeEquals($actualProof, $expectedProof)) {
    throw 'Native launch response proof was invalid.'
  }
  return $bootstrap.AbsoluteUri
}

$appDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$startScript = Join-Path $appDirectory 'start-agent.vbs'
$dataDirectory = Join-Path (Join-Path $env:LOCALAPPDATA 'Norns') 'runner-1'
$discoveryFile = Join-Path $dataDirectory 'agent-host.json'

if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) {
  exit 2
}

Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') `
  -ArgumentList ('"' + $startScript + '"') `
  -WindowStyle Hidden `
  -Wait

for ($attempt = 0; $attempt -lt 50; $attempt += 1) {
  if (Test-Path -LiteralPath $discoveryFile -PathType Leaf) {
    try {
      $bootstrapUrl = Request-ControlCenter $discoveryFile
      $shell = New-Object -ComObject Shell.Application
      $shell.ShellExecute($bootstrapUrl)
      exit 0
    } catch {
      # A stale file, dead port, or invalid response proof is not authoritative.
      # Re-read until the newly started AgentHost publishes authenticated state.
    }
  }
  Start-Sleep -Milliseconds 100
}

exit 3
