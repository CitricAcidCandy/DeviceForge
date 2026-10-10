import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { uuid } from './control.mjs';

export function createReport(profile) {
  return { timestamp: new Date().toISOString(), profile, passed: false, checks: [], requests: [], jobs: [],
    scope: '真实普通操作协议2/3在线包、Rust HTTP/MCP共享Job、两侧实耗时越60秒与取消清理',
    limitations: [
      '不含真实npx分发、浏览器、真机、进程树或外部资源清理',
      'HTTP/MCP采样不证明成功资格或注册原子性，受控应用测试独立覆盖',
      '进程自身exit事件与实际PID不可见分别记录；不可见检查不提供操作系统退出码',
      '10000请求限流只用于验收行为，不作为性能证据',
    ] };
}

function scalar(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string' && (/^[\w.-]{1,80}$/.test(value) || value === '执行超时')) return value;
  return undefined;
}

// 不保存请求正文、环境、令牌或任意响应正文；首个业务失败不会被 shutdown 覆盖。
export function recordFailure(report, error) {
  report.passed = false;
  if (report.failure_stage !== undefined) return;
  report.failure_stage = report.stage ?? '初始化';
  report.failed_request ??= report.last_request ? { ...report.last_request } : undefined;
  report.failure_in_flight_requests = (report.in_flight_requests ?? []).map((request) => ({ ...request }));
  report.error = { name: error.name, code: error.code,
    summary: '本阶段断言或公开请求未通过；按首失败请求、场景及保留日志复核',
    ...(error.name === 'AssertionError' ? { operator: error.operator,
      expected: scalar(error.expected), actual: scalar(error.actual) } : {}) };
  report.error_locations = String(error.stack ?? '').split('\n')
    .filter((line) => /^\s+at /.test(line) && /ordinary-deadline|device-provider[\\/]client/.test(line)).slice(0, 5);
}

export async function stage(report, name, run) {
  assert.equal(report.failure_stage, undefined, '首次失败后不启动新的业务场景');
  report.stage = name;
  try { return await run(); }
  catch (error) { recordFailure(report, error); throw error; }
}

export function passed(report, name, details = {}) {
  assert.equal(report.failure_stage, undefined);
  report.checks.push({ name, ...details, passed: true });
}

async function logFiles(directory) {
  const folder = join(directory, 'logs');
  const entries = await readdir(folder, { withFileTypes: true });
  const names = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => entry.name).sort();
  assert.ok(names.length <= 256);
  return names.map((name) => join(folder, name));
}

function fields(record) {
  const result = new Map();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (child && typeof child === 'object') visit(child);
      else if (typeof child === 'string') {
        if (!result.has(key)) result.set(key, new Set());
        result.get(key).add(child);
      }
    }
  };
  visit(record.fields); visit(record.span); visit(record.spans);
  return result;
}

export async function verifyLogs(directory, host, report) {
  const expected = new Set(host.client.logIds);
  const found = new Set(), relations = new Map(), cleanup = new Set();
  const files = [];
  let records = 0, totalBytes = 0, normalStops = 0;
  for (const path of await logFiles(directory)) {
    const size = (await stat(path)).size;
    totalBytes += size;
    assert.ok(size <= 16 * 1024 * 1024 && totalBytes <= 64 * 1024 * 1024);
    const text = await readFile(path, 'utf8');
    files.push(await fileIdentity(path));
    let lineNumber = 0;
    for (const line of text.split('\n')) {
      lineNumber++;
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      records++;
      const known = fields(record);
      for (const values of known.values()) for (const id of values) if (expected.has(id)) found.add(id);
      const message = record.fields?.message;
      if (message === '宿主运行已结束') normalStops++;
      for (const entry of report.jobs) {
        if (!known.get('job_id')?.has(entry.job_id)
          || !known.get('plugin_request_id')?.has(entry.process.request_id)
          || !known.get('plugin_id')?.has(entry.plugin_id)) continue;
        if (message === '插件调用开始' && known.get('log_id')?.has(entry.submit_log_id)) {
          assert.ok(!relations.has(entry.job_id), '同 Job 不得出现第二次实际插件调用开始');
          relations.set(entry.job_id, { job_id: entry.job_id, plugin_request_id: entry.process.request_id,
            submit_log_id: entry.submit_log_id, plugin_id: entry.plugin_id, path, line: lineNumber });
        }
        if (message === '合作插件取消清理已确认' && record.fields?.cleanup === 'complete') cleanup.add(entry.job_id);
      }
    }
  }
  for (const id of expected) assert.match(id, uuid);
  assert.deepEqual([...found].sort(), [...expected].sort(), '响应日志ID须在正常退出后真实落盘');
  assert.equal(relations.size, 8, '8个Job须各有同记录的Job/request/提交logID真实关联');
  for (const entry of report.jobs) {
    entry.log_relation = relations.get(entry.job_id);
    if (entry.protocol_version === 3 && entry.expected_status !== 'succeeded') {
      assert.ok(cleanup.has(entry.job_id), '协议3取消或超时须有宿主匹配清理确认日志');
      entry.cleanup.host_cancel_cleanup_confirmed = true;
    }
  }
  assert.ok(normalStops >= 1);
  report.logging = { response_log_ids: [...expected].sort(), correlated_response_ids: found.size,
    job_plugin_request_log_relations: [...relations.values()], matched_cooperative_cancel_jobs: [...cleanup].sort(),
    persisted_records: records, normal_host_stop_records: normalStops, files };
}

export async function retainEvidence(directory, items, report) {
  report.temporary_retained = directory;
  report.temporary_removed = false;
  report.retention = '本次包、控制文件及日志在成功/失败后均保留；本脚本不删除证据目录';
  report.retained_files = [];
  const index = async (path) => {
    try { report.retained_files.push(await fileIdentity(path)); }
    catch (error) { report.retained_files.push({ path, error_name: error.name, error_code: error.code }); }
  };
  for (const item of items) {
    await index(item.archivePath);
    try {
      const markers = (await readdir(item.controlRoot, { withFileTypes: true }))
        .filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
      assert.ok(markers.length <= 64);
      for (const name of markers) await index(join(item.controlRoot, name));
    } catch (error) { report.retained_files.push({ path: item.controlRoot, error_name: error.name, error_code: error.code }); }
  }
  try { for (const path of await logFiles(join(directory, 'data'))) await index(path); }
  catch (error) { report.log_index_error = { name: error.name, code: error.code }; }
  const checkpoint = join(directory, 'checkpoint.json');
  report.checkpoint_path = checkpoint;
  await writeFile(checkpoint, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export async function writeReport(root, report) {
  report.completed_at = new Date().toISOString();
  const folder = join(root, 'artifacts');
  await mkdir(folder, { recursive: true });
  const path = join(folder, `ordinary-deadline-smoke-${report.profile}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return path;
}
