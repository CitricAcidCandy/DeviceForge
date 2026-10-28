import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import { isDebuggerBatch } from '../src/services/api/debugger.ts';
import { success } from './fixtures.ts';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const instance = 'a10ae65f-52bd-4025-949f-e9913f8fe008';
const sessionId = 'a10ae65f-52bd-4025-949f-e9913f8fe009';
const target = { target_kind: 'browser', plugin_id: 'example', generation: '1', version: '1', instance_id: instance };
const session = { session_id: sessionId, target, state: 'active', idle_ttl_ms: 1800000 };
function batch(tool: string, remaining = 10000) {
  return { instance_id: instance, active_sessions: [session], targets: [target], commands: [{
    command_id: 'a10ae65f-52bd-4025-949f-e9913f8fe010', session_id: sessionId, target,
    tool, parameters: {}, remaining_ms: remaining,
  }] };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

test('桥接解码接收新增数据工具和三十秒自动调试预算，继续拒绝越界', () => {
  for (const tool of ['data_catalog', 'data_read', 'data_write']) assert.ok(isDebuggerBatch(batch(tool)));
  assert.ok(isDebuggerBatch(batch('automation_run', 30000)));
  assert.equal(isDebuggerBatch(batch('automation_run', 30001)), false);
  assert.equal(isDebuggerBatch(batch('data_write', 10001)), false);
  assert.equal(isDebuggerBatch(batch('arbitrary_evaluation')), false);
});

test('Agent桥运行装配及新增接口类型严格检查，仅检查本功能入口', () => {
  const program = ts.createProgram([fileURLToPath(import.meta.url)], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noEmit: true,
    skipLibCheck: true, allowImportingTsExtensions: true, esModuleInterop: true,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], types: ['node'],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => process.cwd(), getCanonicalFileName: file => file, getNewLine: () => '\n',
  }));
});

test('真实运行装配将自动调试桥命令逐步接到同代数据源，并回传实际写后证据', async () => {
  const document = new JSDOM('<body></body>').window.document;
  let delivered = false, ack: unknown = null, revision = '1', count = 0, writes = 0;
  const runtime = createFrontendRuntime({ baseUrl: 'http://127.0.0.1:7031', panelTarget: () => null,
    debugger: { document }, transport: async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path.endsWith('/register')) return success({ instance_id: instance, plugins: [], active_sessions: 0, idle_ttl_ms: 60000 });
      if (path.endsWith('/heartbeat')) return success({ instance_id: instance, active_sessions: [session], targets: [target] });
      if (path.endsWith('/poll')) {
        if (delivered) return success({ instance_id: instance, active_sessions: [session], targets: [target], commands: [] });
        delivered = true;
        const response = batch('automation_run', 30000);
        return success({ ...response, commands: response.commands.map(command => ({ ...command, parameters: {
          confirmed: true, steps: [
            { id: '读取', tool: 'data_read', parameters: { source_id: 'business' } },
            { id: '保存', tool: 'data_write', parameters: { source_id: 'business', value: { count: 2 }, confirmed: true },
              bind: { revision_from_step: '读取' } },
          ],
        } })) });
      }
      if (path.endsWith('/ack')) {
        ack = JSON.parse(String(init?.body));
        const value = record(ack);
        return success({ command_id: value.command_id, session_id: sessionId, state: 'succeeded', timeout_ms: 30000 });
      }
      if (path.endsWith('/disconnect')) return success({ disconnected: true });
      throw new Error('不应访问其他端点');
    } });
  try {
    runtime.webPlugins.register({ id: 'example', trusted: true, plugin: {
      id: 'example', version: '1', apiVersion: 2, panels: [], activate: async context => {
        assert.ok(context.debug?.registerDataSource);
        context.debug.registerDataSource({ id: 'business', label: '业务计数', schema: {
          type: 'object', required: ['count'], additionalProperties: false, properties: { count: { type: 'integer' } },
        }, persistence: 'memory', applyPolicy: 'immediate',
        async read() { return { revision, value: { count } }; },
        async write(request) {
          assert.equal(request.expectedRevision, revision);
          const values = record(request.value);
          assert.equal(typeof values.count, 'number');
          if (typeof values.count !== 'number') throw new Error('计数非法');
          count = values.count; revision = '2'; writes++;
        } });
      },
    } });
    await runtime.webPlugins.load('example');
    await runtime.debugger?.start();
    for (let attempt = 0; attempt < 200 && ack === null; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    const receipt = record(ack);
    assert.equal(receipt.success, true);
    const report = record(receipt.response);
    assert.equal(report.status, 'completed');
    assert.equal(report.verified, false);
    assert.equal(count, 2); assert.equal(writes, 1);
    assert.ok(Array.isArray(report.steps));
    const write = record(report.steps[1]);
    assert.equal(record(record(write.result).value).count, 2);
  } finally { await runtime.dispose(); }
});
