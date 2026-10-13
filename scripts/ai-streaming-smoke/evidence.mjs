import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { answer, privateMarkers, prompt } from './contracts.mjs';

function fields(record) {
  const values = new Map();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [name, item] of Object.entries(value)) {
      if (item && typeof item === 'object') visit(item);
      else if (typeof item === 'string') {
        if (!values.has(name)) values.set(name, new Set());
        values.get(name).add(item);
      }
    }
  };
  visit(record.fields); visit(record.span); visit(record.spans);
  return values;
}

export async function verifyLogs(context) {
  const root = join(context.directory, 'data/logs');
  const names = (await readdir(root)).filter(name => name.endsWith('.jsonl'));
  assert.ok(names.length > 0 && names.length <= 32);
  const found = new Set(), starts = new Map(), ends = new Map(), jobs = new Map(), jobEnds = new Map(), files = [];
  let bytes = 0, records = 0, stops = 0;
  for (const name of names) {
    const path = join(root, name);
    const size = (await stat(path)).size;
    bytes += size;
    assert.ok(size <= 16 * 1024 * 1024 && bytes <= 64 * 1024 * 1024);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
    for (const marker of [...privateMarkers, answer, prompt, '这是完整正文快照：']) {
      assert.ok(!text.includes(marker), '普通日志不得包含正文、原工具诊断或部署环境值');
    }
    files.push(await fileIdentity(path));
    for (const [index, line] of text.split('\n').entries()) {
      if (!line.trim()) continue;
      const record = JSON.parse(line), values = fields(record), message = record.fields?.message;
      records++;
      for (const ids of values.values()) for (const id of ids) if (context.host.client.logIds.has(id)) found.add(id);
      if (message === '宿主运行已结束') stops++;
      const collection = message === '交互会话已准入' ? starts : message === '交互会话已结束' ? ends : undefined;
      if (collection) {
        const entry = context.report.opened.find(value => value.id === record.fields.session_id);
        assert.ok(entry, '后台会话日志必须属于本次独占服务');
        assert.ok(!collection.has(entry.id));
        assert.equal(record.fields.plugin_id, entry.plugin_id);
        assert.ok(values.get('log_id')?.has(entry.log_id));
        if (collection === starts) {
          assert.equal(record.fields.generation, entry.generation);
          assert.equal(record.fields.operation, entry.operation);
        } else assert.equal(record.fields.cleanup, 'Some(Complete)');
        collection.set(entry.id, { path, line: index + 1, log_id: entry.log_id });
      }
      if (!['插件调用开始', '插件调用结束'].includes(message)) continue;
      const entry = context.report.jobs.find(value => values.get('job_id')?.has(value.id));
      if (!entry) continue;
      assert.ok(values.get('plugin_id')?.has('ai-assistant'));
      const requestIds = [...(values.get('plugin_request_id') ?? [])];
      assert.equal(requestIds.length, 1);
      const target = message === '插件调用开始' ? jobs : jobEnds;
      assert.ok(!target.has(entry.id));
      if (target === jobs) assert.ok(values.get('log_id')?.has(entry.log_id));
      else assert.equal(record.fields.code, 'ok');
      target.set(entry.id, { path, line: index + 1, request_id: requestIds[0] });
    }
  }
  assert.deepEqual([...found].sort(), [...context.host.client.logIds].sort());
  assert.equal(starts.size, context.report.opened.length);
  assert.equal(ends.size, context.report.opened.length);
  assert.equal(jobs.size, context.report.jobs.length);
  assert.equal(jobEnds.size, context.report.jobs.length);
  for (const entry of context.report.jobs) assert.equal(jobs.get(entry.id).request_id, jobEnds.get(entry.id).request_id);
  assert.ok(stops > 0);
  context.report.logging = { files, records, response_ids: [...found].sort(), normal_stop_records: stops,
    sessions: context.report.opened.map(entry => ({ id: entry.id, start: starts.get(entry.id), end: ends.get(entry.id) })),
    jobs: context.report.jobs.map(entry => ({ id: entry.id, start: jobs.get(entry.id), end: jobEnds.get(entry.id) })) };
  context.report.checks.push({ name: '全部响应及后台关联落盘，正文与部署值不进普通日志', passed: true });
}

export function recordFailure(report, error, stage) {
  report.passed = false;
  report.failure_stage ??= stage;
  const evidence = { name: error.name, code: error.code, operator: error.operator,
    message: String(error.message).split('\n')[0].slice(0, 220),
    locations: String(error.stack).split('\n').filter(line => /^\s+at /.test(line)).slice(0, 6) };
  if (report.failure) { report.secondary_failures ??= []; report.secondary_failures.push(evidence); }
  else report.failure = evidence;
}
