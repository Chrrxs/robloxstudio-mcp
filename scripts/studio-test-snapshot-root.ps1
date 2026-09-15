param([switch]$Initialize)

$ErrorActionPreference = 'Stop'
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $OutputEncoding

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
try {
    $sourceSid = $identity.User
} finally {
    $identity.Dispose()
}
if ($sourceSid.Value -notmatch '^S-1-5-21-(\d+-){3}\d+$') {
    throw 'Studio test snapshots require a signed-in local/domain Windows source user.'
}

# Known-folder lookup deliberately ignores inherited ProgramData/USERPROFILE values.
$commonData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
if ([string]::IsNullOrWhiteSpace($commonData) -or -not [IO.Path]::IsPathRooted($commonData)) {
    throw 'Windows did not provide an absolute CommonApplicationData folder for Studio test snapshots.'
}
$commonData = [IO.Path]::GetFullPath($commonData)
$root = [IO.Path]::GetFullPath([IO.Path]::Combine($commonData, 'robloxstudio-mcp-tests-' + $sourceSid.Value))

if (-not $Initialize) {
    # Expected-root derivation must work without inspecting or creating any directory.
    $root
    return
}

function Assert-StudioSnapshotDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw ('Studio test snapshot path must be an ordinary directory, not a file or reparse point: ' + $Path)
    }
}

function Get-StudioSnapshotAccessSignature {
    param([Parameter(Mandatory = $true)][Security.AccessControl.DirectorySecurity]$Acl)
    # Compare SID-based entries rather than localized names or ACE storage order.
    $entries = @($Acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
        '{0}|{1}|{2}|{3}|{4}|{5}' -f $_.IdentityReference.Value, [int]$_.FileSystemRights,
            [int]$_.AccessControlType, [int]$_.InheritanceFlags, [int]$_.PropagationFlags, $_.IsInherited
    } | Sort-Object)
    return ($entries -join "`n")
}

try {
    Assert-StudioSnapshotDirectory -Path $commonData

    # Build a fresh descriptor, never mutate an ACL object that might be needed
    # as the original. Users may inspect this ancestor, but inherit no access.
    $desiredAcl = New-Object Security.AccessControl.DirectorySecurity
    $desiredAcl.SetOwner($sourceSid)
    $desiredAcl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($sourceSid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
        $principal = New-Object Security.Principal.SecurityIdentifier($sid)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($principal, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
        $desiredAcl.AddAccessRule($rule)
    }
    $users = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')
    $usersRule = New-Object Security.AccessControl.FileSystemAccessRule($users, 'ReadAndExecute', 'None', 'None', 'Allow')
    $desiredAcl.AddAccessRule($usersRule)

    $rootMissing = $false
    try {
        # GetAttributes distinguishes absence from inaccessible paths; Exists does not.
        $attributes = [IO.File]::GetAttributes($root)
        if (-not ($attributes -band [IO.FileAttributes]::Directory) -or ($attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw ('Studio test snapshot root is occupied by a file or reparse point; refusing to use it: ' + $root)
        }
    } catch [IO.FileNotFoundException] {
        $rootMissing = $true
    } catch [IO.DirectoryNotFoundException] {
        $rootMissing = $true
    }

    if ($rootMissing) {
        try {
            # Supply security at creation, so the directory is never born with
            # CommonApplicationData's broader inherited permissions.
            $null = [IO.Directory]::CreateDirectory($root, $desiredAcl)
        } catch [UnauthorizedAccessException] {
            throw ('Cannot create the Studio test snapshot root as source user ' + $sourceSid.Value + ': ' + $root + '. CommonApplicationData must permit this user to create its own directory. No elevation or parent/profile ACL changes will be attempted. ' + $_.Exception.Message)
        }
    }

    # Recheck after creation, including a concurrent creator. Never take ownership
    # of a collision, even when the current token could otherwise rewrite its ACL.
    Assert-StudioSnapshotDirectory -Path $commonData
    Assert-StudioSnapshotDirectory -Path $root
    $currentAcl = Get-Acl -LiteralPath $root
    $ownerSid = $currentAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($ownerSid -ne $sourceSid.Value) {
        throw ('Studio test snapshot root is owned by ' + $ownerSid + ', not the current source user ' + $sourceSid.Value + '; refusing a potentially hijacked directory: ' + $root + '. No ownership or permissions were changed on the existing root.')
    }

    if (-not $currentAcl.AreAccessRulesProtected -or
        (Get-StudioSnapshotAccessSignature -Acl $currentAcl) -cne (Get-StudioSnapshotAccessSignature -Acl $desiredAcl)) {
        Set-Acl -LiteralPath $root -AclObject $desiredAcl
    }
} catch [UnauthorizedAccessException] {
    throw ('Cannot inspect or secure the Studio test snapshot root as source user ' + $sourceSid.Value + ': ' + $root + '. An existing root must be owned by this user and permit reading/updating its DACL. No elevation, ownership takeover, or parent/profile ACL changes will be attempted. ' + $_.Exception.Message)
}

$root
