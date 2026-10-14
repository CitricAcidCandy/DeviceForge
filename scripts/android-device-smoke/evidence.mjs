import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { retain as retainDefault } from '../android-packages-smoke/evidence.mjs';

const uuidLogId = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;

export async function retain(directory, report) {
  if (!report.performance_mode) return retainDefault(directory, report);
  const entryLimit = 32768;
  report.temporary_retained = directory;
  report.temporary_removed = false;
  report.retained_files = [];
  report.retained_file_errors = [];
  report.retention_budget = {
    entries: entryLimit,
    depth: 8,
    reason: '性能最多4096工具目录及其ready/completed/release原件，另保留宿主和APKS固定原件',
  };
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
      assert.ok(++entries <= entryLimit, 'AD-PERF-BOUNDED-RETENTION-ENTRIES');
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
  report.retention_budget.actual_entries = entries;
  if (indexFailure || report.retained_file_errors.length) {
    failure(report, indexFailure ?? new Error('保留证据文件无法读取'), '保留证据索引');
  }
  report.checkpoint_path = join(directory, 'checkpoint.json');
  await writeFile(report.checkpoint_path, JSON.stringify(report, null, 2) + '\n', 'utf8');
  if (indexFailure) throw indexFailure;
  assert.equal(
    report.retained_file_errors.length,
    0,
    '无法读取的原件须保留路径，不得计为完整证据索引',
  );
}

export function reportFor(profile) {
  return {
    timestamp: new Date().toISOString(),
    run_id: randomUUID(),
    profile,
    passed: false,
    checks: [],
    requests: [],
    jobs: [],
    scope:
      '当前新宿主真实HTTP/MCP、android-device十一贡献/十能力/八device能力、显式格式2旧绑定、APK/APKS私有副本/截图实体、假ADB/Java固定argv与共享锁、卸载历史重载及正常退出',
    limitations: [
      '假ADB/Java不证明真实ADB/JVM/bundletool、设备匹配、共享server、真机或另一LAN主机',
      '便携目录不是正式原TGZ、CLI install、npx或registry发布证据',
      '只观察工具与父插件直接PID，未取得OS退出码，不证明派生树与设备状态回滚',
      '端点采样不证明内部注册/提交原子性；设备锁不提供性能或跨提供者物理设备协调证明',
      '假Java的cwd/TEMP/TMP/TMPDIR观测不证明真实JVM内部临时文件或派生ADB树',
      '插件request_id从同Job宿主日志读取，未截获stdin原帧',
      '有界看门狗和10000限流配置不提供性能结论',
    ],
  };
}
export function failure(report, error, stage = report.stage) {
  report.passed = false;
  if (report.failure_stage) {
    report.secondary_errors ??= [];
    report.secondary_errors.push({ stage, name: error.name, code: error.code });
    return;
  }
  report.failure_stage = stage;
  report.failed_request ??= report.last_request;
  report.failure_case_id = report.active_case_id;
  const label = String(error.message ?? '').split('\n')[0];
  report.error = {
    name: error.name,
    code: error.code,
    operator: error.operator,
    summary: '按首失败阶段、实际请求及保留原件复核，不输出任意响应或凭据',
    ...(label.startsWith('AD-') && label.length <= 180 ? { assertion_label: label } : {}),
  };
  report.error_locations = String(error.stack ?? '')
    .split('\n')
    .filter(
      (line) =>
        /^\s+at /.test(line) && /android-device-smoke|device-provider[\\/]client/.test(line),
    )
    .slice(0, 8);
}

export async function inputManifest(entry, additional) {
  const paths = new Set(additional.map((path) => resolve(path))),
    visited = new Set();
  const visit = async (path) => {
    path = resolve(path);
    if (visited.has(path)) return;
    visited.add(path);
    paths.add(path);
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
        if (!found.has(key)) found.set(key, new Set());
        found.get(key).add(item);
      }
    }
  };
  visit(record.fields);
  visit(record.span);
  visit(record.spans);
  return found;
}
export async function verifyLogs(directory, host, report) {
  const root = join(directory, 'data/logs'),
    responseIds = new Set(),
    calls = new Map(),
    ends = new Map(),
    files = [];
  const pluginJobs = report.jobs.filter((job) => job.plugin_call_required !== false);
  const backgroundStarts = new Map(),
    backgroundEnds = new Map();
  const sessions = new Map(
    (report.performance?.sessions ?? []).map((session) => [session.id, session]),
  );
  let records = 0,
    bytes = 0,
    stops = 0;
  const entries = await readdir(root, { withFileTypes: true });
  assert.ok(entries.length <= 256);
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith('.jsonl'))) {
    const path = join(root, entry.name),
      size = (await stat(path)).size;
    bytes += size;
    assert.ok(size <= 16 * 1024 * 1024 && bytes <= 64 * 1024 * 1024);
    files.push(await fileIdentity(path));
    let lineNumber = 0;
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      lineNumber++;
      if (!line.trim()) continue;
      const record = JSON.parse(line),
        known = values(record),
        message = record.fields?.message;
      records++;
      for (const found of known.values())
        for (const id of found) if (host.client.logIds.has(id)) responseIds.add(id);
      if (message === '宿主运行已结束') stops++;
      if (
        report.performance_mode &&
        known.get('plugin_id')?.has('android-device') &&
        ['插件调用开始', '插件调用结束'].includes(message)
      ) {
        const related = [...(known.get('session_id') ?? [])].filter((id) => sessions.has(id));
        if (related.length) {
          const ids = [...(known.get('plugin_request_id') ?? [])];
          assert.equal(related.length, 1);
          assert.equal(known.get('session_id').size, 1);
          assert.equal(ids.length, 1);
          assert.match(ids[0], uuidLogId);
          const session = sessions.get(related[0]);
          assert.deepEqual(
            [...(known.get('source_plugin_id') ?? [])],
            [session.source.plugin_id],
            'AD-PERF-LOG-SOURCE-PLUGIN',
          );
          assert.deepEqual(
            [...(known.get('source_generation') ?? [])],
            [session.source.generation],
            'AD-PERF-LOG-SOURCE-GENERATION',
          );
          const relation = {
            plugin_request_id: ids[0],
            session_id: related[0],
            source_plugin_id: session.source.plugin_id,
            source_generation: session.source.generation,
            path,
            line: lineNumber,
            timestamp: record.timestamp,
          };
          if (message === '插件调用开始') {
            assert.ok(!backgroundStarts.has(ids[0]));
            backgroundStarts.set(ids[0], relation);
          } else {
            assert.ok(!backgroundEnds.has(ids[0]));
            backgroundEnds.set(ids[0], { ...relation, code: record.fields.code });
          }
        }
      }
      for (const job of pluginJobs) {
        if (!known.get('job_id')?.has(job.job_id) || !known.get('plugin_id')?.has('android-device'))
          continue;
        const ids = [...(known.get('plugin_request_id') ?? [])];
        if (message === '插件调用开始') {
          assert.equal(ids.length, 1);
          assert.match(ids[0], /^[a-f\d-]{36}$/);
          assert.equal(known.get('log_id')?.has(job.submit_log_id), true);
          assert.ok(!calls.has(job.job_id));
          calls.set(job.job_id, {
            job_id: job.job_id,
            plugin_request_id: ids[0],
            submit_log_id: job.submit_log_id,
            path,
            line: lineNumber,
          });
        }
        if (message === '插件调用结束') {
          assert.equal(ids.length, 1);
          assert.ok(!ends.has(job.job_id));
          const expected =
            job.expected_status === 'succeeded'
              ? 'ok'
              : job.expected_status === 'cancelled'
                ? 'cancelled'
                : 'dependency_failed';
          assert.equal(record.fields.code, expected);
          ends.set(job.job_id, {
            plugin_request_id: ids[0],
            code: record.fields.code,
            path,
            line: lineNumber,
          });
        }
      }
    }
  }
  assert.deepEqual(
    [...responseIds].sort(),
    [...host.client.logIds].sort(),
    '每个实际响应日志ID须在正常退出后落盘',
  );
  assert.equal(calls.size, pluginJobs.length);
  assert.equal(ends.size, pluginJobs.length);
  const unique = new Set();
  for (const job of pluginJobs) {
    const start = calls.get(job.job_id),
      end = ends.get(job.job_id);
    assert.equal(start.plugin_request_id, end.plugin_request_id);
    assert.ok(!unique.has(start.plugin_request_id));
    unique.add(start.plugin_request_id);
    job.plugin_call = { ...start, end };
  }
  if (report.performance_mode) {
    assert.deepEqual(
      [...backgroundStarts.keys()].sort(),
      [...backgroundEnds.keys()].sort(),
      'AD-PERF-BACKGROUND-LOG-PAIRS',
    );
    for (const start of backgroundStarts.values()) {
      const end = backgroundEnds.get(start.plugin_request_id);
      assert.equal(end.session_id, start.session_id);
      assert.equal(end.source_plugin_id, start.source_plugin_id);
      assert.equal(end.source_generation, start.source_generation);
    }
    const used = new Set(),
      ns = (value) => {
        const milliseconds = Date.parse(value);
        assert.ok(Number.isSafeInteger(milliseconds));
        return BigInt(milliseconds) * 1000000n;
      };
    for (const group of report.performance.sample_groups) {
      const first = BigInt(group.tools[0].ready.unix_ns),
        lastTool = group.tools.at(-1);
      const last = BigInt((lastTool.completed ?? lastTool.ready).unix_ns);
      const matches = [...backgroundStarts.values()].filter((start) => {
        const end = backgroundEnds.get(start.plugin_request_id);
        assert.ok(end);
        return (
          start.session_id === group.session_id &&
          first >= ns(start.timestamp) - 1000000n &&
          last <= ns(end.timestamp) + 1000000n
        );
      });
      assert.equal(matches.length, 1, 'AD-PERF-BACKGROUND-LOG-ASSOCIATION');
      const start = matches[0],
        end = backgroundEnds.get(start.plugin_request_id);
      assert.equal(start.source_plugin_id, group.source.plugin_id);
      assert.equal(start.source_generation, group.source.generation);
      assert.ok(!used.has(start.plugin_request_id));
      used.add(start.plugin_request_id);
      assert.ok(['ok', 'cancelled'].includes(end.code));
      if (!group.complete) assert.equal(end.code, 'cancelled');
      group.plugin_call = { ...start, source: group.source, end };
    }
    const withoutTools = [...backgroundStarts.values()].filter(
      (start) => !used.has(start.plugin_request_id),
    );
    for (const start of withoutTools)
      assert.equal(backgroundEnds.get(start.plugin_request_id)?.code, 'cancelled');
    report.performance.background_logging = {
      plugin_calls: backgroundStarts.size,
      groups_with_actual_tools: used.size,
      zero_tool_cancelled_calls: withoutTools.map((start) => ({
        ...start,
        end: backgroundEnds.get(start.plugin_request_id),
      })),
      boundary:
        'session_id、source_plugin_id、source_generation和请求ID来自真实日志，并逐项核不可变会话来源；同父PID工具以同一会话和实际时间区间唯一关联，不声称取得插件stdin原帧',
    };
  }
  assert.ok(stops >= 1);
  report.logging = {
    response_ids: [...responseIds].sort(),
    jobs: report.jobs.length,
    ...(report.performance_mode
      ? {
          plugin_jobs: pluginJobs.length,
          builtin_session_jobs: report.jobs.length - pluginJobs.length,
        }
      : {}),
    per_job_call_relations: [...calls.values()],
    persisted_records: records,
    normal_host_stop_records: stops,
    files,
    boundary: '逐项Job/log_id/request_id配对；工具argv与父PID另证，未截获协议帧',
  };
}
export async function writeReport(root, report) {
  report.completed_at = new Date().toISOString();
  await mkdir(join(root, 'artifacts'), { recursive: true });
  const prefix = report.performance_mode
    ? 'android-device-performance-smoke-'
    : 'android-device-smoke-';
  const directory = join(root, 'artifacts', prefix + report.profile + '-' + report.run_id);
  await mkdir(directory);
  const path = join(directory, 'report.json');
  report.report_path = path;
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  return path;
}
