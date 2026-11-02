import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { HostResult, Job, ServerServiceAccess } from '@deviceforge/plugin-sdk';
import { normalizeContract, submitNormalize } from '../shared/service-contracts.ts';
import { MESSAGE_SCHEMA, record } from '../browser/domain/message.ts';

test('前后端声明和浏览器模式消费同一清单契约，生成物不能悄悄过期', async () => {
  const manifest: unknown = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.ok(record(manifest) && Array.isArray(manifest.components));
  const components: readonly unknown[] = manifest.components;
  const component = components.find((entry) => record(entry) && entry.kind === 'server');
  assert.ok(record(component) && record(component.plugin) && record(component.plugin.services) &&
    Array.isArray(component.plugin.services.provided));
  const provided: readonly unknown[] = component.plugin.services.provided;
  const declaration = provided.find((entry) => record(entry) && record(entry.service) &&
    entry.service.id === 'example.workspace.normalize' && entry.service.version === '1');
  assert.ok(record(declaration) && record(declaration.contract));
  assert.deepEqual(normalizeContract.ref, declaration.service);
  assert.equal(normalizeContract.operation, `plugin.workspace_suite.server.${String(declaration.operation)}`);
  assert.deepEqual(normalizeContract.inputSchema, declaration.contract.input_schema);
  assert.deepEqual(normalizeContract.outputSchema, declaration.contract.output_schema);
  assert.deepEqual(MESSAGE_SCHEMA, declaration.contract.input_schema);
});

test('生成调用端只提交原服务一次，信号和代次不改写且受理回执不是最终结果', async () => {
  const controller = new AbortController();
  const receipt: HostResult<Job> = {
    data: { id: 'accepted-contract-job', operation: 'plugin.workspace_suite.server.normalize',
      status: 'queued', result: null, error: null },
    logId: 'contract-submission-log',
  };
  let submissions = 0;
  const server: ServerServiceAccess = {
    async list() { throw new Error('生成的薄调用端不得私自查询目录'); },
    async submit(ref, input, signal, generation) {
      submissions++;
      assert.deepEqual(ref, { id: 'example.workspace.normalize', version: '1' });
      assert.deepEqual(input, { message: '规范化输入' });
      assert.equal(signal, controller.signal);
      assert.equal(generation, 'selected-server-generation');
      return receipt;
    },
  };
  const result = await submitNormalize(server, { message: '规范化输入' },
    controller.signal, 'selected-server-generation');
  assert.equal(result, receipt);
  assert.equal(submissions, 1);
  assert.equal(result.data.status, 'queued');
  assert.equal(result.data.result, null);
  assert.equal(result.logId, 'contract-submission-log');
});
