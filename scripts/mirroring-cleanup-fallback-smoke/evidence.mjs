import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { assertListenerReleased } from '../unified-discovery-smoke/host.mjs';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { readIfExists } from '../mirroring-streaming-smoke/fixtures.mjs';

// 不保存会话 input、输出、任意错误正文、SDP/ICE 或业务请求体。
export function sessionSummary(info) {
  return {
    id: info.id, plugin_id: info.plugin_id, generation: info.generation,
    operation: info.operation, status: info.status,
    ...(info.completion ? { completion: {
      cleanup: info.completion.cleanup,
      process_exited: info.completion.process_exited,
      failure_code: info.completion.failure?.code,
    } } : {}),
  };
}

export function failureSummary(error, stage) {
  const safe = (value) => value === null || typeof value === 'number' || typeof value === 'boolean' ||
    (typeof value === 'string' && ['complete', 'failed', 'finished', 'running', 'exited', 'loaded', 'draining', 'cleanup_failed', 'conflict'].includes(value));
  return { stage, name: error.name, code: error.code,
    message: '此阶段未满足断言；不写入可能含会话输入的任意异常正文',
    ...(typeof error.operator === 'string' ? { assertion_operator: error.operator } : {}),
    ...(safe(error.actual) ? { actual: error.actual } : {}),
    ...(safe(error.expected) ? { expected: error.expected } : {}),
    ...(error instanceof AggregateError ? { errors: [...error.errors].map((item) => failureSummary(item, stage)) } : {}),
    ...(error.session ? { session: sessionSummary(error.session) } : {}),
  };
}

export async function verifyLogs(directory, host, report) {
  const root = join(directory, 'data/logs');
  const names = (await readdir(root)).filter((name) => name.endsWith('.jsonl'));
  assert.ok(names.length > 0 && names.length <= 32);
  const found = new Set(), starts = new Map(), ends = new Map(), files = [];
  let total = 0, stops = 0;
  for (const name of names) {
    const path = join(root, name);
    const size = (await stat(path)).size;
    total += size;
    assert.ok(size <= 16 * 1024 * 1024 && total <= 64 * 1024 * 1024);
    files.push(await fileIdentity(path));
    for (const [index, line] of (await readFile(path, 'utf8')).split('\n').entries()) {
      if (!line.trim()) continue;
      const record = JSON.parse(line), ids = new Set();
      const visit = (value) => {
        if (!value || typeof value !== 'object') return;
        for (const [key, item] of Object.entries(value)) {
          if (key === 'log_id' && typeof item === 'string') ids.add(item);
          else if (item && typeof item === 'object') visit(item);
        }
      };
      visit(record.fields); visit(record.span); visit(record.spans);
      for (const id of ids) if (host.client.logIds.has(id)) found.add(id);
      const fields = record.fields ?? {};
      if (fields.message === '宿主运行已结束') stops++;
      const collection = fields.message === '交互会话已准入' ? starts : fields.message === '交互会话已结束' ? ends : null;
      if (!collection) continue;
      const opened = report.sessions.find((entry) => entry.id === fields.session_id);
      assert.ok(opened, '会话日志必须属于本次实际准入');
      assert.equal(collection.has(opened.id), false);
      assert.ok(ids.has(opened.log_id));
      if (collection === ends) assert.equal(fields.cleanup, opened.expected_cleanup === 'complete' ? 'Some(Complete)' : 'Some(Failed)');
      collection.set(opened.id, { path, line: index + 1, log_id: opened.log_id });
    }
  }
  assert.deepEqual([...found].sort(), [...host.client.logIds].sort());
  assert.equal(starts.size, report.sessions.length);
  assert.equal(ends.size, report.sessions.length);
  assert.ok(stops > 0);
  report.logging = { response_log_ids: [...found].sort(), files, normal_stops: stops,
    sessions: report.sessions.map(({ id }) => ({ id, start: starts.get(id), end: ends.get(id) })) };
}

export async function verifyFixturePorts(fixture, report) {
  report.fixture_ports = [];
  for (const device of [fixture.device, fixture.nextDevice]) {
    const bytes = await readIfExists(join(fixture.plan(device), 'port'));
    if (!bytes) continue;
    const port = Number(bytes.toString('utf8'));
    assert.ok(Number.isSafeInteger(port) && port > 0 && ![7031, 5173].includes(port));
    const entry = { device, port, released: false };
    report.fixture_ports.push(entry);
    await assertListenerReleased(port);
    entry.released = true;
  }
}

export function verifyBudget(report, device) {
  const remote = report.tools.filter((entry) => entry.argv[1] === device &&
    ['cleanup', 'list-forward', 'remove-forward'].includes(entry.category));
  const first = Math.min(...remote.map((entry) => entry.started_unix_ms));
  const last = Math.max(...remote.map((entry) => Date.parse(entry.process.exit.target.exit_timestamp)));
  const lists = remote.filter((entry) => entry.category === 'list-forward');
  assert.equal(lists.length, 1, '首轮耗尽原预算后不得启动第二轮');
  assert.equal(lists[0].delay_ms, 2400);
  assert.equal(lists[0].completed_unix_ms, null, '首轮长查询必须被原有截止点截断');
  assert.notEqual(lists[0].process.exit.target.exit_code, 0);
  // 墙钟包含进程启动、探针与退出观测；这里只做粗粒度反续期，精确绝对期限由 worker 单测负责。
  report.budget = { original_budget_ms: 2000, first_tool_unix_ms: first,
    last_tool_exit_unix_ms: last, observed_remote_span_ms: last - first,
    coarse_upper_bound_ms: 2800, includes_probe_and_scheduler_overhead: true };
  assert.ok(Number.isFinite(last - first) && last - first >= 1500 && last - first < 2800,
    '远端工具观察跨度不能变成每轮独立两秒');
}
