import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const alias = 'legacy.npx_echo';
export async function configureNpxAlias(temporary, environment) {
  const path = join(temporary, '旧操作绑定.json');
  await writeFile(path, JSON.stringify({ format_version: 1, bindings: [{
    operation: { id: alias, title: 'npx旧入口', input_schema: { type: 'object' } },
    target: { kind: 'operation', plugin_id: 'echo', operation: 'plugin.echo.echo' },
    input: 'identity', result: { kind: 'identity' },
  }] }), 'utf8');
  // 真正 npx 启动要保持相对路径语义，Rust 的工作目录为另一个数据目录。
  environment.APK_OPERATION_BINDINGS = relative(process.cwd(), path);
}

export async function verifyNpxAlias({ base, mcp, headers }) {
  const input = { message: 'npx绑定保留原输入' };
  const response = await fetch(mcp, { method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { ...headers, accept: 'application/json, text/event-stream', origin: base },
    body: JSON.stringify({ jsonrpc: '2.0', id: 701, method: 'tools/call', params: { name: alias, arguments: input } }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.error, undefined); assert.equal(body.result.isError, false);
  assert.equal(body.result._meta['deviceforge/log_id'], response.headers.get('x-deviceforge-log-id'));
  const id = body.result.structuredContent.id;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const reply = await fetch(`${base}/api/v2/jobs/${id}`, { headers, signal: AbortSignal.timeout(3000) });
    assert.equal(reply.status, 200);
    const envelope = await reply.json();
    assert.equal(envelope.log_id, reply.headers.get('x-deviceforge-log-id'));
    const job = envelope.data;
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
      assert.equal(job.status, 'succeeded', job.error);
      assert.equal(job.operation, alias); assert.deepEqual(job.input, input); assert.deepEqual(job.result, input);
      return;
    }
    await delay(25);
  }
  throw new Error('npx绑定任务未在有限期限内结束');
}
