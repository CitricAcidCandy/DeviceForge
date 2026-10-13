import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
export { inputManifest } from '../harmony-device-smoke/evidence.mjs';

export function reportFor(profile, mode = 'service') {
  return { timestamp: new Date().toISOString(), run_id: randomUUID(), profile, mode, passed: false,
    checks: [], requests: [], jobs: [], metadata_jobs: [], rounds: [],
    scope: '冻结截图版本的真实宿主HTTP/MCP、三入口完整产物数组、固定五argv、JPEG元数据与HTTP原字节、真实父子OS退出及独立资源场景',
    limitations: ['假HDC与结构JPEG不证明真机、真实HDC、共享daemon、像素可解码或视觉正确',
      '服务入口不证明正式TGZ、CLI install、npx或registry发布；分发入口另验',
      '公开MCP artifact.inspect提供元数据任务，没有MCP原字节下载接口',
      '有限公开采样不证明内部注册原子性、未来所有设备竞争或生产性能',
      '插件request_id从日志关联，未截获宿主插件stdin原帧',
      'OS进程探针只观察已取得句柄的目标与直接父进程，不泛称派生树清理'] };
}

export function failure(report, error, stage = report.stage) {
  report.passed = false;
  const recorded = { stage, case_id: report.active_case_id, name: error.name, code: error.code, operator: error.operator };
  if (report.failure) (report.secondary_errors ??= []).push(recorded);
  else {
    report.failure = recorded; report.failed_request ??= report.last_request;
    report.error_locations = String(error.stack ?? '').split('\n')
      .filter((line) => /^\s+at /.test(line) && /harmony-screenshot|device-provider[\\/]client/.test(line)).slice(0, 8);
  }
}

export async function retain(directory, report) {
  report.temporary_retained = directory; report.retained_files = [];
  let count = 0, bytes = 0;
  const visit = async (folder, depth = 0) => {
    assert.ok(depth <= 12);
    for (const item of await readdir(folder, { withFileTypes: true })) {
      assert.ok(++count <= 8192); assert.ok(!item.isSymbolicLink());
      const path = join(folder, item.name);
      if (item.isDirectory()) await visit(path, depth + 1);
      else {
        const info = await lstat(path); assert.ok(info.isFile() && info.size <= 64 * 1024 * 1024);
        bytes += info.size; assert.ok(bytes <= 1024 * 1024 * 1024);
        report.retained_files.push(await fileIdentity(path));
      }
    }
  };
  await visit(directory);
  report.retained_index = { entries: count, bytes, boundary: '原件留在本轮独占目录，索引只记录路径、大小及SHA256' };
}

export async function writeReport(root, report) {
  report.completed_at = new Date().toISOString();
  const directory = join(root, 'artifacts', 'harmony-screenshot-' + report.mode + '-' + report.profile + '-' + report.run_id);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'report.json'); report.report_path = path;
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' }); return path;
}

function fields(record) {
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

export async function verifyLogs(directory, host, report, token) {
  const root = join(directory, 'data/logs'), foundIds = new Set(), calls = new Map(), ends = new Map(), resources = new Map(), files = [];
  let bytes = 0, records = 0, stops = 0;
  const jobs = report.jobs.filter((entry) => entry.plugin_invoked !== false);
  const inactive = report.jobs.filter((entry) => entry.plugin_invoked === false);
  for (const name of (await readdir(root)).filter((entry) => entry.endsWith('.jsonl'))) {
    const path = join(root, name), raw = await readFile(path); bytes += raw.length;
    assert.ok(raw.length <= 16 * 1024 * 1024 && bytes <= 64 * 1024 * 1024);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    if (token) assert.ok(!text.includes(token)); files.push(await fileIdentity(path));
    let lineNumber = 0;
    for (const line of text.split('\n')) {
      lineNumber++; if (!line.trim()) continue;
      const record = JSON.parse(line), known = fields(record), message = record.fields?.message; records++;
      for (const values of known.values()) for (const id of values) if (host.client.logIds.has(id)) foundIds.add(id);
      if (message === '宿主运行已结束') stops++;
      if (['插件调用开始', '插件调用结束'].includes(message)) {
        for (const job of inactive) assert.ok(!known.get('job_id')?.has(job.job_id), '排队任务不得启动插件调用');
      }
      for (const job of jobs) {
        if (!known.get('job_id')?.has(job.job_id) || !known.get('plugin_id')?.has('harmony-device')) continue;
        const ids = [...(known.get('plugin_request_id') ?? [])];
        if (message === '插件调用开始') {
          assert.equal(ids.length, 1); assert.ok(!calls.has(job.job_id));
          assert.ok(known.get('log_id')?.has(job.submit_log_id));
          calls.set(job.job_id, { plugin_request_id: ids[0], submit_log_id: job.submit_log_id, path, line: lineNumber });
        }
        if (message === '插件调用结束') {
          assert.equal(ids.length, 1); assert.ok(!ends.has(job.job_id));
          const expected = job.expected_plugin_code ?? (job.expected_status === 'succeeded' ? 'ok'
            : job.expected_status === 'cancelled' ? 'cancelled' : 'dependency_failed');
          assert.equal(record.fields.code, expected);
          ends.set(job.job_id, { plugin_request_id: ids[0], code: record.fields.code, path, line: lineNumber });
        }
        if (message === '合作插件资源未确认清理') {
          assert.equal(record.fields.cleanup, 'unresolved');
          resources.set(job.job_id, { cleanup: record.fields.cleanup, path, line: lineNumber });
        }
      }
    }
  }
  assert.deepEqual([...foundIds].sort(), [...host.client.logIds].sort());
  assert.equal(calls.size, jobs.length); assert.equal(ends.size, jobs.length);
  const unique = new Set();
  for (const job of jobs) {
    const start = calls.get(job.job_id), end = ends.get(job.job_id);
    assert.equal(start.plugin_request_id, end.plugin_request_id); assert.ok(!unique.has(start.plugin_request_id));
    unique.add(start.plugin_request_id); job.plugin_call = { ...start, end };
    if (job.cleanup_expected === 'failed') assert.ok(resources.has(job.job_id));
  }
  assert.ok(stops >= 1);
  report.logging = { response_ids: [...foundIds].sort(), plugin_jobs: jobs.length, records, normal_stop_records: stops,
    calls: [...calls.values()], cleanup_outcomes: [...resources.entries()].map(([job_id, evidence]) => ({ job_id, ...evidence })), files };
}
