# Removes what net-up.ps1 made: only its adapter and firewall rule. Other TAP adapters and the driver stay.
# Stop the emulator first. Needs an administrator PowerShell.
param([string]$ErrorFile)
$ErrorActionPreference = 'Stop'

trap {
    if ($ErrorFile) { Set-Content -LiteralPath $ErrorFile -Value $_.Exception.Message -ErrorAction SilentlyContinue }
    Write-Host "Couldn't stop the network: $($_.Exception.Message)"
    exit 1
}

$Name = 'MAXINE Emulator'

Get-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule

$adapter = Get-NetAdapter -Name $Name -ErrorAction SilentlyContinue
if ($adapter) {
    & pnputil /remove-device $adapter.PnPDeviceID | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "pnputil failed with exit code $LASTEXITCODE." }
}

Write-Host "Removed $Name."
