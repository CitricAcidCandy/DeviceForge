import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { poll } from '../device-provider/client.mjs';
import { sha256 } from '../../backend/scripts/online-plugins/fixtures.mjs';
import { action, decoyBytes, events, localId, operation, pointer, processEvidence, sourceBytes } from './fixtures.mjs';
import { publicMetadata, terminal } from './client.mjs';

export async function uploadInputs(context) {
  const { host, report } = context;
  for (const [name, bytes, filename] of [['source', sourceBytes, 'nested-source.json'], ['decoy', decoyBytes, 'undeclared.json']]) {
    const metadata = await host.client.json(`/api/v2/artifacts?filename=${filename}`, { method: 'POST', status: 201,
      headers: { 'content-type': 'application/octet-stream' }, body: bytes });
    publicMetadata(metadata); assert.equal(metadata.sha256, sha256(bytes)); assert.equal(metadata.size, bytes.length);
    assert.equal(metadata.filename, filename);
    context[name] = metadata;
    await host.download(metadata, bytes);
  }
  context.hiddenId = randomUUID();
  report.checks.push({ name: '合法 JSON 输入及未声明对照产物真实上传、下载原字节', passed: true });
}

export const businessInput = (context, label, mode = 'normal') => ({
  artifact_id: context.source.id, label, mode,
  undeclared_artifact_id: context.decoy.id, hidden_artifact_id: context.hiddenId,
});

export async function writeArtifact(context, item, transport, label) {
  const { host, history } = context;
  const input = businessInput(context, label);
  const submitted = await host.client.action(action(item, input), transport);
  const job = await terminal(host.client, submitted.id);
  assert.equal(job.operation, operation(item, 'write'));
  assert.deepEqual(job.input, { device_id: localId, input }, '共享任务保存原产物 ID，不包含副本路径');
  assert.deepEqual(job.result.result, { synthetic_demo: true, provider_id: item.id, device_id: localId,
    source_artifact_id: context.source.id, field: pointer, input_sha256: context.source.sha256,
    input_size: context.source.size, input_count: 1, undeclared_exposed: false });
  assert.equal(job.result.artifacts.length, 1);
  const output = job.result.artifacts[0];
  publicMetadata(output); assert.equal(output.filename, 'device-result.json');
  assert.notEqual(output.id, context.source.id); assert.equal(output.sha256, context.source.sha256);
  assert.deepEqual(await host.client.json(`/api/v2/artifacts/${output.id}`), output);
  await host.download(output, sourceBytes);
  await host.download(context.source, sourceBytes);
  await host.download(context.decoy, decoyBytes);
  const evidence = await processEvidence(item, label);
  const related = (await events(item)).filter((event) => event.request_id === evidence.request_id);
  assert.ok(related.some((event) => event.kind === 'copy_verified' && event.field === pointer
    && event.input_count === 1 && event.sha256 === context.source.sha256));
  assert.ok(related.some((event) => event.kind === 'output_written'));
  history.set(job.id, job);
  context.report.checks.push({ name: `协议 ${item.protocol} ${transport} 嵌套副本、未声明 ID 不暴露、JSON 输出与原字节`,
    passed: true, job_id: job.id, output, evidence });
  return job;
}

export async function verifyArtifacts(context) {
  await uploadInputs(context);
  for (const item of context.fixtures) {
    for (const transport of ['http', 'mcp']) {
      await writeArtifact(context, item, transport, `normal-v${item.protocol}-${transport}`);
    }
  }
}

export async function verifyBadValues(context) {
  const { host, fixtures, report, history } = context;
  const bad = [['null', null], ['number', 17], ['object', { value: '不是字符串 ID' }],
    ['mixed-array', [context.source.id, false]]];
  for (const item of fixtures) {
    for (const [name, value] of bad) {
      const label = `bad-schema-v${item.protocol}-${name}`;
      const strict = action(item, { artifact_id: value, label });
      await host.client.post('/api/v2/device-actions', strict, { status: 400, code: 'invalid_input' });
      await host.client.tool('deviceforge.invoke_device', strict, 'invalid_input');
      assert.ok(!(await events(item)).some((event) => event.label === label), 'schema 拒绝不得启动夹具');
      report.checks.push({ name: `协议 ${item.protocol} ${name} 完整 schema 拒绝`, passed: true,
        boundary: 'HTTP/MCP 提交', status: 400, code: 'invalid_input', process_started: false });

      // 宽松 schema 刻意放行终值；必须在选择器准备阶段失败，不能以任意 4xx 或夹具错误替代。
      const earlyLabel = `bad-selector-v${item.protocol}-${name}`;
      const submitted = await host.client.action(action(item, { artifact_id: value, label: earlyLabel }, 'device.write_unchecked'),
        item.protocol === 2 ? 'http' : 'mcp');
      const failed = await terminal(host.client, submitted.id, 'failed');
      assert.equal(failed.operation, operation(item, 'write_unchecked'));
      assert.equal(failed.result, null); assert.match(failed.error, /^输入无效：/);
      await poll(() => host.logs(), (records) => records.some((record) => record.fields?.code === 'invalid_input'
        && record.fields?.message === '任务执行失败' && JSON.stringify(record).includes(failed.id)),
      '选择器失败必须落盘 invalid_input 与共享任务 ID', 3000);
      assert.ok(!(await events(item)).some((event) => event.label === earlyLabel), '坏终值不得启动产物进程');
      history.set(failed.id, failed);
      report.checks.push({ name: `协议 ${item.protocol} ${name} 选择器执行早期拒绝`, passed: true,
        boundary: '共享任务准备阶段', job_id: failed.id, status: 'failed', code: 'invalid_input', process_started: false });
    }
    const missing = action(item, { label: `missing-v${item.protocol}` });
    await host.client.post('/api/v2/device-actions', missing, { status: 400, code: 'invalid_input' });
    await host.client.tool('deviceforge.invoke_device', missing, 'invalid_input');
  }
  await host.download(context.source, sourceBytes);
}
