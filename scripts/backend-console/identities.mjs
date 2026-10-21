// Win32 查询只返回身份与端口，不读取环境变量、命令行参数或设备状态。
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
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
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function Identity($entry) {
  if ($null -eq $entry) { return $null }
  if (-not $entry.ExecutablePath -or -not $entry.CreationDate) { throw '进程身份不可读取' }
  return @{ pid = [int]$entry.ProcessId; binary = $entry.ExecutablePath; startTime = $entry.CreationDate.ToUniversalTime().ToString('o') }
}
$connections = @(Get-NetTCPConnection -State Listen -ErrorAction Stop)
$owners = @($connections | Where-Object { $_.LocalPort -eq ${port} } | Select-Object -ExpandProperty OwningProcess -Unique)
$listeners = @()
foreach ($owner in $owners) {
  $entry = Get-CimInstance Win32_Process -Filter "ProcessId = $owner"
  if ($null -eq $entry) { throw '监听进程在查询期间变化' }
  $listeners += (Identity $entry)
}
$target = $null; $children = @(); $ports = @()
if (${pid} -gt 0) {
  $target = Identity (Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}')
  $console = [IO.Path]::Combine([Environment]::GetFolderPath('System'), 'conhost.exe')
  $children = @(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${pid}' | ForEach-Object {
    @{ pid = [int]$_.ProcessId; binary = $_.ExecutablePath; systemConsole = [String]::Equals($_.ExecutablePath, $console, [StringComparison]::OrdinalIgnoreCase) }
  })
  $ports = @($connections | Where-Object { $_.OwningProcess -eq ${pid} } | Select-Object -ExpandProperty LocalPort -Unique)
}
@{ listeners = $listeners; target = $target; children = $children; listeningPorts = $ports } | ConvertTo-Json -Compress -Depth 4
`;
  const result = await execute(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { windowsHide: true, timeout: 7000, encoding: 'utf8', maxBuffer: 65536 },
  );
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
}

export function ownedListener(config, snapshot) {
  if (snapshot.listeners.length === 0) return null;
  if (snapshot.listeners.length !== 1 || !sameBinary(snapshot.listeners[0].binary, config.binary))
    throw new Error(`端口 ${config.port} 由其他进程占用，不能接管或停止`);
  return snapshot.listeners[0];
}

export async function terminateIdentity(identity) {
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 0)
    throw new Error('结束进程前缺少完整身份');
  const expected = Buffer.from(JSON.stringify(identity), 'utf8').toString('base64');
  const script = `
$ErrorActionPreference = 'Stop'
$expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${expected}')) | ConvertFrom-Json
$owned = Get-Process -Id $expected.pid -ErrorAction Stop
try {
  # 先固定原进程句柄，再检查 Win32 身份；结束操作不会命中新复用的 PID。
  $null = $owned.Handle
  $observed = Get-CimInstance Win32_Process -Filter "ProcessId = $($expected.pid)"
  if ($null -eq $observed -or $observed.CreationDate.ToUniversalTime().ToString('o') -ne $expected.startTime -or
    -not [String]::Equals($observed.ExecutablePath, $expected.binary, [StringComparison]::OrdinalIgnoreCase)) {
    throw '结束前进程身份发生变化'
  }
  $owned.Kill()
} finally { $owned.Dispose() }
`;
  await execute(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { windowsHide: true, timeout: 5000, encoding: 'utf8', maxBuffer: 4096 },
  );
}
