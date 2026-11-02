# Connects this computer to the emulated MAXINE, once. The adapter and its address survive a reboot.
# Needs an administrator PowerShell, and TAP-Windows installed in its default folder.
param([string]$ErrorFile)
$ErrorActionPreference = 'Stop'

trap {
    if ($ErrorFile) { Set-Content -LiteralPath $ErrorFile -Value $_.Exception.Message -ErrorAction SilentlyContinue }
    Write-Host "Couldn't start the network: $($_.Exception.Message)"
    exit 1
}

$Name = 'MAXINE Emulator'
$Tap = Join-Path $env:ProgramFiles 'TAP-Windows'
$TapInstall = Join-Path $Tap 'bin\tapinstall.exe'

if (-not (Get-NetAdapter -Name $Name -ErrorAction SilentlyContinue)) {
    if (-not (Test-Path -LiteralPath $TapInstall)) { throw "TAP-Windows isn't installed in $Tap." }

    # Always a new adapter. An existing one could belong to a VPN, so it's never renamed.
    $before = @(Get-NetAdapter | ForEach-Object { $_.InterfaceGuid })
    & $TapInstall install (Join-Path $Tap 'driver\OemVista.inf') tap0901 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "tapinstall failed with exit code $LASTEXITCODE." }

    $new = @()
    foreach ($attempt in 1..40) {
        $new = @(Get-NetAdapter | Where-Object { $before -notcontains $_.InterfaceGuid })
        if ($new.Count -gt 0) { break }
        Start-Sleep -Milliseconds 250
    }
    if ($new.Count -ne 1) { throw "Expected one new network adapter, and found $($new.Count)." }
    $new[0] | Rename-NetAdapter -NewName $Name
}

& netsh interface ipv4 set address $Name static 10.37.0.1 255.255.255.0 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "netsh failed with exit code $LASTEXITCODE." }

# In active FTP the MAXINE connects back to this computer, and Windows treats this as a public network
Get-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $Name -Direction Inbound -Action Allow -InterfaceAlias $Name | Out-Null

Write-Host "This computer is 10.37.0.1 on $Name. Start the emulator and reach the MAXINE at 10.37.0.2."
