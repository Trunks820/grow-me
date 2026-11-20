$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class KillOnCloseJob {
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits {
        public BasicLimits BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, IntPtr name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job, int infoClass, ref ExtendedLimits limits, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    private static void Check(bool ok, string operation) {
        if (ok) return;
        var error = new Win32Exception();
        throw new InvalidOperationException(operation + ": " + error.Message, error);
    }

    public static void AttachCurrentProcess() {
        const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
        const int JobObjectExtendedLimitInformation = 9;
        var job = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
        Check(job != IntPtr.Zero, "CreateJobObject");
        var limits = new ExtendedLimits();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation,
            ref limits, (uint)Marshal.SizeOf(limits)), "SetInformationJobObject");
        Check(AssignProcessToJobObject(job, GetCurrentProcess()), "AssignProcessToJobObject");
        // Only this PowerShell process has the job handle. Its exit closes the job.
    }
}
'@

[KillOnCloseJob]::AttachCurrentProcess()

$node = $env:GROW_ME_JOB_NODE
$root = $env:GROW_ME_JOB_ROOT
$session = $env:GROW_ME_JOB_SESSION
$controlScript = @'
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: true, windowsHide: true, stdio: 'ignore'
});
child.unref();
console.log(child.pid);
'@
$controlPid = & $node -e $controlScript
if ($LASTEXITCODE -ne 0) { throw 'Could not start the detached control process' }
[IO.File]::WriteAllText((Join-Path $root 'control-pid'), $controlPid)

$service = & $node $env:GROW_ME_JOB_START --state (Join-Path $root 'tree.json') --session $session
if ($LASTEXITCODE -ne 0) { throw 'start.mjs failed in the Job' }
[IO.File]::WriteAllText((Join-Path $root 'service.json'), $service)
$started = $service | ConvertFrom-Json

$heartbeat = & $node $env:GROW_ME_JOB_CHECK --url $started.url --session $session --heartbeat
[IO.File]::WriteAllText((Join-Path $root 'heartbeat.json'), $heartbeat)
exit $LASTEXITCODE
