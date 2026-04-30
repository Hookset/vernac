Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$backgroundPath = Join-Path $root 'background.js'
$sharedPath = Join-Path $root 'shared/messages.js'

function Get-MsgConstants {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  $text = Get-Content -Raw -LiteralPath $Path
  $match = [regex]::Match($text, "const\s+MSG\s*=\s*\{(?<body>[\s\S]*?)\n\};")
  if (-not $match.Success) {
    throw "Could not find MSG object in $Path"
  }

  $constants = [ordered]@{}
  foreach ($line in ($match.Groups['body'].Value -split "`r?`n")) {
    $entry = [regex]::Match($line, "^\s*([A-Z0-9_]+)\s*:\s*['""]([^'""]+)['""]\s*,?\s*(?://.*)?$")
    if (-not $entry.Success) { continue }

    $key = $entry.Groups[1].Value
    $value = $entry.Groups[2].Value
    $constants[$key] = $value
  }

  if ($constants.Count -eq 0) {
    throw "No MSG constants found in $Path"
  }

  return $constants
}

$background = Get-MsgConstants -Path $backgroundPath
$shared = Get-MsgConstants -Path $sharedPath
$errors = New-Object System.Collections.Generic.List[string]

foreach ($key in $background.Keys) {
  if (-not $shared.Contains($key)) {
    $errors.Add("shared/messages.js is missing $key")
  } elseif ($background[$key] -ne $shared[$key]) {
    $errors.Add("Value mismatch for ${key}: background='$($background[$key])' shared='$($shared[$key])'")
  }
}

foreach ($key in $shared.Keys) {
  if (-not $background.Contains($key)) {
    $errors.Add("background.js is missing $key")
  }
}

if ($errors.Count -gt 0) {
  Write-Error ("MSG constants drift detected:`n" + ($errors -join "`n"))
  exit 1
}

Write-Output "MSG constants are in sync ($($shared.Count) entries)."
