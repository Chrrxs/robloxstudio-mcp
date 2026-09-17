using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

// Only job membership establishes ownership. Names select grace policy, never ownership.
public sealed class StudioWorkerJob : IDisposable
{
    const uint KillOnClose = 0x2000;
    const uint Query = 4, Assign = 1, Synchronize = 0x100000, QueryProcess = 0x1000;
    const uint WaitTimeout = 258, WaitFailed = 0xffffffff;
    IntPtr job;

    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime; public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit; public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A, B, C, D, E, F; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic; public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
        public int Size; public string Reserved, Desktop, Title;
        public uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
        public short Show, ReservedSize; public IntPtr ReservedBytes, Stdin, Stdout, Stderr;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfoEx {
        public StartupInfo Startup; public IntPtr Attributes;
    }
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
        public int Size; public IntPtr Descriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
        public IntPtr Process, Thread; public uint Pid, Tid;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int type, IntPtr data, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int type, IntPtr data, uint size, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetHandleInformation(IntPtr handle, out uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string exe, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes,
        bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, ref SecurityAttributes security,
        uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr attributes, int count, uint flags, ref UIntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, UIntPtr attribute,
        IntPtr value, UIntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")]
    static extern void DeleteProcThreadAttributeList(IntPtr attributes);

    static Exception Error(string operation) { return Error(Marshal.GetLastWin32Error(), operation); }
    static Exception Error(int code, string operation) {
        return new Win32Exception(code, operation + " (Win32 " + code + "): " + new Win32Exception(code).Message);
    }
    public static void ValidateName(string name) {
        if (name == null || !Regex.IsMatch(name, @"\ALocal\\RsmcpStudioWorker-[a-f0-9]{32}\z"))
            throw new ArgumentException("Invalid Studio test worker job name");
    }
    StudioWorkerJob(IntPtr handle) { job = handle; }
    public static StudioWorkerJob Create(string name, bool requireOuterJob) {
        ValidateName(name);
        bool contained;
        if (!IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out contained)) throw Error("Checking worker broker containment");
        if (requireOuterJob && !contained) throw new InvalidOperationException("Studio worker broker must inherit the outer harness job");
        IntPtr handle = CreateJobObjectW(IntPtr.Zero, name);
        int error = Marshal.GetLastWin32Error();
        if (handle == IntPtr.Zero) throw Error(error, "Creating Studio worker job");
        try {
            if (error == 183) throw new InvalidOperationException("Studio worker job name already exists");
            var limits = new ExtendedLimits(); limits.Basic.Flags = KillOnClose;
            int size = Marshal.SizeOf(typeof(ExtendedLimits));
            IntPtr data = Marshal.AllocHGlobal(size);
            try {
                Marshal.StructureToPtr(limits, data, false);
                if (!SetInformationJobObject(handle, 9, data, (uint)size)) throw Error("Configuring Studio worker job");
            } finally { Marshal.FreeHGlobal(data); }
            ValidateHandle(handle);
            return new StudioWorkerJob(handle);
        } catch { CloseHandle(handle); throw; }
    }
    static void ValidateHandle(IntPtr handle) {
        uint flags;
        if (!GetHandleInformation(handle, out flags)) throw Error("Checking Studio worker job handle");
        if ((flags & 1) != 0) throw new InvalidOperationException("Studio worker job handle must not be inheritable");
        int size = Marshal.SizeOf(typeof(ExtendedLimits));
        IntPtr data = Marshal.AllocHGlobal(size);
        try {
            uint returned;
            if (!QueryInformationJobObject(handle, 9, data, (uint)size, out returned)) throw Error("Checking Studio worker job limits");
            if (returned != size || ((ExtendedLimits)Marshal.PtrToStructure(data, typeof(ExtendedLimits))).Basic.Flags != KillOnClose)
                throw new InvalidOperationException("Studio worker job must retain kill-on-close without breakaway");
        } finally { Marshal.FreeHGlobal(data); }
    }
    public static StudioWorkerJob Open(string name) {
        ValidateName(name);
        IntPtr handle = OpenJobObjectW(Query | Assign, false, name);
        if (handle == IntPtr.Zero) throw Error("Opening Studio worker job");
        try { ValidateHandle(handle); return new StudioWorkerJob(handle); }
        catch { CloseHandle(handle); throw; }
    }
    uint[] ProcessIds() {
        if (job == IntPtr.Zero) throw new InvalidOperationException("Studio worker job is closed");
        for (int capacity = 32; capacity <= 1048576; capacity *= 2) {
            int size = checked(8 + capacity * IntPtr.Size);
            IntPtr data = Marshal.AllocHGlobal(size);
            try {
                uint returned;
                if (!QueryInformationJobObject(job, 3, data, (uint)size, out returned)) {
                    if (Marshal.GetLastWin32Error() == 234) continue;
                    throw Error("Enumerating Studio worker job membership");
                }
                uint assigned = (uint)Marshal.ReadInt32(data, 0), count = (uint)Marshal.ReadInt32(data, 4);
                if (assigned > count) continue;
                if (count > capacity) throw new InvalidOperationException("Invalid Studio worker job membership response");
                var ids = new uint[count];
                for (int i = 0; i < count; i++) ids[i] = checked((uint)Marshal.ReadIntPtr(data, 8 + i * IntPtr.Size).ToInt64());
                return ids;
            } finally { Marshal.FreeHGlobal(data); }
        }
        throw new InvalidOperationException("Studio worker membership exceeded bounded query capacity");
    }
    static bool Alive(IntPtr process) {
        uint result = WaitForSingleObject(process, 0);
        if (result == WaitFailed) throw Error("Waiting for owned Studio worker process");
        if (result != 0 && result != WaitTimeout) throw new InvalidOperationException("Unexpected process wait result");
        return result == WaitTimeout;
    }
    List<IntPtr> OpenMembers() {
        var handles = new List<IntPtr>();
        try {
            foreach (uint pid in ProcessIds()) {
                IntPtr handle = OpenProcess(QueryProcess | Synchronize, false, pid);
                if (handle == IntPtr.Zero) {
                    int error = Marshal.GetLastWin32Error();
                    if (error == 87) continue; // Exited between snapshot and OpenProcess.
                    throw Error(error, "Opening owned Studio worker process");
                }
                bool member;
                if (!IsProcessInJob(handle, job, out member)) {
                    Exception error = Error("Verifying Studio worker process membership");
                    CloseHandle(handle); throw error;
                }
                if (!member) { CloseHandle(handle); continue; } // Reused PID is never owned.
                handles.Add(handle);
            }
            return handles;
        } catch { foreach (IntPtr handle in handles) CloseHandle(handle); throw; }
    }
    static string ImageName(IntPtr process, uint exitWaitMs) {
        var buffer = new StringBuilder(32768); uint size = (uint)buffer.Capacity;
        if (!QueryFullProcessImageNameW(process, 0, buffer, ref size)) {
            Exception error = Error("Reading owned Studio worker executable");
            // Windows may withdraw image-query access before signaling process
            // exit. Only this retained, membership-verified handle can settle
            // that race; a live/unknown handle keeps the original error fatal.
            if (WaitForSingleObject(process, exitWaitMs) == 0) return "";
            throw error;
        }
        return Path.GetFileName(buffer.ToString());
    }
    // Test fixtures pass a controlled executable basename, never a real installer.
    public void Drain(int installerGraceMs, int drainTimeoutMs, string[] installerNames) {
        if (installerGraceMs < 0 || installerGraceMs > 600000 || drainTimeoutMs < 1 || drainTimeoutMs > 30000)
            throw new ArgumentOutOfRangeException("Worker drain budgets are out of range");
        var installers = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string name in installerNames) {
            if (String.IsNullOrEmpty(name) || Path.GetFileName(name) != name)
                throw new ArgumentException("Installer predicate must contain only executable basenames");
            installers.Add(name);
        }
        var clock = Stopwatch.StartNew();
        bool previouslyIdle = false;
        bool reportedInstallerWait = false;
        while (true) {
            bool installing = false;
            var handles = OpenMembers();
            try {
                foreach (IntPtr handle in handles) {
                    if (!Alive(handle)) continue;
                    long graceRemaining = Math.Max(0, installerGraceMs - clock.ElapsedMilliseconds);
                    uint exitWaitMs = (uint)Math.Min(1000, graceRemaining);
                    if (installers.Contains(ImageName(handle, exitWaitMs))) installing = true;
                }
            } finally { foreach (IntPtr handle in handles) CloseHandle(handle); }
            // Replacement installers inherit this job too. Require two idle observations.
            if (!installing && previouslyIdle) break;
            previouslyIdle = !installing;
            if (installing && !reportedInstallerWait) {
                try {
                    Console.Error.WriteLine("Waiting up to " + installerGraceMs + "ms for owned Studio installer processes before worker cleanup.");
                    Console.Error.Flush();
                } catch (IOException) {
                    // The parent may have exited and closed its diagnostic pipe.
                    // Ownership checks and drain errors must still propagate.
                }
                reportedInstallerWait = true;
            }
            if (installing && clock.ElapsedMilliseconds >= installerGraceMs)
                throw new TimeoutException("Owned Studio installer did not finish within worker grace; retaining worker directory");
            int interval = installing
                ? (int)Math.Min(250, Math.Max(1, installerGraceMs - clock.ElapsedMilliseconds))
                : 250;
            Thread.Sleep(interval);
        }
        var remaining = OpenMembers();
        try {
            if (!TerminateJobObject(job, 1)) throw Error("Terminating owned Studio worker helpers");
            clock.Restart();
            while (true) {
                bool alive = false;
                foreach (IntPtr handle in remaining) if (Alive(handle)) alive = true;
                if (!alive && ProcessIds().Length == 0) return;
                if (clock.ElapsedMilliseconds >= drainTimeoutMs)
                    throw new TimeoutException("Studio worker job did not drain; retaining worker directory");
                Thread.Sleep(20);
            }
        } finally { foreach (IntPtr handle in remaining) CloseHandle(handle); }
    }
    public static string Quote(string value) {
        if (value.Length > 0 && !Regex.IsMatch(value, "[\\s\"]")) return value;
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); result.Append(c); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    public uint Launch(string executable, string[] args, string cwd) {
        if (!Path.IsPathRooted(executable) || !Path.IsPathRooted(cwd)) throw new ArgumentException("Worker launch needs absolute Windows paths");
        var command = new StringBuilder(Quote(executable));
        foreach (string arg in args) command.Append(' ').Append(Quote(arg));
        IntPtr input = IntPtr.Zero, output = IntPtr.Zero, attributes = IntPtr.Zero, inherited = IntPtr.Zero;
        bool attributesInitialized = false;
        IntPtr invalidHandle = new IntPtr(-1);
        try {
            var security = new SecurityAttributes();
            security.Size = Marshal.SizeOf(security);
            security.Inherit = true;
            input = CreateFileW("NUL", 0x80000000, 3, ref security, 3, 0x80, IntPtr.Zero);
            if (input == invalidHandle) throw Error("Opening worker NUL stdin");
            output = CreateFileW("NUL", 0x40000000, 3, ref security, 3, 0x80, IntPtr.Zero);
            if (output == invalidHandle) throw Error("Opening worker NUL stdout/stderr");

            UIntPtr bytes = UIntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref bytes);
            if (bytes == UIntPtr.Zero) throw Error("Sizing worker startup attributes");
            attributes = Marshal.AllocHGlobal(checked((int)bytes.ToUInt64()));
            if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref bytes))
                throw Error("Initializing worker startup attributes");
            attributesInitialized = true;
            inherited = Marshal.AllocHGlobal(IntPtr.Size * 2);
            Marshal.WriteIntPtr(inherited, 0, input);
            Marshal.WriteIntPtr(inherited, IntPtr.Size, output);
            // PROC_THREAD_ATTRIBUTE_HANDLE_LIST restricts inheritance to valid
            // ignored stdio. Never leak control pipes or ownership job handles.
            if (!UpdateProcThreadAttribute(attributes, 0, new UIntPtr(0x00020002),
                inherited, new UIntPtr((uint)(IntPtr.Size * 2)), IntPtr.Zero, IntPtr.Zero))
                throw Error("Whitelisting worker NUL handles");
            var startup = new StartupInfoEx();
            startup.Startup.Size = Marshal.SizeOf(startup);
            startup.Startup.Flags = 0x00000100; // STARTF_USESTDHANDLES
            startup.Startup.Stdin = input;
            startup.Startup.Stdout = output;
            startup.Startup.Stderr = output;
            startup.Attributes = attributes;
            ProcessInfo child;
            const uint CreateSuspended = 0x00000004, CreateNoWindow = 0x08000000, ExtendedStartupInfoPresent = 0x00080000;
            // Valid NUL stdio and no shared console keep the launcher's control
            // pipes independent of the child. No kernel job breakaway is used.
            if (!CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true,
                CreateSuspended | CreateNoWindow | ExtendedStartupInfoPresent,
                IntPtr.Zero, cwd, ref startup, out child))
                throw Error("Creating suspended worker process");
            try {
                if (!AssignProcessToJobObject(job, child.Process)) throw Error("Assigning suspended worker process");
                if (ResumeThread(child.Thread) == 0xffffffff) throw Error("Resuming owned worker process");
                return child.Pid;
            } catch {
                if (!TerminateProcess(child.Process, 1) && Alive(child.Process)) throw Error("Aborting suspended worker process");
                if (WaitForSingleObject(child.Process, 15000) != 0) throw new InvalidOperationException("Suspended worker process failed to terminate");
                throw;
            } finally { CloseHandle(child.Thread); CloseHandle(child.Process); }
        } finally {
            if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
            Marshal.FreeHGlobal(attributes);
            Marshal.FreeHGlobal(inherited);
            if (input != IntPtr.Zero && input != invalidHandle) CloseHandle(input);
            if (output != IntPtr.Zero && output != invalidHandle) CloseHandle(output);
        }
    }
    public void Dispose() { if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; } }
}
