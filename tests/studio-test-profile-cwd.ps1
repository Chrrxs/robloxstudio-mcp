param(
    [Parameter(Mandatory = $true)][string]$LauncherPath,
    [Parameter(Mandatory = $true)][string]$SnapshotRootHelperPath,
    [Parameter(Mandatory = $true)][string]$Payload
)

$ErrorActionPreference = 'Stop'
$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
$ancestor = [IO.Directory]::GetParent([IO.Directory]::GetParent($config.repo).FullName).FullName
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
$originalAclSddl = [IO.Directory]::GetAccessControl($ancestor).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
$exitCode = 1

function Invoke-FixturePowerShell {
    param([string]$Arguments)
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = Join-Path $PSHOME 'powershell.exe'
    $info.Arguments = $Arguments
    # Match the production parent: the child starts inside the checkout.
    $info.WorkingDirectory = $config.repo
    $info.UseShellExecute = $false
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    try {
        $null = $process.Start()
        $process.WaitForExit()
        return $process.ExitCode
    } finally {
        $process.Dispose()
    }
}

try {
    # The leaf remains fully accessible even though its private parent cannot
    # be inspected. All ACL changes are confined to this temporary fixture.
    $leafAcl = [IO.Directory]::GetAccessControl($config.repo)
    $leafAcl.SetAccessRuleProtection($true, $false)
    $leafAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        $currentUser, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
    [IO.Directory]::SetAccessControl($config.repo, $leafAcl)

    # Two consecutive restricted ancestors matter: a single restricted parent
    # can still have its attributes read through its own accessible parent.
    # private-temp inherits this ACL; the checkout's protected DACL does not.
    $restrictedAcl = New-Object Security.AccessControl.DirectorySecurity
    $restrictedAcl.SetAccessRuleProtection($true, $false)
    $restrictedAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        $currentUser, 'ListDirectory, ReadAttributes, ReadExtendedAttributes', 'ContainerInherit, ObjectInherit', 'None', 'Deny')))
    $restrictedAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        $currentUser, 'Traverse, ReadPermissions, ChangePermissions', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
    [IO.Directory]::SetAccessControl($ancestor, $restrictedAcl)

    # Use a fresh provider session, just like the production -Child process.
    # The wrapper has already resolved fixture paths while setting their ACLs.
    $probe = @'
try {
    $config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__')) | ConvertFrom-Json
    Set-Location -LiteralPath $config.repo -ErrorAction Stop
    exit 0
} catch {
    $exception = $_.Exception
    while ($null -ne $exception) {
        if ($exception -is [UnauthorizedAccessException]) { exit 42 }
        $exception = $exception.InnerException
    }
    if ($_.CategoryInfo.Category -eq [Management.Automation.ErrorCategory]::PermissionDenied) { exit 42 }
    Write-Error $_
    exit 1
}
'@
    $probe = $probe.Replace('__PAYLOAD__', $Payload)
    $encodedProbe = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($probe))
    $probeExitCode = Invoke-FixturePowerShell ('-NoProfile -NonInteractive -EncodedCommand ' + $encodedProbe)
    if ($probeExitCode -ne 42) { throw 'Protected-parent fixture did not deny the original Set-Location operation.' }
    Write-Output 'protected-parent-set-location-denied'

    # Run the real entry point in a separate process so its exit statement
    # cannot bypass this wrapper's ACL restoration. No credential path runs.
    $exitCode = Invoke-FixturePowerShell ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $LauncherPath + '" -Child -Payload ' + $Payload)
    if ($exitCode -eq 0) { throw 'Bootstrap unexpectedly completed below inaccessible private ancestors.' }
    Write-Output 'protected-parent-bootstrap-rejected'
} finally {
    # Set-Acl/Get-Item use the same provider traversal that this fixture denies.
    # The retained ChangePermissions right permits direct restoration instead.
    # An untouched GetAccessControl object has no modified sections, so passing
    # it back can silently do nothing. Parsing the saved DACL marks it dirty.
    $restoredAcl = New-Object Security.AccessControl.DirectorySecurity
    $restoredAcl.SetSecurityDescriptorSddlForm($originalAclSddl, [Security.AccessControl.AccessControlSections]::Access)
    [IO.Directory]::SetAccessControl($ancestor, $restoredAcl)
}

# Move the identical fake checkout to the production shared-root location.
# Only the unique snapshot leaf belongs to this test; never remove a shared
# root that may contain another launcher's snapshots.
$snapshotRoot = (& $SnapshotRootHelperPath -Initialize).Trim()
$commonData = [Environment]::GetFolderPath('CommonApplicationData').TrimEnd('\') + '\'
$profile = [Environment]::GetFolderPath('UserProfile').TrimEnd('\') + '\'
if (-not $snapshotRoot.StartsWith($commonData, [StringComparison]::OrdinalIgnoreCase) -or
    $snapshotRoot.StartsWith($profile, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Managed snapshots must live under common application data, outside the source profile.'
}
$usersSid = 'S-1-5-32-545'
$rootAcl = [IO.Directory]::GetAccessControl($snapshotRoot)
$usersRules = @($rootAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object {
    $_.IdentityReference.Value -eq $usersSid -and $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow
})
$readAndExecute = [Security.AccessControl.FileSystemRights]::ReadAndExecute
$allowedRootRights = $readAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize
if (-not $rootAcl.AreAccessRulesProtected -or $usersRules.Count -ne 1 -or
    ($usersRules[0].FileSystemRights -band $readAndExecute) -ne $readAndExecute -or
    ($usersRules[0].FileSystemRights -band $allowedRootRights) -ne $usersRules[0].FileSystemRights -or
    $usersRules[0].InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None) {
    throw 'Users must be able to inspect the shared root, but not write it or inherit access to snapshots.'
}

$sharedRepo = Join-Path $snapshotRoot ('snapshot-' + [Guid]::NewGuid().ToString('N'))
try {
    $sharedScripts = Join-Path $sharedRepo 'scripts'
    $null = [IO.Directory]::CreateDirectory($sharedScripts)
    $leafRules = [IO.Directory]::GetAccessControl($sharedRepo).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    if (@($leafRules | Where-Object { $_.IdentityReference.Value -eq $usersSid }).Count -ne 0) {
        throw 'A new snapshot must not inherit access for unrelated Windows users.'
    }
    foreach ($name in @('studio-test-profile.ps1', 'studio-test-profile.mjs')) {
        [IO.File]::Copy((Join-Path $config.repo ('scripts\' + $name)), (Join-Path $sharedScripts $name))
    }
    $config.repo = $sharedRepo
    $sharedPayload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($config | ConvertTo-Json -Depth 10 -Compress)))
    $exitCode = Invoke-FixturePowerShell ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $LauncherPath + '" -Child -Payload ' + $sharedPayload)
    if ($exitCode -ne 0) { throw ('Shared-root bootstrap failed with exit code ' + $exitCode) }
    Write-Output 'shared-root-bootstrap-completed'
} finally {
    if ([IO.Directory]::Exists($sharedRepo)) { [IO.Directory]::Delete($sharedRepo, $true) }
}
exit $exitCode
