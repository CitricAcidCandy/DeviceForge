import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
export { retain } from '../android-packages-smoke/evidence.mjs';

export function reportFor(profile) {
  return { timestamp: new Date().toISOString(), run_id: randomUUID(), profile, passed: false, checks: [], requests: [], jobs: [],
    scope: '当前新宿主真实HTTP/MCP、harmony-device四贡献/三能力、显式格式2旧绑定、HAP安装私有副本、假HDC固定argv与共享锁、卸载历史重载及正常退出',
    limitations: ['假HDC不证明真实HDC、共享daemon、真机或另一LAN主机',
      '便携目录不是正式原TGZ、CLI install、npx或registry发布证据',
      '只观察工具与父插件直接PID，未取得OS退出码，不证明派生树与设备状态回滚',
      '端点采样不证明内部注册/提交原子性；不覆盖扩展业务/性能的设备锁',
      '插件request_id从同Job宿主日志读取，未截获stdin原帧',
      '有界看门狗和10000限流配置不提供性能结论'] };
}
export function failure(report, error, stage = report.stage) {
  report.passed = false;
  if (report.failure_stage) {
    report.secondary_errors ??= []; report.secondary_errors.push({ stage, name: error.name, code: error.code }); return;
  }
  report.failure_stage = stage; report.failed_request ??= report.last_request;
  report.failure_case_id = report.active_case_id;
  const label = String(error.message ?? '').split('\n')[0];
  report.error = { name: error.name, code: error.code, operator: error.operator,
    summary: '按首失败阶段、实际请求及保留原件复核，不输出任意响应或凭据',
    ...(label.startsWith('HD-') && label.length <= 180 ? { assertion_label: label } : {}) };
  report.error_locations = String(error.stack ?? '').split('\n')
    .filter((line) => /^\s+at /.test(line) && /harmony-device-smoke|device-provider[\\/]client/.test(line)).slice(0, 8);
}

export async function inputManifest(entry, additional) {
  const paths = new Set(additional.map((path) => resolve(path))), visited = new Set();
  const visit = async (path) => {
    path = resolve(path); if (visited.has(path)) return; visited.add(path); paths.add(path);
    const source = await readFile(path, 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
      if (match[1].startsWith('.')) await visit(resolve(dirname(path), match[1]));
    }
  };
  await visit(entry);
  return Promise.all([...paths].sort().map(fileIdentity));
}
function values(record) {
  const found = new Map();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (item && typeof item === 'object') visit(item);
      else if (typeof item === 'string') {
        if (!found.has(key)) found.set(key, new Set()); found.get(key).add(item);
      }
    }
  };
  visit(record.fields); visit(record.span); visit(record.spans); return found;
}
export async function verifyLogs(directory, host, report) {
  const root = join(directory, 'data/logs'), responseIds = new Set(), calls = new Map(), ends = new Map(), files = [];
  let records = 0, bytes = 0, stops = 0;
  const entries = await readdir(root, { withFileTypes: true }); assert.ok(entries.length <= 256);
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith('.jsonl'))) {
    const path = join(root, entry.name), size = (await stat(path)).size; bytes += size;
    assert.ok(size <= 16 * 1024 * 1024 && bytes <= 64 * 1024 * 1024); files.push(await fileIdentity(path));
    let lineNumber = 0;
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      lineNumber++; if (!line.trim()) continue;
      const record = JSON.parse(line), known = values(record), message = record.fields?.message; records++;
      for (const found of known.values()) for (const id of found) if (host.client.logIds.has(id)) responseIds.add(id);
      if (message === '宿主运行已结束') stops++;
      for (const job of report.jobs) {
        if (!known.get('job_id')?.has(job.job_id) || !known.get('plugin_id')?.has('harmony-device')) continue;
        const ids = [...(known.get('plugin_request_id') ?? [])];
        if (message === '插件调用开始') {
          assert.equal(ids.length, 1); assert.match(ids[0], /^[a-f\d-]{36}$/);
          assert.equal(known.get('log_id')?.has(job.submit_log_id), true);
          assert.ok(!calls.has(job.job_id));
          calls.set(job.job_id, { job_id: job.job_id, plugin_request_id: ids[0], submit_log_id: job.submit_log_id, path, line: lineNumber });
        }
        if (message === '插件调用结束') {
          assert.equal(ids.length, 1); assert.ok(!ends.has(job.job_id));
          const expected = job.expected_status === 'succeeded' ? 'ok' : job.expected_status === 'cancelled' ? 'cancelled' : 'dependency_failed';
          assert.equal(record.fields.code, expected);
          ends.set(job.job_id, { plugin_request_id: ids[0], code: record.fields.code, path, line: lineNumber });
        }
      }
    }
  }
  assert.deepEqual([...responseIds].sort(), [...host.client.logIds].sort(), '每个实际响应日志ID须在正常退出后落盘');
  assert.equal(calls.size, report.jobs.length); assert.equal(ends.size, report.jobs.length);
  const unique = new Set();
  for (const job of report.jobs) {
    const start = calls.get(job.job_id), end = ends.get(job.job_id);
    assert.equal(start.plugin_request_id, end.plugin_request_id); assert.ok(!unique.has(start.plugin_request_id));
    unique.add(start.plugin_request_id); job.plugin_call = { ...start, end };
  }
  assert.ok(stops >= 1);
  report.logging = { response_ids: [...responseIds].sort(), jobs: report.jobs.length,
    per_job_call_relations: [...calls.values()], persisted_records: records, normal_host_stop_records: stops, files,
    boundary: '逐项Job/log_id/request_id配对；工具argv与父PID另证，未截获协议帧' };
}
export async function writeReport(root, report) {
  report.completed_at = new Date().toISOString(); await mkdir(join(root, 'artifacts'), { recursive: true });
  const directory = join(root, 'artifacts', 'harmony-device-smoke-' + report.profile + '-' + report.run_id);
  await mkdir(directory);
  const path = join(directory, 'report.json'); report.report_path = path;
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' }); return path;
}
