param([string]$DeniedSourceSid)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class StudioFixtureProcessAccess {
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeFileHandle OpenProcess(uint access, bool inherit, uint id);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetKernelObjectSecurity(IntPtr handle, uint information, IntPtr descriptor);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
    public static void RestrictCurrentProcess(string sourceSid, string targetSid) {
        // Deny SYNCHRONIZE to the source, while allowing QUERY_LIMITED_INFORMATION.
        // Only this disposable fixture process changes its own security descriptor.
        string sddl = "D:(D;;0x100000;;;" + sourceSid + ")(A;;0x1000;;;" + sourceSid + ")(A;;GA;;;" + targetSid + ")(A;;GA;;;SY)";
        IntPtr descriptor;
        uint size;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out descriptor, out size)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            if (!SetKernelObjectSecurity(GetCurrentProcess(), 4, descriptor)) throw new Win32Exception(Marshal.GetLastWin32Error());
        } finally { LocalFree(descriptor); }
    }
    public static void AssertQueryOnlyAccess(uint id) {
        // Permission probes only: never wait, query an image, or terminate by PID.
        // Production classification separately verifies exact job membership on
        // its retained query-only handle before inspecting the same live helper.
        using (SafeFileHandle synchronized = OpenProcess(0x101000, false, id)) {
            int error = Marshal.GetLastWin32Error();
            if (!synchronized.IsInvalid || error != 5) throw new InvalidOperationException("Fixture did not deny SYNCHRONIZE to the source account; error " + error);
        }
        using (SafeFileHandle queryOnly = OpenProcess(0x1000, false, id)) {
            if (queryOnly.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Fixture denied QUERY_LIMITED_INFORMATION unexpectedly");
        }
    }
}
'@

if ($DeniedSourceSid) {
    $targetSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($DeniedSourceSid -notmatch '^S-1-5-21-(\d+-){3}\d+$' -or $DeniedSourceSid -eq $targetSid) {
        throw 'Restricted helper requires a different source-account SID.'
    }
    [StudioFixtureProcessAccess]::RestrictCurrentProcess($DeniedSourceSid, $targetSid)
    [Console]::Out.WriteLine('leftover-ready')
    [Console]::Out.WriteLine('restricted-helper-pid:' + $PID)
    # Inherit the already-owned stdin/stdout pipes. Only explicit fixture job
    # cleanup closes this live helper; source classification must not wait for it.
    if ([Console]::In.ReadLine() -ne 'exit') { throw 'Unexpected restricted-helper stdin completion.' }
}
