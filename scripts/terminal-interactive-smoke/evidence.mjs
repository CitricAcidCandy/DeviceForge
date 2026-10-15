import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';

export function recordOpen(host, info, report) {
  const logId = report.last_request?.log_id;
  assert.ok(host.client.logIds.has(logId));
  assert.ok(!report.opened.some((entry) => entry.id === info.id));
  report.opened.push({
    id: info.id,
    plugin_id: info.plugin_id,
    generation: info.generation,
    operation: info.operation,
    log_id: logId,
  });
}

function logIds(record) {
  const found = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'log_id' && typeof item === 'string') found.add(item);
      else if (item && typeof item === 'object') visit(item);
    }
  };
  visit(record.fields);
  visit(record.span);
  visit(record.spans);
  return found;
}

export async function verifyLogs(directory, host, report) {
  const root = join(directory, 'data/logs');
  const names = (await readdir(root)).filter((name) => name.endsWith('.jsonl'));
  assert.ok(names.length > 0 && names.length <= 32);
  const found = new Set(),
    starts = new Map(),
    ends = new Map(),
    files = [];
  let bytes = 0,
    records = 0,
    stops = 0;
  for (const name of names) {
    const path = join(root, name);
    const metadata = await stat(path);
    bytes += metadata.size;
    assert.ok(metadata.size <= 16 * 1024 * 1024 && bytes <= 64 * 1024 * 1024);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
    files.push(await fileIdentity(path));
    for (const [index, line] of text.split('\n').entries()) {
      if (!line.trim()) continue;
      const record = JSON.parse(line),
        ids = logIds(record);
      records++;
      for (const id of ids) if (host.client.logIds.has(id)) found.add(id);
      const message = record.fields?.message;
      if (message === '宿主运行已结束') stops++;
      const collection =
        message === '交互会话已准入' ? starts : message === '交互会话已结束' ? ends : undefined;
      if (!collection) continue;
      const opened = report.opened.find((entry) => entry.id === record.fields.session_id);
      assert.ok(opened, '会话日志必须归属本轮打开记录');
      assert.ok(!collection.has(opened.id), '同一会话只能记录一次准入及结束');
      assert.equal(record.fields.plugin_id, opened.plugin_id);
      assert.ok(ids.has(opened.log_id), '后台会话日志必须保留打开请求关联');
      if (collection === starts) {
        assert.equal(record.fields.operation, opened.operation);
        assert.equal(record.fields.generation, opened.generation);
      } else assert.equal(record.fields.cleanup, 'Some(Complete)');
      collection.set(opened.id, { path, line: index + 1, log_id: opened.log_id });
    }
  }
  assert.deepEqual([...found].sort(), [...host.client.logIds].sort());
  assert.equal(starts.size, report.opened.length);
  assert.equal(ends.size, report.opened.length);
  assert.ok(stops > 0);
  report.logging = {
    records,
    response_ids: [...found].sort(),
    files,
    sessions: report.opened.map((entry) => ({
      ...entry,
      start: starts.get(entry.id),
      end: ends.get(entry.id),
    })),
    normal_stop_records: stops,
  };
  report.checks.push({ name: '全部响应日志ID及会话准入结束关联落盘', passed: true });
}
