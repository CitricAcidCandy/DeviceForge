import assert from 'node:assert/strict';
import { access, copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { digest } from '../unified-discovery-browser/lifecycle.mjs';

const casePattern = /^[A-Za-z0-9_-]{1,80}$/;
const decimal = (value) => typeof value === 'string' && /^\d+$/.test(value);
const within = (root, path) => {
  const child = relative(resolve(root), resolve(path));
  return child && !isAbsolute(child) && child !== '..' && !child.startsWith('..' + '/')
    && !child.startsWith('..' + '\\');
};

// 仅动态读取已冻结 helper；缺文件时报告前置缺失，不私造服务器包。
export async function loadServerFixtures(directory, artifacts, report) {
  const helperUrl = new URL('../ordinary-deadline/fixtures.mjs', import.meta.url);
  report.fixture_helper = { path: 'scripts/ordinary-deadline/fixtures.mjs', status: '等待读取' };
  await access(helperUrl);
  const helper = await import(helperUrl.href);
  assert.equal(typeof helper.createFixtures, 'function', 'Galileo helper 缺少冻结导出');
  await mkdir(directory, { recursive: true });
  const fixtures = await helper.createFixtures(directory, report);
  assert.ok(Array.isArray(fixtures) && fixtures.length === 2, '夹具必须含协议2/3两项');
  assert.deepEqual(fixtures.map((fixture) => fixture.protocolVersion).sort(), [2, 3]);
  assert.equal(fixtures[0].runId, fixtures[1].runId, '两协议夹具必须共享本次runId');
  const ids = new Set();
  for (const fixture of fixtures) {
    assert.match(fixture.pluginId, /^[a-z][a-z0-9._-]{0,99}$/);
    assert.ok(!ids.has(fixture.pluginId), '夹具插件ID重复'); ids.add(fixture.pluginId);
    assert.equal(fixture.shortTimeoutMs, 10000);
    assert.ok(typeof fixture.runId === 'string' && fixture.runId.length > 0);
    assert.ok(isAbsolute(fixture.archivePath) && within(directory, fixture.archivePath), '归档不在本次夹具根');
    assert.ok(isAbsolute(fixture.controlRoot) && within(directory, fixture.controlRoot), '控制根不在本次夹具根');
    assert.deepEqual(Object.keys(fixture.operations).sort(), ['default', 'long', 'short']);
    for (const name of ['long', 'short', 'default']) assert.ok(typeof fixture.operations[name] === 'string' && fixture.operations[name]);
    assert.equal(new Set(Object.values(fixture.operations)).size, 3);
    const actual = await digest(fixture.archivePath);
    assert.match(fixture.archiveSha256, /^[a-fA-F0-9]{64}$/);
    assert.equal(actual.sha256, fixture.archiveSha256.toLowerCase(), 'helper归档摘要与真实字节不一致');
    const saved = join(artifacts, 'server-' + fixture.protocolVersion + '.tgz');
    await copyFile(fixture.archivePath, saved);
    fixture.archivePath = saved;
    fixture.caseId = 'browser_default_' + fixture.protocolVersion + '_' + report.run_id.replace(/-/g, '');
    assert.match(fixture.caseId, casePattern);
    report.packages.push({ kind: 'server', pluginId: fixture.pluginId, protocolVersion: fixture.protocolVersion,
      archive: saved, ...actual, runId: fixture.runId, caseId: fixture.caseId, operations: fixture.operations,
      shortTimeoutMs: fixture.shortTimeoutMs, generator: 'scripts/ordinary-deadline/fixtures.mjs::createFixtures' });
  }
  report.fixture_helper.status = '冻结接口已接线';
  return fixtures;
}

function sameIdentity(actual, expected) {
  for (const name of ['run_id', 'case_id', 'plugin_id', 'protocol_version', 'pid', 'request_id',
    'request_operation', 'ready_monotonic_ns']) assert.equal(actual[name], expected[name], '身份不匹配：' + name);
}
function absent(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; throw error; }
}

export function createDefaultEvidence(fixtures, artifacts, report) {
  report.default_processes = [];
  return async ({ pluginId, caseId, result }) => {
    const fixture = fixtures.find((entry) => entry.pluginId === pluginId);
    assert.ok(fixture && caseId === fixture.caseId && casePattern.test(caseId), '控制调用不是本次default身份');
    assert.ok(result && typeof result === 'object' && !Array.isArray(result));
    assert.deepEqual(Object.keys(result).sort(), ['case_id', 'completed_monotonic_ns', 'elapsed_ms', 'pid', 'plugin_id',
      'protocol_version', 'ready_monotonic_ns', 'request_id', 'request_operation', 'run_id']);
    assert.equal(result.run_id, fixture.runId); assert.equal(result.case_id, caseId);
    assert.equal(result.plugin_id, pluginId); assert.equal(result.protocol_version, fixture.protocolVersion);
    assert.ok(Number.isSafeInteger(result.pid) && result.pid > 0 && result.pid !== process.pid);
    assert.ok(typeof result.request_id === 'string' && result.request_id.length > 0);
    assert.equal(result.request_operation, 'default', 'SDK证据必须使用短操作名，而非完整公开ID');
    assert.ok(decimal(result.ready_monotonic_ns) && decimal(result.completed_monotonic_ns));
    assert.ok(BigInt(result.completed_monotonic_ns) >= BigInt(result.ready_monotonic_ns));
    assert.ok(typeof result.elapsed_ms === 'number' && Number.isFinite(result.elapsed_ms) && result.elapsed_ms >= 0);
    const elapsed = Number(BigInt(result.completed_monotonic_ns) - BigInt(result.ready_monotonic_ns)) / 1000000;
    assert.ok(Math.abs(result.elapsed_ms - elapsed) <= 2, 'elapsed_ms不是同一进程单调时钟差');
    const readyPath = join(fixture.controlRoot, caseId + '.ready.json');
    const eventsPath = join(fixture.controlRoot, caseId + '.events.jsonl');
    const evidence = { pluginId, caseId, result, passed: false }; report.default_processes.push(evidence);
    const deadline = Date.now() + 8000;
    let readyBytes; let eventBytes; let ready; let events;
    while (true) {
      readyBytes = await readFile(readyPath); assert.ok(readyBytes.length <= 8192);
      ready = JSON.parse(readyBytes.toString('utf8')); sameIdentity(ready, result);
      eventBytes = await readFile(eventsPath); assert.ok(eventBytes.length <= 256 * 1024);
      events = eventBytes.toString('utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      if (events.some((event) => event.event === 'process_exit') && absent(result.pid)) break;
      if (Date.now() >= deadline) throw new Error('default进程事件或实际PID退出未收敛');
      await delay(50);
    }
    const known = ['ready', 'cancel_received', 'response_written', 'cleaned', 'stdin_eof', 'process_exit'];
    let last = 0n;
    for (const event of events) {
      assert.ok(known.includes(event.event)); sameIdentity(event, result);
      assert.ok(decimal(event.monotonic_ns)); const now = BigInt(event.monotonic_ns);
      assert.ok(now >= last, '事件单调时钟回退'); last = now;
      assert.notEqual(event.event, 'cancel_received', '有限default不应被取消');
    }
    for (const name of ['ready', 'response_written', 'cleaned', 'stdin_eof', 'process_exit']) {
      assert.equal(events.filter((event) => event.event === name).length, 1, '事件缺失或重复：' + name);
    }
    assert.equal(events.find((event) => event.event === 'process_exit').code, 0);
    const savedPrefix = join(artifacts, 'default-' + fixture.protocolVersion);
    await copyFile(readyPath, savedPrefix + '.ready.json'); await copyFile(eventsPath, savedPrefix + '.events.jsonl');
    evidence.ready = ready; evidence.events = events; evidence.pidAbsent = true; evidence.passed = true;
    evidence.boundary = '真实PID不存在另行核对；cleaned仅证明本次夹具资源，不证明外部设备事务';
    return evidence;
  };
}

// 失败时也保留已产生的身份文件；不写release、不删除控制根。
export async function preserveControls(fixtures, artifacts, report) {
  report.control_evidence = [];
  for (const fixture of fixtures) {
    let names;
    try { names = await readdir(fixture.controlRoot); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    assert.ok(names.length <= 100, '本次控制文件数量超限');
    for (const name of names.filter((name) => name.endsWith('.ready.json') || name.endsWith('.events.jsonl')
      || name.endsWith('.diagnostic.json') || name.endsWith('.resource'))) {
      assert.ok(!name.includes('/') && !name.includes('\\'));
      const source = join(fixture.controlRoot, name); const metadata = await digest(source);
      assert.ok(metadata.bytes <= 256 * 1024, '本次控制证据超限');
      const target = join(artifacts, fixture.protocolVersion + '-' + name); await copyFile(source, target);
      report.control_evidence.push({ protocolVersion: fixture.protocolVersion, path: target, ...metadata });
    }
  }
}
