import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createClient } from '../device-provider/client.mjs';

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

export function createReport(profile, command) {
  assert.ok(['debug', 'release'].includes(profile));
  return {
    timestamp: new Date().toISOString(),
    profile,
    command,
    platform: process.platform,
    architecture: process.arch,
    passed: false,
    checks: [],
    requests: [],
    scope:
      '真实Rust HTTP/MCP、第三方模拟发现、旧数组投影、历史与同数据目录重启；不含真机、浏览器或npx分发',
    limitations: [
      'HTTP/MCP端点采样不证明注册原子性；并发门禁、受控存储与时钟窗口另关联RAW-02集成测试',
      '清理标记与直接PID退出分别记录，不推断外部资源或进程树全部清理',
      '历史Succeeded不推断过去目录曾被接受；GET仅表示本次采样时的当前目录',
    ],
  };
}

export async function fileIdentity(path) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { path, bytes, sha256: hash.digest('hex') };
}

export function packageIdentity(item) {
  assert.ok(Buffer.isBuffer(item.archive), '包摘要必须来自本次实际上传字节');
  return {
    plugin_id: item.id,
    protocol_version: item.manifest.protocol_version,
    devices_api_version: item.manifest.devices.api_version,
    bytes: item.archive.length,
    sha256: createHash('sha256').update(item.archive).digest('hex'),
  };
}

// 只保存请求定位字段；业务输入、令牌与任意插件输出不进入诊断记录。
function requestSummary(report, request, method, args, outcome) {
  if (!request) return;
  report.requests.push({
    ...request,
    client_method: method,
    outcome,
    ...(method === 'tool' ? { tool: args[0] } : {}),
  });
}

export function clientFor(base, report) {
  const logIds = new Set();
  const wrapped = { base, logIds };
  for (const name of [
    'call',
    'json',
    'post',
    'tool',
    'tools',
    'job',
    'finished',
    'action',
    'refresh',
    'manage',
  ]) {
    wrapped[name] = async (...args) => {
      // 每次公开方法拥有独立诊断状态，避免在途refresh与取消请求互相覆盖路径。
      const local = {},
        client = createClient(base, local);
      const pending = {
        client_method: name,
        started_at: new Date().toISOString(),
        ...(['call', 'json', 'post'].includes(name) ? { path: args[0] } : {}),
        ...(name === 'tool' ? { path: '/mcp', tool: args[0] } : {}),
        ...(name === 'refresh' ? { path: `/api/v2/device-providers/${args[0].id}/refresh` } : {}),
        ...(['job', 'finished'].includes(name) ? { path: `/api/v2/jobs/${args[0]}` } : {}),
      };
      report.in_flight_requests ??= [];
      report.in_flight_requests.push(pending);
      try {
        const result = await client[name](...args);
        requestSummary(report, local.last_request, name, args, 'returned');
        return result;
      } catch (error) {
        report.failed_request ??= local.failed_request ?? local.last_request;
        requestSummary(report, local.failed_request ?? local.last_request, name, args, 'threw');
        throw error;
      } finally {
        report.in_flight_requests = report.in_flight_requests.filter((item) => item !== pending);
        for (const id of client.logIds) logIds.add(id);
        if (local.last_request) report.last_request = local.last_request;
      }
    };
  }
  return wrapped;
}

export function recordFailure(report, error) {
  if (report.failure_stage !== undefined) return;
  report.failure_stage = report.stage;
  report.failed_request ??= report.last_request ? { ...report.last_request } : undefined;
  report.failure_in_flight_requests = (report.in_flight_requests ?? []).map((request) => ({
    ...request,
  }));
  report.error = String(error.message).slice(0, 1200);
  report.error_location = String(error.stack ?? '')
    .split('\n')
    .filter((line) => line.includes('unified-discovery-smoke'))
    .slice(0, 5);
  report.passed = false;
}

export async function stage(report, name, run) {
  assert.equal(report.failure_stage, undefined, '首次失败后不再执行后续业务场景');
  report.stage = name;
  try {
    return await run();
  } catch (error) {
    recordFailure(report, error);
    throw error;
  }
}

export function passed(report, name, details = {}) {
  assert.equal(report.failure_stage, undefined);
  report.checks.push({ name, ...details, passed: true });
}

async function logFiles(directory) {
  const folder = join(directory, 'logs');
  const names = (await readdir(folder, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => entry.name)
    .sort();
  assert.ok(names.length <= 256, '本次日志文件数量必须有界');
  return names.map((name) => join(folder, name));
}

export async function verifyPersistedLogs(directory, clients, report) {
  const expected = new Set(clients.flatMap((client) => [...client.logIds]));
  for (const id of expected) assert.match(id, uuid);
  const found = new Set();
  const expectedCalls = new Set((report.fixture_processes ?? []).map((entry) => entry.request_id));
  const foundCalls = new Set(),
    jobCalls = new Map();
  let records = 0,
    totalBytes = 0,
    hostStopped = 0;
  const files = [];
  for (const path of await logFiles(directory)) {
    const size = (await stat(path)).size;
    totalBytes += size;
    assert.ok(
      size <= 16 * 1024 * 1024 && totalBytes <= 64 * 1024 * 1024,
      '本次日志核对读取量必须有界',
    );
    const bytes = await readFile(path);
    files.push({
      path,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    const lines = bytes.toString('utf8').split('\n');
    for (const line of lines.filter((value) => value.trim())) {
      const record = JSON.parse(line);
      records++;
      if (record.fields?.message === '宿主运行已结束') hostStopped++;
      // 只提取UUID关联值；报告不复制任意插件输出或原始日志正文。
      for (const id of line.match(/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/g) ??
        []) {
        if (expected.has(id)) found.add(id);
        if (expectedCalls.has(id)) {
          foundCalls.add(id);
          // 同一有限日志记录内同时出现本次Job和插件request_id才记关联，不以时间邻近替代。
          for (const observation of [
            ...(report.discoveries ?? []),
            ...(report.cancellations ?? []),
          ]) {
            const requestId = observation.process?.request_id ?? observation.request_id;
            if (requestId === id && line.includes(observation.job_id))
              jobCalls.set(observation.job_id, id);
          }
        }
      }
    }
  }
  assert.deepEqual(
    [...found].sort(),
    [...expected].sort(),
    '每个真实HTTP/MCP响应日志ID均须在退出后落盘',
  );
  assert.deepEqual(
    [...foundCalls].sort(),
    [...expectedCalls].sort(),
    '每个实际夹具调用request_id均须有宿主日志',
  );
  const knownRelations = [...(report.discoveries ?? []), ...(report.cancellations ?? [])];
  for (const observation of knownRelations)
    assert.ok(jobCalls.has(observation.job_id), '同次Job和真实夹具request_id必须有日志关联');
  assert.ok(hostStopped >= clients.length, '首次宿主和重启宿主均应刷新正常退出日志');
  report.logging = {
    response_log_ids: [...expected].sort(),
    correlated_count: found.size,
    plugin_request_ids: [...foundCalls].sort(),
    job_plugin_calls: [...jobCalls].map(([job_id, plugin_request_id]) => ({
      job_id,
      plugin_request_id,
    })),
    persisted_records: records,
    normal_host_stop_records: hostStopped,
    files,
  };
}

export async function retainFailureEvidence(directory, report) {
  report.temporary_retained = directory;
  report.temporary_removed = false;
  report.failure_evidence = {
    directory,
    indexed_at: new Date().toISOString(),
    note: '原失败请求与阶段不被finally的shutdown覆盖；本次包、配置、标记及宿主日志保留用于复现',
  };
  report.failure_log_files = [];
  try {
    for (const path of await logFiles(directory)) {
      try {
        report.failure_log_files.push(await fileIdentity(path));
      } catch (error) {
        report.failure_log_files.push({ path, error_name: error.name, error_code: error.code });
      }
    }
  } catch (error) {
    report.failure_log_index_error = { name: error.name, code: error.code };
  }
}

export async function writeReport(root, report) {
  report.completed_at = new Date().toISOString();
  const directory = join(root, 'artifacts');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `unified-discovery-smoke-${report.profile}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return path;
}
