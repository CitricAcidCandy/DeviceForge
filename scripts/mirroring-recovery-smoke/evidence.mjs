import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { failureSummary as safeFailureSummary } from '../mirroring-cleanup-fallback-smoke/evidence.mjs';
export { fileIdentity };
export { sessionSummary } from '../mirroring-cleanup-fallback-smoke/evidence.mjs';

export function failureSummary(error, stage) {
  const result = safeFailureSummary(error, stage), locations = [];
  const allowedRoot = fileURLToPath(new URL('../', import.meta.url)).toLowerCase();
  for (const frame of String(error.stack ?? '').split('\n').slice(1)) {
    const match = frame.match(/(file:\/\/\/.+|[A-Za-z]:[\\/].+):(\d+):(\d+)\)?$/);
    if (!match) continue;
    let path;
    try { path = match[1].startsWith('file:') ? fileURLToPath(match[1]) : match[1]; }
    catch { continue; }
    if (!path.toLowerCase().startsWith(allowedRoot) || !path.endsWith('.mjs')) continue;
    locations.push({ path, line: Number(match[2]), column: Number(match[3]) });
    if (locations.length === 6) break;
  }
  if (locations.length) { result.source = locations[0]; result.call_sites = locations; }
  if (error.name === 'ReferenceError') {
    const identifier = String(error.message).match(/^([A-Za-z_$][\w$]*) is not defined$/)?.[1];
    if (identifier) result.missing_identifier = identifier;
  }
  if (error instanceof AggregateError) result.errors = [...error.errors].map((item) => failureSummary(item, stage));
  return result;
}

// 原始日志只保留于本轮独占制品目录，摘要不复制任意插件消息正文。
export async function verifyLogs(host, report) {
  const directory = join(host.directory, 'logs');
  const names = (await readdir(directory)).filter((name) => name.endsWith('.jsonl'));
  assert.ok(names.length > 0 && names.length <= 32);
  const wanted = host.client.logIds, found = new Set(), files = [], rows = [];
  let bytes = 0, stopped = false;
  for (const name of names) {
    const path = join(directory, name), size = (await stat(path)).size;
    bytes += size;
    assert.ok(size <= 16 * 1024 * 1024 && bytes <= 64 * 1024 * 1024);
    files.push(await fileIdentity(path));
    for (const [index, text] of (await readFile(path, 'utf8')).split('\n').entries()) {
      if (!text.trim()) continue;
      const record = JSON.parse(text), ids = new Set();
      const visit = (value) => {
        if (!value || typeof value !== 'object') return;
        for (const [key, item] of Object.entries(value)) {
          if (key === 'log_id' && typeof item === 'string') ids.add(item);
          else if (item && typeof item === 'object') visit(item);
        }
      };
      visit(record);
      const matched = [...ids].filter((id) => wanted.has(id));
      for (const id of matched) found.add(id);
      if (matched.length) rows.push({ path, line: index + 1, log_ids: matched });
      if (record.fields?.message === '宿主运行已结束') stopped = true;
    }
  }
  report.logging = { files, response_log_ids: [...wanted].sort(),
    observed_log_ids: [...found].sort(), missing_log_ids: [...wanted].filter((id) => !found.has(id)),
    locations: rows, normal_stop_observed: stopped };
  assert.deepEqual([...found].sort(), [...wanted].sort(), '每个响应日志 ID 须能关联本轮宿主原件');
  assert.equal(stopped, true, '独占宿主必须有正常停止日志');
}

export function processSummary(report) {
  return {
    host: (report.hosts ?? []).map(({ pid, exit, graceful_shutdown, forced_direct_child_termination }) => ({
      pid, command: '本轮冻结 apk-server.exe', exit, graceful_shutdown, forced_direct_child_termination,
    })),
    tools: (report.tools ?? []).map(({ pid, category, probe_pid, process: value }) => ({
      pid, command: '本轮 fake-adb.exe/' + category,
      exited: value?.exit.target.state === 'exited',
      plugin_pid: value?.exit.parent.pid, plugin_exited: value?.exit.parent.state === 'exited',
      probe_pid, probe_exit: value?.probe_exit,
    })),
    probe_failure_cleanup: report.probe_failure_cleanup ?? [],
    fault_workers: (report.fault_workers ?? []).map(({ pid, operation, probe_pid, process: value }) => ({
      pid, command: '本轮 Node 合成提供者/' + operation, probe_pid,
      exited: value?.exit.target.state === 'exited', probe_exit: value?.probe_exit,
    })),
    lease_holder: report.lease_debt ? {
      pid: report.lease_debt.pid, command: '本轮 lease-holder.exe',
      launcher_pid: report.lease_debt.launcher_pid, launcher_exit: report.lease_debt.exit,
      probe_pid: report.lease_debt.probe_pid, probe_exit: report.lease_debt.process?.probe_exit,
      exited: report.lease_debt.process?.exit.target.state === 'exited',
      original_parent_exited: report.lease_debt.process?.exit.parent.state === 'exited',
    } : null,
    user_processes_touched: false,
  };
}
