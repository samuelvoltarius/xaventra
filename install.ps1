# Native Windows PowerShell / PowerShell 7 entry point. No admin required.
[CmdletBinding()]
param([switch]$Check, [switch]$ConfigureOnly, [switch]$Desktop, [switch]$Browser, [switch]$Native)
$ErrorActionPreference = 'Stop'
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) {
    throw 'Install Node.js 22+ with npm from https://nodejs.org, reopen PowerShell, then run install.ps1 again.'
}
$setupArgs = @()
if ($Check) { $setupArgs += '--check' }
if ($ConfigureOnly) { $setupArgs += '--configure-only' }
if ($Desktop) { $setupArgs += '--desktop' }
if ($Browser) { $setupArgs += '--browser' }
if ($Native) { $setupArgs += '--native' }
& $node.Source (Join-Path $PSScriptRoot 'scripts/setup.mjs') @setupArgs
exit $LASTEXITCODE
