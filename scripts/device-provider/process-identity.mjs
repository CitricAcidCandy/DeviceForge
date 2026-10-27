import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const text = (value) => typeof value === 'string' && value.trim().length > 0;

export function assessProcessIdentity(start, observation, scope) {
  const expected = start.process_identity;
  const result = (state, reason) => ({
    state,
    reason,
    process_exited: state === 'exited' || state === 'pid_reused',
    expected: expected ?? null,
    // PID 复用后命令行可能属于用户程序；只保存摘要和比对结论，避免泄露参数。
    observed: observation ? {
      pid: observation.pid,
      state: observation.state,
      observed_at: observation.observed_at,
      created_at: observation.created_at,
      error_code: observation.error_code,
      command_line_matches: text(observation.command_line) && observation.command_line === expected?.command_line,
      command_line_sha256: text(observation.command_line)
        ? createHash('sha256').update(observation.command_line).digest('hex') : null,
    } : null,
  });
  if (
    !expected || !scope || !Number.isSafeInteger(start.pid) || start.pid <= 0 ||
    expected.pid !== start.pid ||
    !['run_id', 'profile', 'profile_directory'].every(
      (key) => text(scope[key]) && expected[key] === scope[key],
    ) || !text(expected.command_line) || !text(expected.created_at) || !text(expected.entry_path)
  ) return result('unconfirmed', '缺少原始进程身份或不属于本次运行');

  const paths = /^[a-z]:[\\/]/i.test(scope.profile_directory) ? path.win32 : path.posix;
  const commandPath = (value) => paths === path.win32 ? value.replaceAll('\\', '/').toLowerCase() : value;
  const within = paths.relative(scope.profile_directory, expected.entry_path);
  if (
    !paths.isAbsolute(scope.profile_directory) || !paths.isAbsolute(expected.entry_path) ||
    !within || within === '..' || within.startsWith(`..${paths.sep}`) || paths.isAbsolute(within) ||
    !commandPath(expected.command_line).includes(commandPath(expected.entry_path))
  ) return result('unconfirmed', '入口或命令行不属于本次临时目录');

  if (!observation || observation.pid !== start.pid) {
    return result('unconfirmed', '观察结果缺失或 PID 不匹配');
  }
  if (observation.state === 'absent') return result('exited', '操作系统确认该 PID 不存在');
  if (
    observation.state !== 'present' || !text(observation.created_at) ||
    !text(observation.command_line)
  ) return result('unconfirmed', '进程查询失败或当前身份不完整');

  // 创建时间用原始字符串比较，保留 Windows 100ns 精度；同命令也可能是另一次调用。
  if (observation.created_at !== expected.created_at) {
    return result('pid_reused', '同 PID 已由不同创建时间的进程占用');
  }
  if (observation.command_line !== expected.command_line) {
    return result('unconfirmed', '创建时间相同但命令行发生变化，不能推定退出');
  }
  return result('running', '本次同一进程实例仍存活');
}

// 仅查询给定 PID，既不扫描用户进程，也不发送终止信号；失败必须保持未确认。
export function snapshotProcesses(pids, {
  platform = process.platform,
  execute = execFileSync,
  read = readFileSync,
} = {}) {
  const ids = [...new Set(pids)];
  if (ids.length > 256 || ids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) {
    throw new Error('进程身份查询只接受最多 256 个正整数 PID');
  }
  if (!ids.length) return new Map();
  const observed_at = new Date().toISOString();
  const unknown = (pid, error) => ({
    pid, state: 'unknown', observed_at,
    error_code: error.code ?? error.name ?? 'identity_query_failed',
  });
  if (platform === 'win32') {
    const filter = ids.map((pid) => `ProcessId=${pid}`).join(' OR ');
    const command = [
      "$ErrorActionPreference='Stop'",
      '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)',
      `$rows=@(Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object {`,
      '[pscustomobject]@{pid=[int]$_.ProcessId;command_line=$_.CommandLine;',
      'created_at=if($null -ne $_.CreationDate){$_.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)}else{$null}}})',
      'ConvertTo-Json -InputObject $rows -Compress',
    ].join('\n');
    try {
      const output = execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 512 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const rows = JSON.parse(output.replace(/^\uFEFF/, ''));
      if (
        !Array.isArray(rows) || rows.some((row) => !row || !ids.includes(row.pid)) ||
        new Set(rows.map((row) => row.pid)).size !== rows.length
      ) throw new Error('进程身份查询返回格式异常');
      return new Map(ids.map((pid) => {
        const row = rows.find((value) => value.pid === pid);
        return [pid, row ? { ...row, state: 'present', observed_at } : { pid, state: 'absent', observed_at }];
      }));
    } catch (error) {
      return new Map(ids.map((pid) => [pid, unknown(pid, error)]));
    }
  }
  if (platform === 'linux') {
    return new Map(ids.map((pid) => {
      let stat;
      try {
        stat = read(`/proc/${pid}/stat`, 'utf8');
      } catch (error) {
        return [pid, error.code === 'ENOENT' ? { pid, state: 'absent', observed_at } : unknown(pid, error)];
      }
      try {
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        const boot = read('/proc/sys/kernel/random/boot_id', 'utf8').trim();
        const entry = read(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
        if (!/^\d+$/.test(fields[19]) || !boot || !entry.length) throw new Error('进程身份不完整');
        return [pid, {
          pid, state: 'present', observed_at,
          command_line: entry.join('\0'), created_at: `${boot}:${fields[19]}`,
        }];
      } catch (error) {
        return [pid, unknown(pid, error)];
      }
    }));
  }
  return new Map(ids.map((pid) => [pid, unknown(pid, { code: 'unsupported_platform' })]));
}
