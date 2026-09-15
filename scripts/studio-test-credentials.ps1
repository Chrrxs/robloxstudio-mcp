# Loaded only by the source launcher, never by the credentialed child.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.Principal;
public static class StudioTestCredentialVault {
    private const uint Generic = 1;
    private const uint LocalMachine = 2; // This user's vault on this machine, not all users.
    private const int NotFound = 1168;
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential {
        public uint Flags, Type;
        public string TargetName, Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist, AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias, UserName;
    }
    public sealed class SavedCredential {
        public string UserName { get; private set; }
        public SecureString Password { get; private set; }
        internal SavedCredential(string userName, SecureString password) {
            UserName = userName;
            Password = password;
        }
    }
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref Credential credential, uint flags);
    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, uint type, uint flags);
    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr credential);
    public static SavedCredential Read(string target, string expectedSid) {
        IntPtr allocation;
        if (!CredRead(target, Generic, 0, out allocation)) {
            int error = Marshal.GetLastWin32Error();
            if (error == NotFound) return null;
            throw new Win32Exception(error);
        }
        Credential value = new Credential();
        SecureString password = null;
        try {
            value = (Credential)Marshal.PtrToStructure(allocation, typeof(Credential));
            if (value.Type != Generic || value.TargetName != target || value.Persist != LocalMachine ||
                String.IsNullOrEmpty(value.UserName) || value.CredentialBlob == IntPtr.Zero ||
                value.CredentialBlobSize == 0 || value.CredentialBlobSize > 2560 || value.CredentialBlobSize % 2 != 0) {
                throw new InvalidOperationException("Saved Studio credential has invalid metadata.");
            }
            string actualSid = new NTAccount(value.UserName).Translate(typeof(SecurityIdentifier)).Value;
            if (!String.Equals(actualSid, expectedSid, StringComparison.Ordinal)) {
                throw new InvalidOperationException("Saved Studio credential belongs to a different Windows SID.");
            }
            password = new SecureString();
            for (int offset = 0; offset < value.CredentialBlobSize; offset += 2) {
                password.AppendChar((char)(ushort)Marshal.ReadInt16(value.CredentialBlob, offset));
            }
            password.MakeReadOnly();
            SavedCredential result = new SavedCredential(value.UserName, password);
            password = null; // Ownership transfers to the caller.
            return result;
        } finally {
            if (password != null) password.Dispose();
            if (value.CredentialBlob != IntPtr.Zero) {
                for (int offset = 0; offset < value.CredentialBlobSize; offset++) Marshal.WriteByte(value.CredentialBlob, offset, 0);
            }
            CredFree(allocation);
        }
    }
    public static void Write(string target, string userName, SecureString password) {
        if (password == null || password.Length == 0 || password.Length > 1280) {
            throw new ArgumentException("Studio credential password must contain 1 to 1280 UTF-16 code units.");
        }
        IntPtr plaintext = IntPtr.Zero;
        try {
            plaintext = Marshal.SecureStringToCoTaskMemUnicode(password);
            Credential value = new Credential();
            value.Type = Generic;
            value.TargetName = target;
            value.UserName = userName;
            value.CredentialBlob = plaintext;
            value.CredentialBlobSize = checked((uint)password.Length * 2);
            value.Persist = LocalMachine;
            if (!CredWrite(ref value, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        } finally {
            if (plaintext != IntPtr.Zero) {
                // Explicit length also clears any code units after an embedded NUL.
                for (int offset = 0; offset < password.Length * 2; offset++) Marshal.WriteByte(plaintext, offset, 0);
                Marshal.ZeroFreeCoTaskMemUnicode(plaintext);
            }
        }
    }
    public static void Delete(string target) {
        if (!CredDelete(target, Generic, 0)) {
            int error = Marshal.GetLastWin32Error();
            if (error != NotFound) throw new Win32Exception(error);
        }
    }
}
'@

function Get-StudioTestCredentialTarget {
    param([Parameter(Mandatory = $true)][string]$TargetSid)
    if ($TargetSid -notmatch '^S-1-5-21-(\d+-){3}\d+$') { throw 'A dedicated local/domain Windows SID is required for the saved credential.' }
    return 'robloxstudio-mcp/studio-test-profile/' + $TargetSid
}

function Get-StudioTestSavedCredential {
    param([Parameter(Mandatory = $true)][string]$TargetSid)
    $saved = [StudioTestCredentialVault]::Read((Get-StudioTestCredentialTarget -TargetSid $TargetSid), $TargetSid)
    if ($null -ne $saved) {
        try { return [Management.Automation.PSCredential]::new($saved.UserName, $saved.Password) }
        catch { $saved.Password.Dispose(); throw }
    }
}

function Read-StudioTestCredential {
    param([Parameter(Mandatory = $true)][string]$UserName)
    $password = Read-Host -Prompt ('Password for ' + $UserName + ' (masked; saved to this source user Windows Credential Manager vault after successful Windows logon, never logged or passed as an argument)') -AsSecureString
    if ($null -eq $password -or $password.Length -eq 0) {
        if ($null -ne $password) { $password.Dispose() }
        throw 'No password entered. Retry setup with the dedicated Windows account password.'
    }
    return [Management.Automation.PSCredential]::new($UserName, $password)
}

function Get-StudioTestLaunchCredential {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('enroll', 'run')][string]$Mode,
        [Parameter(Mandatory = $true)][string]$UserName,
        [Parameter(Mandatory = $true)][string]$TargetSid
    )
    $reauthorize = 'Reauthorize with node scripts/studio-test-profile.mjs forget --user <account>, then node scripts/studio-test-profile.mjs setup --user <account>.'
    try { $credential = Get-StudioTestSavedCredential -TargetSid $TargetSid }
    catch { throw ('Cannot read a valid saved Studio credential. No password prompt was opened. ' + $reauthorize + ' ' + $_.Exception.Message) }
    $needsSave = $false
    if ($null -eq $credential) {
        if ($Mode -eq 'run') { throw ('No saved Studio credential for this Windows SID in the source user vault. Runs never prompt. Run node scripts/studio-test-profile.mjs setup --user <account> once to authorize automated tests.') }
        $credential = Read-StudioTestCredential -UserName $UserName
        $needsSave = $true
    }
    try {
        $account = New-Object Security.Principal.NTAccount($credential.UserName)
        if ($account.Translate([Security.Principal.SecurityIdentifier]).Value -ne $TargetSid) {
            throw ('The credential belongs to a different Windows SID from --user. ' + $reauthorize)
        }
        return [PSCustomObject]@{ Credential = $credential; NeedsSave = $needsSave }
    } catch { $credential.Password.Dispose(); throw }
}

function Save-StudioTestCredentialAfterLogon {
    param(
        [Parameter(Mandatory = $true)]$Selection,
        [Parameter(Mandatory = $true)][string]$TargetSid
    )
    if ($Selection.NeedsSave) {
        $target = Get-StudioTestCredentialTarget -TargetSid $TargetSid
        [StudioTestCredentialVault]::Write($target, $Selection.Credential.UserName, $Selection.Credential.Password)
        $Selection.NeedsSave = $false
        Write-Host 'Saved credential in this source user Windows Credential Manager vault on this machine. Subsequent runs are unattended; no password is logged or passed as an argument.'
    }
}

function Remove-StudioTestSavedCredential {
    param([Parameter(Mandatory = $true)][string]$TargetSid)
    [StudioTestCredentialVault]::Delete((Get-StudioTestCredentialTarget -TargetSid $TargetSid))
}
