$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\studio-test-credentials.ps1')

function Assert-Fixture {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}
function Assert-FixtureThrows {
    param([scriptblock]$Action, [string]$Message)
    $failed = $false
    try { & $Action } catch { $failed = $true }
    Assert-Fixture $failed $Message
}
function New-FixturePassword {
    $password = [Security.SecureString]::new()
    # Synthetic Unicode and embedded NUL exercise byte count and cleanup boundaries.
    foreach ($character in @([char]0x66, [char]0x00e9, [char]0, [char]0x6771, [char]0xd83d, [char]0xde00)) {
        $password.AppendChar($character)
    }
    $password.MakeReadOnly()
    return $password
}
function Assert-FixturePassword {
    param([Security.SecureString]$Password)
    $expected = @([char]0x66, [char]0x00e9, [char]0, [char]0x6771, [char]0xd83d, [char]0xde00)
    Assert-Fixture ($Password.Length -eq $expected.Length) 'Vault round-trip changed the password length.'
    $buffer = [Runtime.InteropServices.Marshal]::SecureStringToCoTaskMemUnicode($Password)
    try {
        for ($index = 0; $index -lt $expected.Length; $index++) {
            Assert-Fixture ([uint16]([Runtime.InteropServices.Marshal]::ReadInt16($buffer, $index * 2) -band 0xffff) -eq [uint16]$expected[$index]) 'Vault round-trip changed a password code unit.'
        }
    } finally {
        for ($index = 0; $index -lt $Password.Length * 2; $index++) { [Runtime.InteropServices.Marshal]::WriteByte($buffer, $index, 0) }
        [Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($buffer)
    }
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User.Value
$userName = $identity.Name
$fixtureTarget = 'robloxstudio-mcp/credential-fixture/' + [Guid]::NewGuid().ToString('N')
$otherTarget = 'robloxstudio-mcp/credential-fixture/' + [Guid]::NewGuid().ToString('N')
$password = New-FixturePassword
$selection = $null
try {
    Assert-Fixture ($null -eq [StudioTestCredentialVault]::Read($fixtureTarget, $sid)) 'Unique fixture target unexpectedly existed.'
    [StudioTestCredentialVault]::Write($fixtureTarget, $userName, $password)
    [StudioTestCredentialVault]::Write($otherTarget, $userName, $password)
    $saved = [StudioTestCredentialVault]::Read($fixtureTarget, $sid)
    try { Assert-FixturePassword $saved.Password } finally { $saved.Password.Dispose() }
    Assert-FixtureThrows { [StudioTestCredentialVault]::Read($fixtureTarget, 'S-1-0-0') } 'Read accepted a credential for a different SID.'
    [StudioTestCredentialVault]::Delete($fixtureTarget)
    [StudioTestCredentialVault]::Delete($fixtureTarget)
    Assert-Fixture ($null -eq [StudioTestCredentialVault]::Read($fixtureTarget, $sid)) 'Idempotent deletion did not remove the named entry.'
    $saved = [StudioTestCredentialVault]::Read($otherTarget, $sid)
    try { Assert-FixturePassword $saved.Password } finally { $saved.Password.Dispose() }

    # Replace only the target-key seam: all native operations remain real and can
    # access only the unique synthetic entry, never the normal SID-keyed entry.
    function Get-StudioTestCredentialTarget { param([string]$TargetSid) return $fixtureTarget }
    $promptCount = 0
    function Read-Host {
        param([string]$Prompt, [switch]$AsSecureString)
        $script:promptCount++
        Assert-Fixture $AsSecureString.IsPresent 'Setup requested unmasked input.'
        return New-FixturePassword
    }
    Assert-FixtureThrows { Get-StudioTestLaunchCredential -Mode run -UserName $userName -TargetSid $sid } 'Run accepted a missing credential.'
    Assert-Fixture ($promptCount -eq 0) 'Run prompted for a missing credential.'
    $selection = Get-StudioTestLaunchCredential -Mode enroll -UserName $userName -TargetSid $sid
    Assert-Fixture ($promptCount -eq 1) 'First setup did not prompt exactly once.'
    Assert-Fixture ($null -eq [StudioTestCredentialVault]::Read($fixtureTarget, $sid)) 'Prompting persisted credentials before successful Windows logon.'
    Save-StudioTestCredentialAfterLogon -Selection $selection -TargetSid $sid
    $selection.Credential.Password.Dispose()
    $selection = $null
    foreach ($mode in @('enroll', 'run')) {
        $selection = Get-StudioTestLaunchCredential -Mode $mode -UserName $userName -TargetSid $sid
        Assert-FixturePassword $selection.Credential.Password
        Assert-Fixture ($promptCount -eq 1) 'Retry setup or run prompted despite valid saved credentials.'
        # Existing credentials must not be rewritten even if the entry is revoked
        # after selection. A run must not silently undo explicit revocation.
        Remove-StudioTestSavedCredential -TargetSid $sid
        Save-StudioTestCredentialAfterLogon -Selection $selection -TargetSid $sid
        Assert-Fixture ($null -eq [StudioTestCredentialVault]::Read($fixtureTarget, $sid)) 'An existing credential was saved again after revocation.'
        $selection.Credential.Password.Dispose()
        $selection = $null
        [StudioTestCredentialVault]::Write($fixtureTarget, $userName, $password)
    }
    foreach ($mode in @('enroll', 'run')) {
        Assert-FixtureThrows { Get-StudioTestLaunchCredential -Mode $mode -UserName $userName -TargetSid 'S-1-0-0' } 'Invalid saved identity was accepted.'
    }
    Assert-Fixture ($promptCount -eq 1) 'Invalid saved credentials fell back to prompting.'
    Remove-StudioTestSavedCredential -TargetSid $sid
    Remove-StudioTestSavedCredential -TargetSid $sid
    Assert-FixtureThrows { Get-StudioTestLaunchCredential -Mode run -UserName $userName -TargetSid $sid } 'Run continued after credential revocation.'
    Assert-Fixture ($promptCount -eq 1) 'Revoked run prompted.'
    function Read-Host {
        param([string]$Prompt, [switch]$AsSecureString)
        $script:promptCount++
        return [Security.SecureString]::new()
    }
    Assert-FixtureThrows { Get-StudioTestLaunchCredential -Mode enroll -UserName $userName -TargetSid $sid } 'Setup accepted an empty password.'
    Assert-Fixture ($null -eq [StudioTestCredentialVault]::Read($fixtureTarget, $sid)) 'An empty password was saved.'
    function Get-StudioTestSavedCredential { param([string]$TargetSid) throw 'Synthetic vault access failure' }
    foreach ($mode in @('enroll', 'run')) {
        Assert-FixtureThrows { Get-StudioTestLaunchCredential -Mode $mode -UserName $userName -TargetSid $sid } 'Vault access failure was ignored.'
    }
    Assert-Fixture ($promptCount -eq 2) 'Vault failure fell back to prompting.'
    Write-Output 'Studio credential vault and unattended mode fixtures passed'
} finally {
    if ($null -ne $selection) { $selection.Credential.Password.Dispose() }
    $password.Dispose()
    try { [StudioTestCredentialVault]::Delete($fixtureTarget) }
    finally { [StudioTestCredentialVault]::Delete($otherTarget) }
}
