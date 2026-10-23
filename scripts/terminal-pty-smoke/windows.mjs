import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
// 只读取进程归属与可见控制台窗口身份，不采集窗口标题或用户环境。
const source = `
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class DeviceForgePtyObservation {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Entry {
    public uint Size, Usage, ProcessId;
    public UIntPtr DefaultHeapId;
    public uint ModuleId, Threads, ParentProcessId;
    public int Priority;
    public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Filename;
  }
  public class ProcessEntry { public int pid; public int parent; public string executable; }
  public class WindowEntry { public string handle; public int pid; public string class_name; }
  delegate bool Visitor(IntPtr window, IntPtr unused);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot,ref Entry entry);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot,ref Entry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("user32.dll")] static extern bool EnumWindows(Visitor visitor,IntPtr unused);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr window,StringBuilder text,int size);
  public static ProcessEntry[] Processes() {
    IntPtr snapshot=CreateToolhelp32Snapshot(2,0);
    if(snapshot==new IntPtr(-1)) throw new Win32Exception();
    try {
      var result=new List<ProcessEntry>();
      var entry=new Entry { Size=(uint)Marshal.SizeOf(typeof(Entry)) };
      if(!Process32FirstW(snapshot,ref entry)) throw new Win32Exception();
      do { result.Add(new ProcessEntry { pid=(int)entry.ProcessId,parent=(int)entry.ParentProcessId,executable=entry.Filename }); }
      while(Process32NextW(snapshot,ref entry));
      if(Marshal.GetLastWin32Error()!=18) throw new Win32Exception();
      return result.ToArray();
    } finally { CloseHandle(snapshot); }
  }
  public static WindowEntry[] Windows() {
    var result=new List<WindowEntry>();
    EnumWindows(delegate(IntPtr window,IntPtr unused) {
      if(!IsWindowVisible(window)) return true;
      var text=new StringBuilder(256); GetClassNameW(window,text,text.Capacity);
      string name=text.ToString();
      if(name!="ConsoleWindowClass" && name!="CASCADIA_HOSTING_WINDOW_CLASS") return true;
      uint process; GetWindowThreadProcessId(window,out process);
      result.Add(new WindowEntry { handle=window.ToInt64().ToString("x"),pid=(int)process,class_name=name });
      return true;
    },IntPtr.Zero);
    return result.ToArray();
  }
}
`;

export async function windowsObservation(ownerPid) {
  if (!Number.isSafeInteger(ownerPid) || ownerPid < 1) throw new Error('观察归属PID无效');
  const script = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
${source}
'@
$all=@([DeviceForgePtyObservation]::Processes())
$owned=[Collections.Generic.HashSet[int]]::new()
$null=$owned.Add(${ownerPid})
do {
  $changed=$false
  foreach($entry in $all) { if($owned.Contains($entry.parent) -and $owned.Add($entry.pid)) { $changed=$true } }
} while($changed)
@{ at=[DateTime]::UtcNow.ToString('o'); owner_pid=${ownerPid}; processes=@($all | Where-Object { $owned.Contains($_.pid) }); console_windows=@([DeviceForgePtyObservation]::Windows()) } | ConvertTo-Json -Compress -Depth 5
`;
  const result = await execute('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], { windowsHide: true, timeout: 15000, maxBuffer: 1048576, encoding: 'utf8' });
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
}

export function newConsoleWindows(before, after) {
  const known = new Set(before.console_windows.map((entry) => entry.handle));
  const owned = new Set(after.processes.map((entry) => entry.pid));
  return after.console_windows.filter((entry) => !known.has(entry.handle) && owned.has(entry.pid));
}
