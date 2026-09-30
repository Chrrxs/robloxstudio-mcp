# Windows only. Exercises the worker broker's blocked-update classification and
# StudioWorkerJob.Drain with PING.EXE as a stand-in installer; no Studio,
# installer, or BITS job is created or modified.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\studio-worker-job.ps1') -Mode Library
$checks = 0
function Assert($condition, $message) {
    if (-not $condition) { throw "Assertion failed: $message" }
    $script:checks++
}

# Classification: only this worker's downloads count, and any progress or live
# transfer is healthy. MaxValue is BITS's "unknown" byte count.
$since = [DateTime]::UtcNow
function Download($state, $bytes, $ageSeconds = 0) {
    [pscustomobject]@{ JobState = $state; BytesTransferred = [UInt64]$bytes; CreationTime = $since.AddSeconds($ageSeconds).ToLocalTime() }
}
Assert (@(Get-StalledStudioDownloads -Jobs @() -SinceUtc $since).Count -eq 0) 'no downloads is not stalled'
Assert (@(Get-StalledStudioDownloads -Jobs @((Download 'Suspended' 0 1), (Download 'Queued' ([UInt64]::MaxValue) 2)) -SinceUtc $since).Count -eq 2) 'waiting downloads without progress are stalled'
Assert (@(Get-StalledStudioDownloads -Jobs @((Download 'Suspended' 0 1), (Download 'Transferring' 0 1)) -SinceUtc $since).Count -eq 0) 'a live transfer is healthy'
Assert (@(Get-StalledStudioDownloads -Jobs @((Download 'Suspended' 0 1), (Download 'Queued' 4096 1)) -SinceUtc $since).Count -eq 0) 'any progress is healthy'
Assert (@(Get-StalledStudioDownloads -Jobs @((Download 'Suspended' 0 -60)) -SinceUtc $since).Count -eq 0) 'older downloads belong to another worker'
Assert (@(Get-StalledStudioDownloads -Jobs @((Download 'Transferred' 100 1)) -SinceUtc $since).Count -eq 0) 'completed downloads are healthy'

$ping = Join-Path $env:SystemRoot 'System32\PING.EXE'
function Invoke-Drain([scriptblock]$Blocked, [int]$GraceMs, [int]$ConfirmMs) {
    $job = [StudioWorkerJob]::Create(('Local\RsmcpStudioWorker-' + [Guid]::NewGuid().ToString('N')), $false)
    try {
        $processId = $job.Launch($ping, [string[]]@('-n', '120', '127.0.0.1'), $env:SystemRoot)
        $process = [Diagnostics.Process]::GetProcessById($processId)
        $null = $process.Handle
        $clock = [Diagnostics.Stopwatch]::StartNew()
        try {
            $deferred = $job.Drain($GraceMs, 30000, [string[]]@('PING.EXE'), [Func[bool]]$Blocked, $ConfirmMs)
            $outcome = @{ deferred = $deferred }
        } catch {
            $outcome = @{ error = $_.Exception.GetBaseException().Message }
        }
        $outcome.elapsed = $clock.ElapsedMilliseconds
        $outcome.exited = $process.WaitForExit(15000)
        return $outcome
    } finally { $job.Dispose() }
}

# A continuously blocked update ends after confirmation, well before the grace.
$result = Invoke-Drain { $true } 600000 3000
Assert ($result.deferred -eq $true) "blocked update is deferred: $($result | ConvertTo-Json -Compress)"
Assert ($result.elapsed -ge 3000 -and $result.elapsed -lt 20000) "deferral waits for confirmation only: $($result.elapsed)ms"
Assert $result.exited 'the blocked installer is terminated'

# Healthy, unverifiable, and intermittently blocked updates keep the ordinary grace.
foreach ($case in @(
    @{ name = 'healthy'; blocked = { $false } },
    @{ name = 'predicate failure'; blocked = { throw 'BITS unavailable' } },
    @{ name = 'intermittent'; blocked = { $script:toggle = -not $script:toggle; $script:toggle } }
)) {
    $script:toggle = $false
    $result = Invoke-Drain $case.blocked 7000 5000
    Assert ($result.error -match 'did not finish within worker grace') "$($case.name) keeps the grace: $($result | ConvertTo-Json -Compress)"
    Assert ($result.elapsed -ge 7000) "$($case.name) waited for the full grace: $($result.elapsed)ms"
}

# Confirmation must lie within the grace.
$job = [StudioWorkerJob]::Create(('Local\RsmcpStudioWorker-' + [Guid]::NewGuid().ToString('N')), $false)
try {
    $rejected = $false
    try { $null = $job.Drain(1000, 30000, [string[]]@('PING.EXE'), [Func[bool]]{ $true }, 2000) } catch { $rejected = $true }
    Assert $rejected 'confirmation longer than the grace is rejected'
} finally { $job.Dispose() }

Write-Output "Blocked Studio update drain native regressions passed ($checks checks)"
