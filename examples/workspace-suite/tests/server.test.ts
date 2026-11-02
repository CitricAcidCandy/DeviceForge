import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function invoke(request: string | Uint8Array) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/entry.ts', import.meta.url))], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output: Buffer[] = [], errors: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
  const timeout = setTimeout(() => child.kill(), 5000);
  try {
    const finished = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') reject(error);
      });
    });
    child.stdin.end(request);
    const code = await finished;
    return { code, output: Buffer.concat(output).toString('utf8'), errors: Buffer.concat(errors).toString('utf8') };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}
const request = (input: unknown, operation = 'normalize') =>
  JSON.stringify({ protocol_version: 1, request_id: 'standalone-test', operation, input });

test('真实Node协议1子进程只输出一份匹配身份的结果，不依赖宿主或SDK', async () => {
  const result = await invoke(request({ message: '  e\u0301  你好\n世界\t ' }));
  assert.equal(result.code, 0);
  assert.equal(result.errors, '');
  assert.deepEqual(JSON.parse(result.output), {
    protocol_version: 1, request_id: 'standalone-test', result: { message: 'é 你好 世界' },
  });
  assert.equal(result.output.trim().split('\n').length, 1);
});

test('业务坏输入与未知操作返回匹配身份的非空错误，不同时写result', async () => {
  for (const text of [request({ message: 'a', extra: true }), request({ message: 'a' }, 'unknown'),
    request({ message: '😀'.repeat(1001) })]) {
    const result = await invoke(text);
    assert.equal(result.code, 0);
    const response: unknown = JSON.parse(result.output);
    assert.ok(response && typeof response === 'object' && 'error' in response);
    assert.equal('result' in response, false);
    assert.equal(result.errors, '');
  }
});

test('畸形JSON、非法UTF8、错误协议和超限输入不会伪造请求身份或输出成功', async () => {
  for (const text of ['{', new Uint8Array([0xff]), '{"protocol_version":6}', ' '.repeat(512 * 1024 + 1)]) {
    const result = await invoke(text);
    assert.equal(result.code, 1);
    assert.equal(result.output, '');
    assert.equal(result.errors, '工作区示例请求解析失败\n');
  }
});
