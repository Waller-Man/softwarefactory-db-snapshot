param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('check', 'import', 'verify', 'export')][string]$Mode,
    [Parameter(Mandatory = $true)][string]$Url,
    [string]$Graph = 'hugegraph',
    [string]$File,
    [string]$Out
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskArguments = @((Join-Path $PSScriptRoot 'snapshot.ts'), $Mode, '--url', $Url, '--graph', $Graph, '--credentials-stdin')
if ($Mode -eq 'import') { $taskArguments += '--apply' }
if ($File) { $taskArguments += @('--file', $File) }
if ($Out) { $taskArguments += @('--out', $Out) }
$taskUsername = Read-Host 'HugeGraph username (Enter = admin)'
if ([string]::IsNullOrWhiteSpace($taskUsername)) { $taskUsername = 'admin' }
$taskSecurePassword = Read-Host 'HugeGraph password (hidden)' -AsSecureString
$taskPasswordPointer = [IntPtr]::Zero
$taskCredentialJson = $null
$taskOldEncoding = $OutputEncoding
try {
    $taskPasswordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecurePassword)
    $taskCredentialJson = @{
        username = $taskUsername
        password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPasswordPointer)
    } | ConvertTo-Json -Compress
    # Credentials travel through stdin, not command-line arguments, files, or logs.
    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $taskCredentialJson | & node @taskArguments
    if ($LASTEXITCODE -ne 0) { throw "Snapshot command failed (exit $LASTEXITCODE). Read the error above." }
} finally {
    $OutputEncoding = $taskOldEncoding
    if ($taskPasswordPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPasswordPointer) }
    $taskCredentialJson = $null
    if ($taskSecurePassword) { $taskSecurePassword.Dispose() }
}
