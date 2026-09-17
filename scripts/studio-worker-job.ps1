param([ValidateSet('Broker', 'Launch', 'Library')][string]$Mode = 'Broker')
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
Add-Type -Path (Join-Path $PSScriptRoot 'studio-worker-job.cs')
if ($Mode -eq 'Library') { return }
$job = $null
$eof = $false
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
                $job.Drain(600000, 30000, [string[]]@('RobloxStudioInstaller.exe', 'RobloxPlayerInstaller.exe'))
                Write-WorkerResponse @{ drained = $true }
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
            $job.Drain(600000, 30000, [string[]]@('RobloxStudioInstaller.exe', 'RobloxPlayerInstaller.exe'))
        }
    }
} catch {
    if (-not $eof) { Write-WorkerResponse @{ error = $_.Exception.ToString() } }
    exit 1
} finally {
    if ($null -ne $job) { $job.Dispose() }
}
