import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';

const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
function fieldsOf(record) {
  const fields = new Map();
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (item && typeof item === 'object') visit(item);
      else if (typeof item === 'string') {
        if (!fields.has(key)) fields.set(key, new Set());
        fields.get(key).add(item);
      }
    }
  }
  visit(record.fields); visit(record.span); visit(record.spans); return fields;
}
export function failure(report, error, stage) {
  report.passed = false;
  const detail = { stage, name: error.name, code: error.code, operator: error.operator };
  const label = String(error.message ?? '').split('\n')[0];
  if (/^(FPS-|AD-OBS-)/.test(label) && label.length <= 180) detail.assertion_label = label;
  detail.locations = String(error.stack ?? '').split('\n')
    .filter(line => /^\s+at /.test(line) && /android-(game-fps|device-observation)-smoke/.test(line)).slice(0, 8);
  if (report.failure) { report.secondary_errors ??= []; report.secondary_errors.push(detail); }
  else report.failure = detail;
}

export async function verifyLogs(directory, host, report) {
  const folder = join(directory, 'data', 'logs');
  const names = (await readdir(folder)).filter(name => name.endsWith('.jsonl')).sort();
  assert.ok(names.length > 0 && names.length <= 256, 'FPS-LOG-FILE-COUNT');
  const sessions = new Map(report.sessions.map(session => [session.id, session]));
  const expectedFailures = new Map();
  for (const [caseId, reason] of [['starttime-reused', '采样期间应用进程已重启'], ['uid-reused', '采样期间应用进程UID已变化或无法确认']]) {
    const matched = report.sessions.filter(session => session.case_id === caseId);
    assert.equal(matched.length, 1, 'FPS-EXPECTED-FAILURE-SINGLE-SESSION');
    const session = matched[0], page = report.history.find(value => value.session.id === session.id);
    assert.ok(page, 'FPS-EXPECTED-FAILURE-HISTORY');
    assert.equal(page.session.state, 'failed', 'FPS-EXPECTED-FAILURE-STATE');
    assert.equal(page.readings.length, 0, 'FPS-EXPECTED-FAILURE-NO-PARTIAL');
    assert.ok(typeof page.session.error === 'string' && page.session.error.includes(reason), 'FPS-EXPECTED-FAILURE-REASON');
    assert.deepEqual(page.session.source, session.source, 'FPS-EXPECTED-FAILURE-SOURCE');
    expectedFailures.set(session.id, caseId);
  }
  const starts = new Map(), ends = new Map(), responses = new Set();
  report.log_files = []; let bytes = 0, stops = 0;
  for (const name of names) {
    const path = join(folder, name), size = (await stat(path)).size;
    bytes += size;
    assert.ok(size <= 16 * 1024 * 1024 && bytes <= 64 * 1024 * 1024, 'FPS-LOG-BYTES');
    const identity = await fileIdentity(path); report.log_files.push(identity);
    const lines = (await readFile(path, 'utf8')).split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      const record = JSON.parse(lines[index]), fields = fieldsOf(record), message = record.fields?.message;
      for (const id of fields.get('log_id') ?? []) if (host.client.logIds.has(id)) responses.add(id);
      if (message === '宿主运行已结束') stops++;
      if (!fields.get('plugin_id')?.has('android-device') || !['插件调用开始', '插件调用结束'].includes(message)) continue;
      const requestIds = [...(fields.get('plugin_request_id') ?? [])];
      assert.equal(requestIds.length, 1, 'FPS-PLUGIN-REQUEST-ID'); assert.match(requestIds[0], uuid);
      const sessionIds = [...(fields.get('session_id') ?? [])];
      const relation = { plugin_request_id: requestIds[0], path, line: index + 1, timestamp: record.timestamp };
      if (sessionIds.length) {
        assert.equal(sessionIds.length, 1, 'FPS-BACKGROUND-SINGLE-SESSION');
        const session = sessions.get(sessionIds[0]); assert.ok(session, 'FPS-BACKGROUND-KNOWN-SESSION');
        assert.deepEqual([...(fields.get('source_plugin_id') ?? [])], [session.source.plugin_id], 'FPS-LOG-SOURCE-PLUGIN');
        assert.deepEqual([...(fields.get('source_generation') ?? [])], [session.source.generation], 'FPS-LOG-SOURCE-GENERATION');
        Object.assign(relation, { session_id: session.id, case_id: session.case_id, source: structuredClone(session.source) });
      }
      const inventory = message === '插件调用开始' ? starts : ends;
      assert.ok(!inventory.has(requestIds[0]), 'FPS-PLUGIN-LOG-NO-DUPLICATE');
      if (message === '插件调用结束') {
        const codes = [...(fields.get('code') ?? [])]; assert.equal(codes.length, 1);
        // 仅两项已核身份换代黄金场景允许依赖失败，其他调用仍必须成功或生产取消。
        if (expectedFailures.has(relation.session_id)) assert.equal(codes[0], 'dependency_failed', 'FPS-EXPECTED-FAILURE-LOG-CODE');
        else assert.ok(['ok', 'cancelled'].includes(codes[0]), 'FPS-PLUGIN-COMPLETE-CODE');
        relation.code = codes[0];
      }
      inventory.set(requestIds[0], relation);
    }
    assert.deepEqual(await fileIdentity(path), identity, 'FPS-LOG-STABLE-AFTER-SHUTDOWN');
  }
  assert.deepEqual([...responses].sort(), [...host.client.logIds].sort(), 'FPS-ALL-RESPONSE-LOG-IDS');
  assert.deepEqual([...starts.keys()].sort(), [...ends.keys()].sort(), 'FPS-PLUGIN-LOG-PAIRS');
  report.plugin_calls = [...starts.values()].map(start => {
    const end = ends.get(start.plugin_request_id);
    assert.equal(end.session_id, start.session_id, 'FPS-LOG-SESSION-IMMUTABLE');
    assert.deepEqual(end.source, start.source, 'FPS-LOG-SOURCE-IMMUTABLE');
    return { ...start, end };
  });
  for (const session of report.sessions) assert.ok(report.plugin_calls.some(call => call.session_id === session.id), 'FPS-EACH-SESSION-CALL-LOG');
  assert.ok(report.plugin_calls.some(call => call.session_id === report.lifecycle.interrupted.id && call.end.code === 'cancelled'), 'FPS-INFLIGHT-CANCEL-LOG');
  for (const [sessionId, caseId] of expectedFailures) {
    const calls = report.plugin_calls.filter(call => call.session_id === sessionId);
    assert.equal(calls.length, 1, 'FPS-EXPECTED-FAILURE-SINGLE-CALL');
    assert.equal(calls[0].end.code, 'dependency_failed', 'FPS-EXPECTED-FAILURE-PAIRED');
    assert.equal(calls[0].case_id, caseId, 'FPS-EXPECTED-FAILURE-CASE');
  }
  assert.ok(stops >= 1, 'FPS-HOST-EXIT-LOG');
  report.response_log_ids = [...responses].sort(); report.host_stop_logs = stops;
  report.checks.push({ name: '全部响应日志ID、后台会话/固定代次与调用起止配对正常落盘', passed: true });
}
