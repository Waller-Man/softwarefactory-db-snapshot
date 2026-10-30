param(
    [Parameter(Mandatory = $true)][string]$Url,
    [string]$Graph = 'hugegraph',
    [string]$File = (Join-Path $PSScriptRoot 'data/current/graph-backup.json'),
    [switch]$Apply,
    [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
if ($Apply -and $VerifyOnly) { throw 'Choose either -Apply or -VerifyOnly.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 24+ first.' }
$taskMajor = [int]((& node --version).TrimStart('v').Split('.')[0])
if ($taskMajor -lt 24) { throw 'Node.js 24+ is required.' }
$taskMode = 'check'
if ($VerifyOnly) { $taskMode = 'verify' }
Write-Host "Target: $Url / DEFAULT/$Graph"
Write-Host "Snapshot: $File"
if ($Apply) {
    $taskConfirmation = "IMPORT DEFAULT/$Graph @ $Url"
    Write-Host 'Missing Schema, vertices and edges will be created. Existing conflicts cause a stop.'
    $taskAnswer = Read-Host "Type exactly [$taskConfirmation] to continue"
    if ($taskAnswer -cne $taskConfirmation) { throw 'Import cancelled; no database changes were made.' }
    $taskMode = 'import'
}
& (Join-Path $PSScriptRoot 'scripts/Invoke-Snapshot.ps1') -Mode $taskMode -Url $Url -Graph $Graph -File $File
