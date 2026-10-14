import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';

export function reportFor(profile) {
  return {
    timestamp: new Date().toISOString(),
    profile,
    passed: false,
    checks: [],
    requests: [],
    jobs: [],
    scope:
      '4Job真实Rust HTTP/MCP、当前原生安卓包插件便携部署、独立假manifest工具、同Job旧alias投影及extract实际产物下载',
    limitations: [
      '非在线TGZ安装、非CLI install/npx、非真机或真实Android工具',
      '只执行manifest和extract_apk；其它五操作目录注册不算业务通过',
      'HTTP/MCP采样不证明注册原子性或内部提交竞争',
      '两个manifest核实际工具及父插件PID；两个无工具extract不直接采插件OS PID',
      '插件request_id来自同Job宿主日志；本脚本未截获插件stdin原帧',
      '直接PID不可见不提供OS退出码、派生树或外部资源完全清理证明',
      '墙钟看门狗和10000限流配置不提供性能结论',
    ],
  };
}

export function failure(report, error, stage = report.stage) {
  report.passed = false;
  if (report.failure_stage !== undefined) {
    report.secondary_errors ??= [];
    report.secondary_errors.push({ stage, name: error.name, code: error.code });
    return;
  }
  report.failure_stage = stage;
  report.failed_request ??= report.last_request ? { ...report.last_request } : undefined;
  report.error = {
    name: error.name,
    code: error.code,
    operator: error.operator,
    summary: '当前断言或公开请求失败，按首失败阶段、请求及保留原件复核',
  };
  report.error_locations = String(error.stack ?? '')
    .split('\n')
    .filter(
      (line) =>
        /^\s+at /.test(line) && /android-packages-smoke|device-provider[\\/]client/.test(line),
    )
    .slice(0, 6);
}

async function logPaths(directory) {
  const root = join(directory, 'data/logs');
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => entry.name)
    .sort();
  assert.ok(names.length <= 256);
  return names.map((name) => join(root, name));
}

function values(record) {
  const found = new Map();
  const visit = (object) => {
    if (!object || typeof object !== 'object') return;
    for (const [key, value] of Object.entries(object)) {
      if (value && typeof value === 'object') visit(value);
      else if (typeof value === 'string') {
        if (!found.has(key)) found.set(key, new Set());
        found.get(key).add(value);
      }
    }
  };
  visit(record.fields);
  visit(record.span);
  visit(record.spans);
  return found;
}

export async function verifyLogs(directory, host, report) {
  const foundIds = new Set(),
    calls = new Map(),
    ends = new Map(),
    files = [];
  let records = 0,
    total = 0,
    stops = 0;
  for (const path of await logPaths(directory)) {
    const size = (await stat(path)).size;
    total += size;
    assert.ok(size <= 16 * 1024 * 1024 && total <= 64 * 1024 * 1024);
    files.push(await fileIdentity(path));
    let lineNumber = 0;
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      lineNumber++;
      if (!line.trim()) continue;
      const record = JSON.parse(line),
        known = values(record);
      records++;
      for (const set of known.values())
        for (const id of set) if (host.client.logIds.has(id)) foundIds.add(id);
      const message = record.fields?.message;
      if (message === '宿主运行已结束') stops++;
      for (const entry of report.jobs) {
        if (
          !known.get('job_id')?.has(entry.job_id) ||
          !known.get('plugin_id')?.has('android-packages')
        )
          continue;
        const requestIds = [...(known.get('plugin_request_id') ?? [])];
        if (message === '插件调用开始') {
          assert.equal(requestIds.length, 1);
          assert.match(requestIds[0], /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/);
          assert.equal(known.get('log_id')?.has(entry.submit_log_id), true);
          assert.ok(!calls.has(entry.job_id), '每个Job只允许一个真实插件调用开始');
          calls.set(entry.job_id, {
            job_id: entry.job_id,
            plugin_request_id: requestIds[0],
            submit_log_id: entry.submit_log_id,
            path,
            line: lineNumber,
          });
        }
        if (message === '插件调用结束') {
          assert.equal(record.fields.code, 'ok');
          assert.equal(requestIds.length, 1);
          assert.ok(!ends.has(entry.job_id));
          ends.set(entry.job_id, { request_id: requestIds[0], path, line: lineNumber });
        }
      }
    }
  }
  assert.deepEqual(
    [...foundIds].sort(),
    [...host.client.logIds].sort(),
    '所有响应ID含两次下载须在host正常退出后落盘',
  );
  assert.equal(calls.size, 4);
  assert.equal(ends.size, 4);
  const unique = new Set();
  for (const entry of report.jobs) {
    const relation = calls.get(entry.job_id);
    assert.equal(ends.get(entry.job_id).request_id, relation.plugin_request_id);
    assert.ok(!unique.has(relation.plugin_request_id));
    unique.add(relation.plugin_request_id);
    entry.plugin_call = {
      ...relation,
      end: ends.get(entry.job_id),
      pid_link: entry.tool
        ? '同Job唯一input摘要对应真实工具私有目录与父PID；request_id本身从日志读取'
        : '没有直接插件OS PID',
    };
  }
  assert.ok(stops >= 1);
  report.logging = {
    response_log_ids: [...foundIds].sort(),
    response_ids_count: foundIds.size,
    per_job_call_relations: [...calls.values()],
    persisted_records: records,
    normal_host_stop_records: stops,
    files,
    boundary: '仅这四Job逐项关联，不把其它响应ID数量当逐Job配对数量',
  };
}

export async function retain(directory, report) {
  report.temporary_retained = directory;
  report.temporary_removed = false;
  report.retained_files = [];
  report.retained_file_errors = [];
  let entries = 0;
  const visit = async (folder, depth = 0) => {
    assert.ok(depth <= 8);
    let children;
    try {
      children = await readdir(folder, { withFileTypes: true });
    } catch (error) {
      report.retained_file_errors.push({ path: folder, code: error.code, name: error.name });
      return;
    }
    for (const item of children) {
      assert.ok(++entries <= 512, '本次保留索引条目超出有界范围');
      assert.ok(!item.isSymbolicLink());
      const path = join(folder, item.name);
      if (item.isDirectory()) await visit(path, depth + 1);
      else if (item.isFile()) {
        try {
          report.retained_files.push(await fileIdentity(path));
        } catch (error) {
          report.retained_file_errors.push({ path, code: error.code, name: error.name });
        }
      }
    }
  };
  let indexFailure;
  try {
    await visit(directory);
  } catch (error) {
    indexFailure = error;
  }
  if (indexFailure || report.retained_file_errors.length) {
    failure(report, indexFailure ?? new Error('保留证据文件无法读取'), '保留证据索引');
  }
  report.checkpoint_path = join(directory, 'checkpoint.json');
  await writeFile(report.checkpoint_path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (indexFailure) throw indexFailure;
  assert.equal(
    report.retained_file_errors.length,
    0,
    '无法读取的原件须保留路径，不得计为完整证据索引',
  );
}

export async function writeReport(root, report) {
  report.completed_at = new Date().toISOString();
  const directory = join(root, 'artifacts');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `android-packages-smoke-${report.profile}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return path;
}
