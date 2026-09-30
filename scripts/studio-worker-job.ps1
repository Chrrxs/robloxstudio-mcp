param([ValidateSet('Broker', 'Launch', 'Library')][string]$Mode = 'Broker')
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
Add-Type -Path (Join-Path $PSScriptRoot 'studio-worker-job.cs')
# BITS runs jobs only for owners with an interactive logon; the dedicated test
# account runs through secondary logon, so an installer's BITS downloads never
# start. Stalled means every download created during this worker's lifetime is
# in a waiting state without transferred bytes; any progress or live transfer
# (for example when the account is also signed in interactively) is healthy.
$StalledDownloadStates = @('Suspended', 'Queued', 'TransientError', 'Error')
function Get-StalledStudioDownloads([object[]]$Jobs, [DateTime]$SinceUtc) {
    $recent = @($Jobs | Where-Object { $null -ne $_ -and $_.CreationTime.ToUniversalTime() -ge $SinceUtc })
    if ($recent.Count -eq 0) { return @() }
    foreach ($download in $recent) {
        $bytes = [UInt64]$download.BytesTransferred
        if ($StalledDownloadStates -notcontains [string]$download.JobState -or ($bytes -ne 0 -and $bytes -ne [UInt64]::MaxValue)) { return @() }
    }
    return $recent
}
if ($Mode -eq 'Library') { return }
$job = $null
$eof = $false
$brokerStartedUtc = [DateTime]::UtcNow
$installerNames = [string[]]@('RobloxStudioInstaller.exe', 'RobloxPlayerInstaller.exe')
$updateBlocked = [Func[bool]]{ @(Get-StalledStudioDownloads -Jobs @(Get-BitsTransfer -ErrorAction Stop) -SinceUtc $brokerStartedUtc).Count -gt 0 }
function Invoke-WorkerDrain {
    $deferred = $job.Drain(600000, 30000, $installerNames, $updateBlocked, 60000)
    if (-not $deferred) { return @{ drained = $true } }
    # The installer is terminated; remove only its stalled downloads so they
    # cannot accumulate toward the account's BITS job quota.
    try {
        $stalled = @(Get-StalledStudioDownloads -Jobs @(Get-BitsTransfer -ErrorAction Stop) -SinceUtc $brokerStartedUtc)
        foreach ($download in $stalled) { Remove-BitsTransfer -BitsJob $download -ErrorAction Stop }
        return @{ drained = $true; deferredUpdate = $true; removedDownloads = $stalled.Count }
    } catch {
        return @{ drained = $true; deferredUpdate = $true; removedDownloads = 0; downloadCleanupError = $_.Exception.Message }
    }
}
function Write-WorkerResponse($value) {
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $value -Compress -Depth 8))
    [Console]::Out.Flush()
}
try {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { throw 'Missing Studio worker configuration' }
    $configuration = ConvertFrom-Json -InputObject $line
    if ($Mode -eq 'Launch') {
        $job = [StudioWorkerJob]::Open([string]$configuration.name)
        foreach ($property in $configuration.environment.PSObject.Properties) {
            if ($property.Name -match '[=\x00]' -or [string]::IsNullOrEmpty($property.Name)) { throw 'Invalid worker launch environment name' }
            [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, [EnvironmentVariableTarget]::Process)
        }
        $processId = $job.Launch([string]$configuration.executable, [string[]]$configuration.args, [string]$configuration.cwd)
        Write-WorkerResponse @{ pid = $processId }
    } else {
        $job = [StudioWorkerJob]::Create([string]$configuration.name, $true)
        Write-WorkerResponse @{ ready = $true; name = $configuration.name }
        $drainAttempted = $false
        while ($null -ne ($line = [Console]::In.ReadLine())) {
            try {
                $request = ConvertFrom-Json -InputObject $line
                if ($request.op -ne 'drain') { throw 'Unknown Studio worker operation' }
                $drainAttempted = $true
                Write-WorkerResponse (Invoke-WorkerDrain)
                break
            } catch {
                # Keep the ownership handle while the caller decides how to report/abort.
                Write-WorkerResponse @{ error = $_.Exception.ToString() }
            }
        }
        # Ordinary parent exit is EOF, not cancellation. The outer harness job
        # still kills this broker immediately on cancellation. Do not repeat a
        # failed explicit drain or extend its already-consumed grace budget.
        if (-not $drainAttempted) {
            $eof = $true
            $null = Invoke-WorkerDrain
        }
    }
} catch {
    if (-not $eof) { Write-WorkerResponse @{ error = $_.Exception.ToString() } }
    exit 1
} finally {
    if ($null -ne $job) { $job.Dispose() }
}
