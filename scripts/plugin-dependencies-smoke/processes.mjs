// 只回收命令或可执行文件属于本轮新证据根的进程；不能按旧 PID 盲杀。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join, win32 } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const powershell = () => join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');

export async function listenerOwners(port) {
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  const { stdout } = await execute(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    'ConvertTo-Json -Compress -InputObject @(Get-NetTCPConnection -State Listen -LocalPort $env:DF_SMOKE_PORT -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)'],
  { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, env: { ...process.env, DF_SMOKE_PORT: String(port) } });
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim() || '[]');
}

export function belongsToRun(candidate, root, hosts = [], driver = process.pid) {
  const prefix = win32.resolve(root).replaceAll('/', '\\').toLowerCase().replace(/\\+$/, '') + '\\';
  const executable = candidate.ExecutablePath?.replaceAll('/', '\\').toLowerCase() ?? '';
  const command = candidate.CommandLine?.replaceAll('/', '\\').toLowerCase() ?? '';
  if (!executable.startsWith(prefix) && !command.includes(prefix)) return false;
  const ancestors = candidate.Ancestry == null ? []
    : Array.isArray(candidate.Ancestry) ? candidate.Ancestry : [candidate.Ancestry];
  const ancestry = [candidate, ...ancestors];
  if (ancestry.some((item) => item.ParentProcessId === driver)) return true;
  // 宿主退出后，直系子进程仍可凭创建时间落在已记录的宿主存活窗口内确认归属。
  return hosts.some((host) => host.pid && host.exit && ancestry.some((item) =>
    item.ParentProcessId === host.pid && Date.parse(item.CreatedAt) >= Date.parse(host.started_at)
      && Date.parse(item.CreatedAt) <= Date.parse(host.exit.at)));
}

export async function ownedProcesses(root, hosts = []) {
  if (process.platform !== 'win32') throw new Error('当前进程归属审计仅支持 Windows，本轮不外推其他平台');
  const script = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $root=$env:DF_SMOKE_AUDIT_ROOT.TrimEnd('\\')+'\\'; $driver=[int]$env:DF_SMOKE_DRIVER_PID; "
    + "$all=@(Get-CimInstance Win32_Process); $byId=@{}; foreach($item in $all){$byId[[int]$item.ProcessId]=$item}; "
    + "$items=@($all | Where-Object { $_.ProcessId -ne $PID -and $_.ProcessId -ne $driver -and "
    + "(($_.ExecutablePath -and $_.ExecutablePath.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0) -or "
    + "($_.CommandLine -and $_.CommandLine.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0)) } | "
    + "Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{n='CreatedAt';e={$_.CreationDate.ToUniversalTime().ToString('o')}},"
    + "@{n='Ancestry';e={$parent=[int]$_.ParentProcessId; $created=$_.CreationDate; $seen=@{}; $chain=@(); while($byId.ContainsKey($parent) -and !$seen.ContainsKey($parent) -and $chain.Count -lt 64){"
    + "$seen[$parent]=$true; $ancestor=$byId[$parent]; if($ancestor.CreationDate -gt $created){break}; $chain+=@{ProcessId=$parent;ParentProcessId=[int]$ancestor.ParentProcessId;CreatedAt=$ancestor.CreationDate.ToUniversalTime().ToString('o')};"
    + "$created=$ancestor.CreationDate; $parent=[int]$ancestor.ParentProcessId}; ,$chain}}); ConvertTo-Json -InputObject $items -Depth 6 -Compress";
  const { stdout } = await execute(powershell(),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, DF_SMOKE_AUDIT_ROOT: root, DF_SMOKE_DRIVER_PID: String(process.pid) } });
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim() || '[]').filter((item) => belongsToRun(item, root, hosts));
}

export function sameProcess(actual, expected) {
  return actual && actual.ProcessId === expected.ProcessId && actual.CreatedAt === expected.CreatedAt
    && actual.ExecutablePath === expected.ExecutablePath && actual.CommandLine === expected.CommandLine;
}

export async function reclaim(root, report) {
  const survivors = await ownedProcesses(root, report.hosts);
  for (const candidate of survivors) {
    const current = (await ownedProcesses(root, report.hosts)).find((item) => item.ProcessId === candidate.ProcessId);
    if (!current) continue;
    assert.ok(sameProcess(current, candidate), '进程身份变化，拒绝按复用 PID 回收');
    const entry = { pid: candidate.ProcessId, command: candidate.CommandLine, created_at: candidate.CreatedAt, forced: true };
    report.reclamation.push(entry);
    await execute(join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(candidate.ProcessId), '/F'],
      { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
    entry.reclaimed = true;
  }
  const remaining = await ownedProcesses(root, report.hosts);
  report.remaining_processes = remaining;
  assert.deepEqual(remaining, [], '本轮归属进程必须全部结束');
  return survivors.length;
}
