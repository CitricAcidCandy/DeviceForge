// Win32 查询只返回身份与端口，不读取环境变量、命令行参数或设备状态。
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const processTree = `
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class DeviceForgeProcessTree {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct Entry {
    public uint Size, Usage, ProcessId;
    public UIntPtr DefaultHeapId;
    public uint ModuleId, Threads, ParentProcessId;
    public int Priority;
    public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Filename;
  }
  [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
  public static int[] Children(uint parent) {
    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) throw new Win32Exception();
    try {
      var children = new List<int>();
      var entry = new Entry { Size = (uint)Marshal.SizeOf(typeof(Entry)) };
      if (!Process32FirstW(snapshot, ref entry)) throw new Win32Exception();
      do { if (entry.ParentProcessId == parent) children.Add((int)entry.ProcessId); } while (Process32NextW(snapshot, ref entry));
      if (Marshal.GetLastWin32Error() != 18) throw new Win32Exception();
      return children.ToArray();
    } finally { CloseHandle(snapshot); }
  }
}
'@
`;

async function executePowerShell(script, timeout, maxBuffer) {
  return execute(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { windowsHide: true, timeout, encoding: 'utf8', maxBuffer },
  );
}

function listeningConnections(output) {
  const connections = [];
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== 'TCP' || fields[3] !== 'LISTENING') continue;
    const localPort = fields[1]?.match(/:(\d+)$/)?.[1];
    const port = Number(localPort);
    const pid = Number(fields[4]);
    if (
      fields.length !== 5 ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !Number.isInteger(pid) ||
      pid < 0
    )
      throw new Error('监听信息格式无效');
    connections.push({ port, pid });
  }
  return connections;
}

export const sameBinary = (left, right) =>
  resolve(left).toLowerCase() === resolve(right).toLowerCase();
export const sameIdentity = (left, right) =>
  Boolean(
    left &&
      right &&
      left.pid === right.pid &&
      left.startTime === right.startTime &&
      sameBinary(left.binary, right.binary),
  );

export async function processSnapshot(port, pid = 0) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(pid) || pid < 0)
    throw new Error('进程身份查询参数无效');
  if (process.platform !== 'win32') throw new Error('当前进程控制只支持 Windows');
  try {
    const result = await execute('netstat.exe', ['-ano', '-p', 'tcp'], {
      windowsHide: true,
      timeout: 5000,
      encoding: 'utf8',
      maxBuffer: 1048576,
    });
    const connections = listeningConnections(result.stdout);
    const owners = [
      ...new Set(connections.filter((entry) => entry.port === port).map((entry) => entry.pid)),
    ];
    const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function Identity([int]$processId) {
  try { $entry = [Diagnostics.Process]::GetProcessById($processId) }
  catch [ArgumentException] { return $null }
  try {
    $null = $entry.Handle
    $binary = $entry.MainModule.FileName
    if (-not $binary) { throw '进程身份不可读取' }
    return @{ pid = [int]$entry.Id; binary = $binary; startTime = $entry.StartTime.ToUniversalTime().ToString('o') }
  } finally { $entry.Dispose() }
}
$listeners = @()
foreach ($owner in @(${owners.join(',')})) {
  $entry = Identity $owner
  if ($null -eq $entry) { throw '监听进程在查询期间变化' }
  $listeners += $entry
}
$target = $null; $children = @(); $ports = @()
if (${pid} -gt 0) {
  $target = Identity ${pid}
  $console = [IO.Path]::Combine([Environment]::GetFolderPath('System'), 'conhost.exe')
  ${pid > 0 ? processTree : ''}
  foreach ($childId in @([DeviceForgeProcessTree]::Children(${pid}))) {
    try { $child = Identity $childId }
    catch { $children += @{ pid = [int]$childId; binary = $null; systemConsole = $false }; continue }
    if ($null -ne $child) {
      $children += @{ pid = [int]$childId; binary = $child.binary; systemConsole = [String]::Equals($child.binary, $console, [StringComparison]::OrdinalIgnoreCase) }
    }
  }
  $ports = @(${[...new Set(connections.filter((entry) => entry.pid === pid).map((entry) => entry.port))].join(',')})
}
@{ listeners = $listeners; target = $target; children = $children; listeningPorts = $ports } | ConvertTo-Json -Compress -Depth 4
`;
    const snapshot = await executePowerShell(script, 7000, 65536);
    return JSON.parse(snapshot.stdout.replace(/^\uFEFF/, '').trim());
  } catch {
    throw new Error('无法查询后端进程状态，请确认系统查询工具可用后重试');
  }
}

export function ownedListener(config, snapshot) {
  if (snapshot.listeners.length === 0) return null;
  if (snapshot.listeners.length !== 1 || !sameBinary(snapshot.listeners[0].binary, config.binary))
    throw new Error(`端口 ${config.port} 由其他进程占用，不能接管或停止`);
  return snapshot.listeners[0];
}

export async function terminateIdentity(identity) {
  if (
    !identity ||
    !Number.isInteger(identity.pid) ||
    identity.pid <= 0 ||
    typeof identity.binary !== 'string' ||
    !identity.binary ||
    typeof identity.startTime !== 'string' ||
    !identity.startTime
  )
    throw new Error('结束进程前缺少完整身份');
  const expected = Buffer.from(JSON.stringify(identity), 'utf8').toString('base64');
  const script = `
$ErrorActionPreference = 'Stop'
$expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${expected}')) | ConvertFrom-Json
$owned = [Diagnostics.Process]::GetProcessById($expected.pid)
try {
  $null = $owned.Handle
  if ($owned.StartTime.ToUniversalTime().ToString('o') -ne $expected.startTime -or
    -not [String]::Equals($owned.MainModule.FileName, $expected.binary, [StringComparison]::OrdinalIgnoreCase)) {
    throw '结束前进程身份发生变化'
  }
  $owned.Kill()
} finally { $owned.Dispose() }
`;
  try {
    await executePowerShell(script, 5000, 4096);
  } catch {
    throw new Error('无法核对并停止后端进程，请重新查询状态后重试');
  }
}
