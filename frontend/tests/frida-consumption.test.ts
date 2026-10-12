import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrida } from '../src/features/frida/index.ts';
import { ApiError } from '../src/shared/api/index.ts';
import type { ArtifactAccess } from '../src/plugin-sdk/index.ts';
import type { ArtifactDto } from '../src/shared/api/index.ts';
import type { JobGateway, JsonData } from '../src/shared/jobs/index.ts';
import { signal } from './fixtures.ts';

const script = { script_artifact_id: 'input-script', package: 'com.example.demo', mode: 'spawn', duration_ms: 1100 };
function scriptInput(): { script_artifact_id: string; package: string; mode: 'spawn'; duration_ms: number } { return { ...script, mode: 'spawn' }; }
function metadata(filename: string, size = 0, sha256 = 'a'.repeat(64)): ArtifactDto { return { id: `output-${filename}`, filename, size, sha256, media_type: 'application/octet-stream', created_at: 1 }; }
function envelope(result: JsonData, names: readonly string[]): JsonData {
  return { result, artifacts: names.map((filename) => ({ id: `output-${filename}`, filename, size: 0, sha256: 'a'.repeat(64), media_type: 'application/octet-stream', created_at: 1 })) };
}
function gateway(respond: (operation: string, input: JsonData) => JsonData): JobGateway {
  return { submit: async (operation, input) => ({ data: { id: 'frida-job', operation, status: 'succeeded', result: respond(operation, input), error: null }, logId: 'frida-log' }),
    getJob: async () => { throw new Error('终态不应查询'); }, cancelJob: async () => { throw new Error('未授权取消'); } };
}
function access(content = new Blob()): ArtifactAccess {
  return { upload: async (filename, blob) => ({ data: { id: 'uploaded', filename, mediaType: blob.type, size: blob.size, sha256: 'b'.repeat(64), createdAt: 1 }, logId: 'upload-log' }),
    download: async () => ({ data: content, logId: 'download-log' }) };
}
function scriptResult(permissions = false): JsonData {
  return { package: script.package, mode: 'spawn', duration_requested_ms: 1100, cli_timeout_seconds: 2, loaded: true, resume: 'cli_default', notice_count: 0,
    hook_summary: permissions ? [{ type: 'summary', installed_overloads: 1, missing_methods: 0 }] : [], cleanup: 'direct_cli_confirmed', target_process_cleanup: 'not_claimed' };
}

test('Frida六贡献使用业务封套并消费各自真实结果和产物', async () => {
  const calls: { operation: string; input: JsonData }[] = [];
  const frida = createFrida(gateway((operation, input) => {
    calls.push({ operation, input }); const common = ['operation.json', 'frida.log'];
    if (operation.endsWith('.server.deploy')) return envelope({ deployed: true, version_output: '17.1', root_required: true }, common);
    if (operation.endsWith('.server.status')) return envelope({ installed: true, running: true, pids: [12], version_output: '17.1', ownership: 'observed_only' }, common);
    if (operation.endsWith('.server.run')) return envelope({ pid: 12, process_start_ticks: 44, duration_ms: 1100, cleanup: 'confirmed', ownership: 'invocation' }, common);
    if (operation.endsWith('.processes')) return envelope({ source: 'frida-ps --json', processes: [{ pid: 12, name: 'demo' }] }, common);
    const permissions = operation.endsWith('.permissions.analyze'); return envelope(scriptResult(permissions), [...common, permissions ? 'permissions.js' : 'script.js', 'notices.jsonl']);
  }), access());
  assert.equal((await frida.deploy('demo', 'input-server', signal())).data.result.deployed, true);
  assert.equal((await frida.status('demo', signal())).data.result.ownership, 'observed_only');
  await frida.runServer('demo', 1100, signal()); await frida.processes('demo', signal());
  assert.equal((await frida.runScript('demo', scriptInput(), signal())).data.result.target_process_cleanup, 'not_claimed');
  await frida.analyzePermissions('demo', { package: script.package, mode: 'spawn', duration_ms: 1100, modules: ['media', 'sensor'], show_log: false }, signal());
  assert.equal(calls.length, 6); assert.deepEqual(calls[0]?.input, { device_id: 'demo', input: { artifact_id: 'input-server' } });
  assert.deepEqual(calls[4]?.input, { device_id: 'demo', input: script }); frida.dispose();
});

test('脚本上传只消费UTF8原字节，拒绝空字节并保留上传日志', async () => {
  const frida = createFrida(gateway(() => ({})), access());
  const uploaded = await frida.uploadScript(new Blob(['console.log("执行");'], { type: 'text/javascript' }), signal());
  assert.equal(uploaded.data.id, 'uploaded'); assert.equal(uploaded.logId, 'upload-log');
  await assert.rejects(frida.uploadScript(new Blob(['a\0b']), signal()), ApiError);
  await assert.rejects(frida.uploadScript(new Blob([new Uint8Array([255])]), signal()), ApiError); frida.dispose();
});

test('权限模块、Hook字符串及最短时长与后端严格对齐', () => {
  const frida = createFrida(gateway(() => ({})), access());
  assert.throws(() => frida.status('demo;id', signal()), ApiError);
  assert.throws(() => frida.runServer('demo', 99, signal()), ApiError);
  assert.throws(() => frida.analyzePermissions('demo', { package: script.package, mode: 'attach', duration_ms: 100, hooks: [{ class: 'bad;class', method: 'run', action: '操作', messages: '说明' }] }, signal()), ApiError); frida.dispose();
});

test('拒绝缺产物及无Hook初始化总计的权限成功结果', async () => {
  const missing = createFrida(gateway(() => envelope({ deployed: true, version_output: '17', root_required: true }, ['operation.json'])), access());
  await assert.rejects(missing.deploy('demo', 'server', signal()), (error: unknown) => error instanceof ApiError && error.logId === 'frida-log'); missing.dispose();
  const permissions = createFrida(gateway(() => envelope(scriptResult(), ['operation.json', 'frida.log', 'permissions.js', 'notices.jsonl'])), access());
  await assert.rejects(permissions.analyzePermissions('demo', { package: script.package, mode: 'spawn', duration_ms: 1100 }, signal()), ApiError); permissions.dispose();
});

test('JSON及日志产物仍下载原字节，大小和摘要不匹配拒绝', async () => {
  const blob = new Blob(['{"说明":"日志原字节"}'], { type: 'application/json' });
  const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const frida = createFrida(gateway(() => ({})), access(blob));
  const output = { result: {}, artifacts: [metadata('operation.json', blob.size, digest)] };
  const downloaded = await frida.download(output, 'operation.json', signal()); assert.equal(downloaded.data, blob); assert.equal(downloaded.logId, 'download-log');
  await assert.rejects(frida.download({ ...output, artifacts: [metadata('operation.json', blob.size, '0'.repeat(64))] }, 'operation.json', signal()), (error: unknown) => error instanceof ApiError && error.code === 'artifact_digest_mismatch' && error.logId === 'download-log');
  frida.dispose(); await assert.rejects(frida.download(output, 'operation.json', signal()), ApiError);
});
