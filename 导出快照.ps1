param(
    [string]$Url = 'http://127.0.0.1:18080',
    [string]$Graph = 'hugegraph',
    [string]$Out = (Join-Path $PSScriptRoot ('data/export-' + (Get-Date -Format 'yyyyMMdd-HHmmss')))
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 24+ first.' }
$taskMajor = [int]((& node --version).TrimStart('v').Split('.')[0])
if ($taskMajor -lt 24) { throw 'Node.js 24+ is required.' }
& (Join-Path $PSScriptRoot 'scripts/Invoke-Snapshot.ps1') -Mode export -Url $Url -Graph $Graph -Out $Out
