param(
    [Parameter(Mandatory = $true)][string]$LauncherPath,
    [Parameter(Mandatory = $true)][string]$NodeExecutable,
    [string]$CrossAccountUser
)

$ErrorActionPreference = 'Stop'
# Load only the production native helper, never the credential/account launcher.
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($LauncherPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw ($parseErrors | Out-String) }
$initializer = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Initialize-StudioHarnessJob' }, $true)
if ($null -eq $initializer) { throw 'Native containment helper is unavailable.' }
. ([scriptblock]::Create($initializer.Extent.Text))
Initialize-StudioHarnessJob

$targetSid = $null
$sourceSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$fixtureRoot = [IO.Path]::GetTempPath()
if ($CrossAccountUser) {
    $targetSid = (New-Object Security.Principal.NTAccount($CrossAccountUser)).Translate([Security.Principal.SecurityIdentifier]).Value
    if ($targetSid -notmatch '^S-1-5-21-(\d+-){3}\d+$' -or $targetSid -eq $sourceSid.Value) {
        throw 'Cross-account proof requires a different dedicated local/domain Windows user.'
    }
    # A target account must never require access through source-private TEMP.
    # Grant only this unique leaf; no existing profile or ancestor ACL changes.
    $fixtureRoot = [Environment]::GetFolderPath('CommonApplicationData')
}
$fixture = Join-Path $fixtureRoot ('rsmcp-job-fixture-' + [Guid]::NewGuid().ToString('N'))
try {
    $null = [IO.Directory]::CreateDirectory($fixture)
    if ($CrossAccountUser) {
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $acl.SetAccessRuleProtection($true, $false)
        $acl.SetOwner($sourceSid)
        foreach ($sidValue in @($sourceSid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
            $sid = New-Object Security.Principal.SecurityIdentifier($sidValue)
            $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
        }
        $target = New-Object Security.Principal.SecurityIdentifier($targetSid)
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($target, 'ReadAndExecute', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
        Set-Acl -LiteralPath $fixture -AclObject $acl
        $compilerTemp = Join-Path $fixture 'compiler'
        $null = [IO.Directory]::CreateDirectory($compilerTemp)
        $compilerAcl = Get-Acl -LiteralPath $compilerTemp
        $compilerAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($target, 'Modify', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
        Set-Acl -LiteralPath $compilerTemp -AclObject $compilerAcl
        $restrictedHelper = Join-Path $PSScriptRoot 'studio-test-profile-restricted-helper.ps1'
        . $restrictedHelper
        [IO.File]::Copy($restrictedHelper, (Join-Path $fixture 'restricted-helper.ps1'))
    }
$installer = Join-Path $fixture 'RobloxStudioInstaller.exe'
$fixtureScript = Join-Path $fixture 'fixture.cjs'
[IO.File]::Copy($NodeExecutable, $installer)
[IO.File]::WriteAllText($fixtureScript, @'
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');
const [mode, node, installer, gate] = process.argv.slice(2);
function command(expected, action) {
  const reader = createInterface({ input: process.stdin });
  reader.once('line', (line) => {
    assert.equal(line, expected);
    reader.close();
    process.stdin.pause();
    action();
  });
}
function replace(executable, next) {
  // Avoid libuv's separate kill-on-parent-exit job. DETACHED_PROCESS does not
  // request job breakaway: the explicit StudioHarnessJob still owns every child.
  const child = spawn(executable, [__filename, next, node, installer, 'open'], { stdio: 'inherit', detached: true });
  child.once('error', (error) => { console.error(error); process.exit(1); });
  child.once('spawn', () => { child.unref(); process.exit(mode === 'wrapper' ? 17 : 0); });
}
function run() {
  if (process.env.RSMCP_FIXTURE_EXPECTED_SID) {
    const identity = execFileSync(path.join(process.env.SystemRoot, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' });
    assert.ok(identity.includes('"' + process.env.RSMCP_FIXTURE_EXPECTED_SID + '"'), 'Fixture must run with the requested target token');
  }
  if (mode === 'leftover' && process.env.RSMCP_FIXTURE_SOURCE_SID) {
    const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const helperPath = path.join(__dirname, 'restricted-helper.ps1').replaceAll("'", "''");
    const invocation = `$ErrorActionPreference = 'Stop'; & '${helperPath}' -DeniedSourceSid '${process.env.RSMCP_FIXTURE_SOURCE_SID}'`;
    const encoded = Buffer.from(invocation, 'utf16le').toString('base64');
    // Match the worker broker: Windows PowerShell 5 needs an ordinary console
    // launch through cmd, not DETACHED_PROCESS. Keep this non-installer Node
    // supervisor alive so cmd cannot die before starting its owned grandchild.
    const helper = spawn(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/d', '/s', '/c',
      `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
    ], { stdio: 'inherit', windowsHide: true, env: { ...process.env, PATH: path.dirname(powershell) + ';' + process.env.PATH } });
    helper.once('error', (error) => { console.error(error); process.exit(1); });
    helper.once('exit', (code, signal) => {
      console.error(`Restricted helper launcher exited before owned cleanup: code=${code}, signal=${signal}`);
      process.exit(code || 1);
    });
    return;
  }
  if (mode === 'wrapper') return replace(installer, 'parent');
  if (mode === 'parent') command('replace', () => replace(installer, 'replacement'));
  else if (mode === 'replacement') command('complete', () => replace(node, 'leftover'));
  else command('exit', () => process.exit(0));
  console.log(mode + '-ready');
}
if (gate === 'gated') command('start', run);
else run();
'@)
} catch {
    if ([IO.Directory]::Exists($fixture)) { [IO.Directory]::Delete($fixture, $true) }
    throw
}

function Start-OwnedFixture {
    param($Job, [string]$Executable, [string]$Mode, [Management.Automation.PSCredential]$Credential)
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $Executable
    $info.WorkingDirectory = $fixture
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardErrorEncoding = [Text.Encoding]::UTF8
    $info.Arguments = '"' + $fixtureScript + '" ' + $Mode + ' "' + $NodeExecutable + '" "' + $installer + '" gated'
    if ($null -ne $Credential) {
        $credentialName = $Credential.UserName -split '\\', 2
        $info.UserName = $credentialName[-1]
        if ($credentialName.Length -eq 2) { $info.Domain = $credentialName[0] }
        $info.Password = $Credential.Password
        $info.LoadUserProfile = $true
        # No source profile or Node startup configuration reaches the fixture.
        $info.EnvironmentVariables.Clear()
        $info.EnvironmentVariables['SystemRoot'] = $env:SystemRoot
        $info.EnvironmentVariables['windir'] = $env:SystemRoot
        $info.EnvironmentVariables['PATH'] = (Split-Path -Parent $NodeExecutable) + ';' + (Join-Path $env:SystemRoot 'System32')
        $info.EnvironmentVariables['TEMP'] = $compilerTemp
        $info.EnvironmentVariables['TMP'] = $compilerTemp
        $info.EnvironmentVariables['RSMCP_FIXTURE_EXPECTED_SID'] = $targetSid
        $info.EnvironmentVariables['RSMCP_FIXTURE_SOURCE_SID'] = $sourceSid.Value
        if ($info.FileName.Length + $info.Arguments.Length + 3 -ge 1024) { throw 'Cross-account fixture exceeds the Windows credentialed command-line limit.' }
    }
    $child = New-Object Diagnostics.Process
    $child.StartInfo = $info
    $started = $false
    $assigned = $false
    try {
        $null = $child.Start()
        $started = $true
        $info.Password = $null
        # Start draining before opening the gate. Descendants inherit this pipe;
        # completion is collected after disposal, never awaited during grace.
        $child | Add-Member -NotePropertyName FixtureStderrRead -NotePropertyValue ($child.StandardError.ReadToEndAsync())
        $child | Add-Member -NotePropertyName FixtureStderrReported -NotePropertyValue $false
        $Job.Assign($child.Handle)
        $assigned = $true
        $child.StandardInput.WriteLine('start')
        $child.StandardInput.Flush()
        return $child
    } catch {
        # Only this retained creation handle can be outside the job on failure;
        # its stdin gate prevents it from spawning descendants before assignment.
        if ($started -and -not $assigned -and -not $child.HasExited) { $child.Kill() }
        $child.Dispose()
        throw
    } finally {
        $info.Password = $null
    }
}

function Get-FixtureDiagnostics {
    param($Process)
    $status = if ($Process.HasExited) { 'exit code ' + $Process.ExitCode } else { 'root still running' }
    if ($Process.FixtureStderrRead.Wait(250)) {
        $Process.FixtureStderrReported = $true
        return $status + '; stderr: ' + $Process.FixtureStderrRead.GetAwaiter().GetResult()
    }
    return $status + '; stderr is still being drained; retained descendant pipes will close during job cleanup'
}

function Read-FixtureLine {
    param($Process, [string]$Expected)
    $read = $Process.StandardOutput.ReadLineAsync()
    if (-not $read.Wait(10000)) { throw ('Fixture output timed out: ' + $Expected + '; ' + (Get-FixtureDiagnostics $Process)) }
    if ($read.Result -ne $Expected) {
        $received = if ($null -eq $read.Result) { '<EOF>' } else { $read.Result }
        throw ('Expected ' + $Expected + ', received ' + $received + '; ' + (Get-FixtureDiagnostics $Process))
    }
}

function Assert-FixturePipeClosed {
    param($Process)
    $read = $Process.StandardOutput.ReadToEndAsync()
    if (-not $read.Wait(10000)) { throw 'Owned descendants retained output pipes after job disposal.' }
    if ($read.Result.Length -ne 0) { throw ('Unexpected remaining fixture output: ' + $read.Result) }
}

$job = $null
$unrelatedJob = $null
$root = $null
$unrelated = $null
$bounded = $null
$cancelled = $null
$selection = $null
try {
    $job = New-Object StudioHarnessJob
    $unrelatedJob = New-Object StudioHarnessJob
    # Same installer image, but a different owned fixture job: must be ignored
    # both by grace selection and by disposal of the harness job under test.
    $unrelated = Start-OwnedFixture $unrelatedJob $installer 'unrelated'
    Read-FixtureLine $unrelated 'unrelated-ready'
    if ($CrossAccountUser) {
        . (Join-Path (Split-Path -Parent $LauncherPath) 'studio-test-credentials.ps1')
        # Mode run only reads an existing source-vault credential; no prompting,
        # saving, account creation, enrollment, or password argv/logging.
        $selection = Get-StudioTestLaunchCredential -Mode run -UserName $CrossAccountUser -TargetSid $targetSid
    }
    try {
        $credential = if ($null -ne $selection) { $selection.Credential } else { $null }
        $root = Start-OwnedFixture $job $NodeExecutable 'wrapper' $credential
    } finally {
        if ($null -ne $selection) { $selection.Credential.Password.Dispose(); $selection = $null }
        $credential = $null
    }
    Read-FixtureLine $root 'parent-ready'
    if (-not $root.WaitForExit(10000) -or $root.ExitCode -ne 17) { throw 'The simulated failing harness did not exit with code 17.' }
    if (-not $job.ContinueInstallerGrace(0)) { throw 'Ordinary harness failure did not preserve the owned installer.' }

    $root.StandardInput.WriteLine('replace')
    $root.StandardInput.Flush()
    Read-FixtureLine $root 'replacement-ready'
    if (-not $job.ContinueInstallerGrace(250)) { throw 'Replacement installer lost its inherited containment grace.' }
    $root.StandardInput.WriteLine('complete')
    $root.StandardInput.Flush()
    Read-FixtureLine $root 'leftover-ready'
    if ($CrossAccountUser) {
        $helperPidRead = $root.StandardOutput.ReadLineAsync()
        if (-not $helperPidRead.Wait(10000) -or $helperPidRead.Result -notmatch '^restricted-helper-pid:(\d+)$') {
            throw ('Restricted helper PID was not received; ' + (Get-FixtureDiagnostics $root))
        }
        [StudioFixtureProcessAccess]::AssertQueryOnlyAccess([uint32]$Matches[1])
    }
    $completion = [Diagnostics.Stopwatch]::StartNew()
    while ($job.ContinueInstallerGrace(500 + $completion.ElapsedMilliseconds)) {
        if ($completion.ElapsedMilliseconds -ge 10000) { throw 'Installer completion waited for a non-installer or unrelated process.' }
        Start-Sleep -Milliseconds 10
    }
    $job.Dispose()
    $job = $null
    Assert-FixturePipeClosed $root
    if ($unrelated.HasExited) { throw 'Harness disposal terminated the unrelated installer fixture.' }
    $unrelated.StandardInput.WriteLine('exit')
    $unrelated.StandardInput.Flush()
    if (-not $unrelated.WaitForExit(10000) -or $unrelated.ExitCode -ne 0) { throw 'Unrelated installer could not complete normally.' }
    Write-Output 'owned-installer-replacement-completed-unrelated-preserved-leftover-closed'
    if ($CrossAccountUser) { Write-Output 'cross-account-owned-installer-query-and-completion-proven' }
    if ($CrossAccountUser) { Write-Output 'owned-helper-synchronize-denied-query-only-classification-proven' }

    $job = New-Object StudioHarnessJob
    $bounded = Start-OwnedFixture $job $installer 'bounded'
    Read-FixtureLine $bounded 'bounded-ready'
    if (-not $job.ContinueInstallerGrace(0)) { throw 'Bounded installer did not enter grace.' }
    if (-not $job.ContinueInstallerGrace([StudioHarnessJob]::MaximumInstallerGraceMilliseconds - 1)) { throw 'Grace ended before the hard deadline.' }
    if ($job.ContinueInstallerGrace([StudioHarnessJob]::MaximumInstallerGraceMilliseconds)) { throw 'Grace exceeded its ten-minute hard deadline.' }
    $job.Dispose()
    $job = $null
    if (-not $bounded.WaitForExit(10000)) { throw 'Expired grace left the owned installer running.' }
    Assert-FixturePipeClosed $bounded
    Write-Output 'owned-installer-hard-deadline-enforced'

    $job = New-Object StudioHarnessJob
    $cancelled = Start-OwnedFixture $job $installer 'cancelled'
    Read-FixtureLine $cancelled 'cancelled-ready'
    if (-not $job.ContinueInstallerGrace(0)) { throw 'Cancellation fixture did not enter grace.' }
    $job.Dispose()
    $job = $null
    if (-not $cancelled.WaitForExit(10000)) { throw 'Explicit cancellation was delayed by installer grace.' }
    Assert-FixturePipeClosed $cancelled
    Write-Output 'owned-installer-explicit-cancellation-remains-immediate'
} catch {
    [Console]::Error.WriteLine('Native containment fixture failed: ' + $_.Exception.ToString())
    throw
} finally {
    if ($null -ne $selection) { $selection.Credential.Password.Dispose() }
    if ($null -ne $job) { $job.Dispose() }
    if ($null -ne $unrelatedJob) { $unrelatedJob.Dispose() }
    foreach ($child in @($root, $unrelated, $bounded, $cancelled)) {
        if ($null -ne $child) {
            try {
                if (-not $child.WaitForExit(10000)) { throw 'Fixture root remained alive after its owned job closed.' }
                # Exited roots can leave descendant-held executable mappings.
                # Wait for inherited pipe EOF before deleting the copied Node.
                $drain = $child.StandardOutput.ReadToEndAsync()
                if (-not $drain.Wait(10000)) { throw 'Fixture descendant pipes remained open after owned job cleanup.' }
                if (-not $child.FixtureStderrRead.Wait(10000)) { throw 'Fixture stderr pipe remained open after owned job cleanup.' }
                $stderr = $child.FixtureStderrRead.GetAwaiter().GetResult()
                if (-not $child.FixtureStderrReported -and -not [string]::IsNullOrWhiteSpace($stderr)) {
                    [Console]::Error.WriteLine('Fixture child stderr (exit code ' + $child.ExitCode + '): ' + $stderr)
                }
            } finally { $child.Dispose() }
        }
    }
    [IO.Directory]::Delete($fixture, $true)
}
