param(
    [Parameter(Mandatory = $true)][string]$Payload,
    [switch]$Child
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $OutputEncoding

function Invoke-StudioHarnessNode {
    param(
        [Parameter(Mandatory = $true)][string]$NodeExecutable,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string[]]$NodeArguments
    )
    # PowerShell's directory provider can require access to private ancestors.
    # Windows process creation needs only traversal and access to this checkout.
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $NodeExecutable
    $info.WorkingDirectory = $WorkingDirectory
    $info.UseShellExecute = $false
    # Explicit stdin redirection makes .NET pass inherited stdout/stderr handles
    # even with no console window. Bootstrap commands must not prompt for input.
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.Arguments = ($NodeArguments | ForEach-Object {
        # Quote using Windows argv rules, including embedded quotes and trailing
        # backslashes. The suite arguments remain inside the base64 payload.
        $escaped = [regex]::Replace($_, '(\\*)"', '$1$1\"')
        $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
        '"' + $escaped + '"'
    }) -join ' '
    $nativeProcess = New-Object Diagnostics.Process
    $nativeProcess.StartInfo = $info
    try {
        $null = $nativeProcess.Start()
        $nativeProcess.StandardInput.Close()
        $nativeProcess.WaitForExit()
        return $nativeProcess.ExitCode
    } finally {
        $nativeProcess.Dispose()
    }
}

function Initialize-StudioUserEnvironment {
    param([Parameter(Mandatory = $true)][string]$Sid)
    # Add-Type may need compiler scratch files before the fresh environment
    # exists. Use the actual token's profile, never the source account's TEMP.
    $profile = (Get-ItemProperty -LiteralPath ('Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $Sid) -Name ProfileImagePath).ProfileImagePath
    $profile = [Environment]::ExpandEnvironmentVariables($profile)
    if (-not [IO.Directory]::Exists($profile)) { throw 'The credentialed user profile is not initialized.' }
    $env:TEMP = $profile
    $env:TMP = $profile
    Add-Type -TypeDefinition @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class StudioUserEnvironment {
    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool CreateEnvironmentBlock(out IntPtr block, IntPtr token, bool inherit);
    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool DestroyEnvironmentBlock(IntPtr block);
    public static void Apply() {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        using (var identity = WindowsIdentity.GetCurrent()) {
            IntPtr block;
            if (!CreateEnvironmentBlock(out block, identity.Token, false)) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            try {
                IntPtr cursor = block;
                while (true) {
                    string entry = Marshal.PtrToStringUni(cursor);
                    if (String.IsNullOrEmpty(entry)) break;
                    int separator = entry.IndexOf('=');
                    if (separator > 0) values[entry.Substring(0, separator)] = entry.Substring(separator + 1);
                    cursor = IntPtr.Add(cursor, (entry.Length + 1) * 2);
                }
            } finally {
                DestroyEnvironmentBlock(block);
            }
        }
        if (!values.ContainsKey("USERPROFILE") || String.IsNullOrEmpty(values["USERPROFILE"])) {
            throw new InvalidOperationException("Windows did not provide a loaded user-profile environment.");
        }
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables()) {
            string key = (string)entry.Key;
            if (!key.StartsWith("=")) Environment.SetEnvironmentVariable(key, null);
        }
        foreach (var entry in values) Environment.SetEnvironmentVariable(entry.Key, entry.Value);
    }
}
'@
    [StudioUserEnvironment]::Apply()
    # Do not preload user-configured Node hooks or cross-edition PS modules.
    Get-ChildItem Env: | Where-Object { $_.Name -match '^NODE_|^(PSModulePath|WinPSModulePath)$' } | Remove-Item
}

try {
    $selection = $null
    $config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $currentSid = $identity.User.Value
    if ($config.mode -notin @('enroll', 'run', 'forget')) { throw 'Unsupported Studio test-profile mode.' }
    if (-not $Child) {
        if (-not $config.user) {
            $config | Add-Member -NotePropertyName user -NotePropertyValue ($env:COMPUTERNAME + '\StudioTests') -Force
        }
        $account = New-Object Security.Principal.NTAccount($config.user)
        $targetSid = $account.Translate([Security.Principal.SecurityIdentifier]).Value
        if ($currentSid -notmatch '^S-1-5-21-(\d+-){3}\d+$' -or $targetSid -notmatch '^S-1-5-21-(\d+-){3}\d+$' -or $targetSid -eq $currentSid) {
            throw 'Select a pre-created dedicated local/domain Windows user with a different SID from your personal/source account. No account is created or modified by this launcher.'
        }
        . (Join-Path $PSScriptRoot 'studio-test-credentials.ps1')
        if ($config.mode -eq 'forget') {
            Remove-StudioTestSavedCredential -TargetSid $targetSid
            Write-Host ('Removed saved Studio credential for ' + $targetSid + ' from this source user vault (already absent is OK). No account, profile, enrollment, or other credential was changed. Run setup to reauthorize.')
            exit 0
        }
    } elseif ($config.mode -eq 'forget') { throw 'Credential revocation must run as the source user, not a credentialed child.' }
    if (-not [Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
        throw 'Studio needs an interactive Windows desktop. Run this launcher from a signed-in Windows session, not a service or session-0 task.'
    }
    if ($config.repo -notmatch '^[A-Za-z]:[\\/]') {
        throw 'Use --repo C:\work\robloxstudio-mcp. A separate Windows user cannot use a personal WSL/UNC checkout.'
    }
    $entrypoint = Join-Path $config.repo 'scripts\studio-test-profile.mjs'
    $childScript = Join-Path $config.repo 'scripts\studio-test-profile.ps1'
    if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf) -or -not (Test-Path -LiteralPath $childScript -PathType Leaf)) {
        throw ('The selected account cannot read the launcher in ' + $config.repo + '. Retry setup to export current source, or supply --repo with a Windows-local checkout containing these changes and grant the dedicated account read/write access.')
    }
    if (-not $config.nodeExecutable) {
        $config | Add-Member -NotePropertyName nodeExecutable -NotePropertyValue (Join-Path $env:ProgramFiles 'nodejs\node.exe') -Force
    }
    if ($config.nodeExecutable -notmatch '^[A-Za-z]:[\\/]' -or -not (Test-Path -LiteralPath $config.nodeExecutable -PathType Leaf)) {
        throw 'Native Windows Node was not found or is not accessible. Install Windows Node for all users, or pass --node C:\path\node.exe readable by the dedicated account. Linux Node/WSL dependencies are not a substitute.'
    }
    if ($Child) {
        if ($currentSid -ne $config.targetSid -or $currentSid -eq $config.sourceSid) {
            throw 'Credentialed child identity differs from the requested dedicated account, or reuses the personal/source SID.'
        }
        if (-not $config.launchGate) { throw 'Missing parent containment gate; use the public launcher.' }
        $gateDeadline = [DateTime]::UtcNow.AddSeconds(30)
        # No descendant may start until the source has assigned this process to
        # its kill-on-close job. A source crash before assignment leaves no work.
        while (-not (Test-Path -LiteralPath $config.launchGate -PathType Leaf)) {
            if ([DateTime]::UtcNow -ge $gateDeadline) { throw 'The parent did not establish process containment; no harness was started.' }
            Start-Sleep -Milliseconds 50
        }
        Initialize-StudioUserEnvironment -Sid $currentSid
        $nativeOptions = @{ NodeExecutable = $config.nodeExecutable; WorkingDirectory = $config.repo }
        if ($config.prepareWorkspace) {
            $nodeDirectory = Split-Path -Parent $config.nodeExecutable
            $npmCli = Join-Path $nodeDirectory 'node_modules\npm\bin\npm-cli.js'
            if (-not (Test-Path -LiteralPath $npmCli -PathType Leaf)) { throw 'The selected Windows Node installation has no npm CLI. Install Node with npm for all users, or select a complete installation with --node.' }
            $env:Path = $nodeDirectory + ';' + $env:Path
            Write-Host 'Preparing the Windows harness checkout under the dedicated account; source-user profile and default Studio plugins are unchanged.'
            $nativeExit = Invoke-StudioHarnessNode @nativeOptions -NodeArguments @($npmCli, 'ci')
            if ($nativeExit -ne 0) { throw ('Root npm ci failed with exit code ' + $nativeExit + '. Retry setup; saved Windows credentials are retained.') }
            $nativeExit = Invoke-StudioHarnessNode @nativeOptions -NodeArguments @($npmCli, '--prefix', 'studio-plugin', 'ci')
            if ($nativeExit -ne 0) { throw ('Studio plugin npm ci failed with exit code ' + $nativeExit + '. Retry setup; saved Windows credentials are retained.') }
            $nativeExit = Invoke-StudioHarnessNode @nativeOptions -NodeArguments @($npmCli, 'run', 'build')
            if ($nativeExit -ne 0) { throw ('Harness build failed with exit code ' + $nativeExit + '. Retry setup; saved Windows credentials are retained.') }
            $nativeExit = Invoke-StudioHarnessNode @nativeOptions -NodeArguments @($npmCli, 'run', 'build:plugin:artifact')
            if ($nativeExit -ne 0) { throw ('Studio plugin artifact build failed with exit code ' + $nativeExit + '. Retry setup; saved Windows credentials are retained.') }
        }
        $nativeExit = Invoke-StudioHarnessNode @nativeOptions -NodeArguments @($entrypoint, '_child', $Payload)
        exit $nativeExit
    }

    if ($config.managedSnapshot) {
        $snapshotRoot = [IO.Path]::GetFullPath((& (Join-Path $PSScriptRoot 'studio-test-snapshot-root.ps1'))).TrimEnd('\')
        $snapshot = [IO.Path]::GetFullPath($config.repo).TrimEnd('\')
        if (-not [string]::Equals((Split-Path -Parent $snapshot), $snapshotRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $snapshot) -notmatch '^snapshot-[A-Za-z0-9]+$') {
            throw 'Managed snapshot access can be granted only to a generated directory under this source SID managed snapshot root, never an arbitrary --repo.'
        }
        foreach ($directory in @($snapshotRoot, $snapshot)) {
            $item = Get-Item -LiteralPath $directory -Force
            if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Managed snapshot root and checkout must be ordinary directories, not reparse points.' }
        }
        $snapshotAcl = Get-Acl -LiteralPath $snapshot
        $targetIdentity = New-Object Security.Principal.SecurityIdentifier($targetSid)
        $snapshotRule = New-Object Security.AccessControl.FileSystemAccessRule($targetIdentity, 'Modify', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
        $snapshotAcl.AddAccessRule($snapshotRule)
        Set-Acl -LiteralPath $snapshot -AclObject $snapshotAcl
    }

    $config | Add-Member -NotePropertyName sourceSid -NotePropertyValue $currentSid -Force
    $config | Add-Member -NotePropertyName targetSid -NotePropertyValue $targetSid -Force
    Write-Host ('Windows-local harness checkout: ' + $config.repo)
    Write-Host 'Setup prepares the harness and initializes missing settings automatically. Studio must be installed for the dedicated account; normal test runs never change its global settings.'
    Write-Host 'Studio needs an interactive Windows desktop. No elevation fallback or personal-profile reuse is attempted.'
    Write-Host 'Cancellation terminates this launch and its descendants only. An abnormal exit may leave test-profile worker files for inspection; it never closes pre-existing personal Studio.'
    Write-Host 'Credentials stay in this source user Windows Credential Manager vault on this machine, never in files, logs, or process arguments. Runs never prompt. To reauthorize, use forget --user <account>, then setup --user <account>.'
    $selection = Get-StudioTestLaunchCredential -Mode $config.mode -UserName $config.user -TargetSid $targetSid
    $credential = $selection.Credential

    # The job handle is owned only by this source process. Windows closes it on
    # cancellation or abrupt source exit, terminating all contained descendants.
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public sealed class StudioHarnessJob : IDisposable {
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters {
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(SafeFileHandle job, int infoClass, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
    private readonly SafeFileHandle handle;
    public StudioHarnessJob() {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        ExtendedLimits limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))) {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error);
        }
    }
    public void Assign(IntPtr process) {
        if (!AssignProcessToJobObject(handle, process)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public void Dispose() { handle.Dispose(); }
}
'@

    $logDirectory = Join-Path ([IO.Path]::GetTempPath()) ('rsmcp-test-profile-' + [Guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $logDirectory
    $process = $null
    $started = $false
    $job = $null
    $startInfo = $null
    $stdoutLog = $null
    $stderrLog = $null
    $exitCode = 1
    try {
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $acl.SetAccessRuleProtection($true, $false)
        $acl.SetOwner($identity.User)
        foreach ($sidValue in @($currentSid, $targetSid, 'S-1-5-18', 'S-1-5-32-544')) {
            $sid = New-Object Security.Principal.SecurityIdentifier($sidValue)
            $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
            $acl.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $logDirectory -AclObject $acl
        $config | Add-Member -NotePropertyName launchGate -NotePropertyValue (Join-Path $logDirectory 'contained') -Force
        $childPayload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($config | ConvertTo-Json -Depth 8 -Compress)))
        $stdoutLog = New-Object IO.StreamWriter((Join-Path $logDirectory 'stdout.log'), $false, [Text.Encoding]::UTF8)
        $stderrLog = New-Object IO.StreamWriter((Join-Path $logDirectory 'stderr.log'), $false, [Text.Encoding]::UTF8)
        $stdoutLog.AutoFlush = $true
        $stderrLog.AutoFlush = $true
        [Console]::Error.WriteLine('Launcher diagnostics: ' + $logDirectory)
        $job = New-Object StudioHarnessJob
        $startInfo = New-Object Diagnostics.ProcessStartInfo
        $startInfo.FileName = Join-Path $PSHOME 'powershell.exe'
        # -File receives one quoted Windows filename and a base64 JSON payload;
        # neither command text nor credentials are shell-evaluated arguments.
        $startInfo.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $childScript + '" -Child -Payload ' + $childPayload
        $startInfo.WorkingDirectory = $config.repo
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.LoadUserProfile = $true
        # Rebuild module discovery under the target identity, never inherit the
        # source account's or a different PowerShell edition's module paths.
        $startInfo.EnvironmentVariables.Remove('PSModulePath')
        $startInfo.EnvironmentVariables.Remove('WinPSModulePath')
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
        $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
        $credentialName = $credential.UserName -split '\\', 2
        $startInfo.UserName = $credentialName[-1]
        if ($credentialName.Length -eq 2) { $startInfo.Domain = $credentialName[0] }
        $startInfo.Password = $credential.Password
        # Unlike Start-Process -PassThru, .NET retains the original creation
        # handle; no cross-user PROCESS_ALL_ACCESS reopen is required.
        $process = New-Object Diagnostics.Process
        $process.StartInfo = $startInfo
        try { $null = $process.Start() }
        catch {
            throw ('Credentialed Windows logon/process launch failed. No password retry prompt was opened. If credentials changed, use studio:test-profile forget --user <account>, then studio:test-profile setup --user <account> --confirm-dedicated-profile to reauthorize. ' + $_.Exception.Message)
        }
        $started = $true
        $startInfo.Password = $null
        # Save only after Windows accepted the credentials, before unrelated
        # setup/build work. Retrying a failed bootstrap must not prompt again.
        Save-StudioTestCredentialAfterLogon -Selection $selection -TargetSid $targetSid
        $credential.Password.Dispose()
        $credential = $null
        $selection = $null
        $job.Assign($process.Handle)
        [IO.File]::WriteAllText($config.launchGate, 'contained')
        $stdoutBuffer = New-Object char[] 4096
        $stderrBuffer = New-Object char[] 4096
        $stdoutRead = $process.StandardOutput.ReadAsync($stdoutBuffer, 0, $stdoutBuffer.Length)
        $stderrRead = $process.StandardError.ReadAsync($stderrBuffer, 0, $stderrBuffer.Length)
        while ($null -ne $stdoutRead -or $null -ne $stderrRead -or -not $process.HasExited) {
            if ($process.HasExited -and $null -ne $job) {
                # Descendants must not keep inherited output pipes open forever.
                $job.Dispose()
                $job = $null
            }
            if ($null -ne $stdoutRead -and $stdoutRead.IsCompleted) {
                $count = $stdoutRead.GetAwaiter().GetResult()
                if ($count -eq 0) { $stdoutRead = $null } else {
                    [Console]::Out.Write($stdoutBuffer, 0, $count)
                    $stdoutLog.Write($stdoutBuffer, 0, $count)
                    $stdoutRead = $process.StandardOutput.ReadAsync($stdoutBuffer, 0, $stdoutBuffer.Length)
                }
            }
            if ($null -ne $stderrRead -and $stderrRead.IsCompleted) {
                $count = $stderrRead.GetAwaiter().GetResult()
                if ($count -eq 0) { $stderrRead = $null } else {
                    [Console]::Error.Write($stderrBuffer, 0, $count)
                    $stderrLog.Write($stderrBuffer, 0, $count)
                    $stderrRead = $process.StandardError.ReadAsync($stderrBuffer, 0, $stderrBuffer.Length)
                }
            }
            Start-Sleep -Milliseconds 50
        }
        $exitCode = $process.ExitCode
    } finally {
        if ($null -ne $selection) { $selection.Credential.Password.Dispose(); $selection = $null }
        $credential = $null
        if ($null -ne $startInfo) { $startInfo.Password = $null }
        if ($null -ne $job) { $job.Dispose() }
        # Assignment failure can leave only the gated wrapper outside the job.
        if ($null -ne $process) {
            try {
                if ($started -and -not $process.HasExited) { $process.Kill() }
            } catch {
                [Console]::Error.WriteLine('Unable to confirm gated-wrapper termination: ' + $_.Exception.Message)
            } finally { $process.Dispose() }
        }
        if ($null -ne $stdoutLog) { $stdoutLog.Dispose() }
        if ($null -ne $stderrLog) { $stderrLog.Dispose() }
        if ($exitCode -eq 0) {
            Remove-Item -LiteralPath $logDirectory -Recurse -Force -ErrorAction SilentlyContinue
        } else {
            [Console]::Error.WriteLine('Abnormal launch: diagnostics retained at ' + $logDirectory + '. Descendants are terminated by the containment job; inspect leftover worker directories only in the dedicated test profile.')
        }
    }
    exit $exitCode
} catch {
    $launchSide = if ($Child) { 'child' } else { 'source' }
    [Console]::Error.WriteLine(('Studio launcher {0} failure at line {1}: {2}' -f $launchSide, $_.InvocationInfo.ScriptLineNumber, $_.Exception.Message))
    [Console]::Error.WriteLine('Setup automatically prepares the workspace and settings. The dedicated Windows account, its Studio installation, native Node, Secondary Logon, and an interactive desktop must be available. Runs never prompt. Use forget then setup to reauthorize; forget only removes the named source-vault entry. No elevation fallback is attempted.')
    exit 1
} finally {
    if ($null -ne $selection) { $selection.Credential.Password.Dispose() }
}
