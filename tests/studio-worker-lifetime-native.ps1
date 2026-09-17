param([ValidateSet('Outer', 'Grace', 'Delete')][string]$Mode = 'Outer')
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot '..\scripts\studio-worker-job.ps1') -Mode Library
$config = ConvertFrom-Json -InputObject ([Console]::In.ReadLine())
function Reply($value) {
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $value -Compress))
    [Console]::Out.Flush()
}
if ($Mode -eq 'Delete') {
    try {
        [IO.Directory]::Delete([string]$config.directory, $true)
        Reply @{ removed = $true }
    } catch {
        $failure = $_.Exception
        while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
        Reply @{ removed = $false; hresult = $failure.HResult; error = $failure.Message }
    }
    exit 0
}
$job = [StudioWorkerJob]::Create(('Local\RsmcpStudioWorker-' + [Guid]::NewGuid().ToString('N')), ($Mode -ne 'Outer'))
try {
    $processId = $job.Launch([string]$config.executable, [string[]]$config.args, [string]$config.cwd)
    $process = [Diagnostics.Process]::GetProcessById($processId)
    try {
        $null = $process.Handle
        if ($Mode -eq 'Outer') {
            if (-not $process.WaitForExit(120000)) { throw 'Native worker fixture exceeded deadline' }
            $code = $process.ExitCode
            if ($null -eq $code) { throw 'Native worker fixture exit code was unavailable' }
            exit $code
        }
        Reply @{ pid = $processId }
        while ($null -ne ($line = [Console]::In.ReadLine())) {
            $request = ConvertFrom-Json -InputObject $line
            Reply @{ draining = $true }
            try {
                $job.Drain([int]$request.graceMs, 30000, [string[]]@([IO.Path]::GetFileName([string]$config.executable)))
                Reply @{ drained = $true }
                break
            } catch {
                Reply @{ error = $_.Exception.ToString(); processAlive = (-not $process.HasExited) }
            }
        }
    } finally { $process.Dispose() }
} finally { $job.Dispose() }
