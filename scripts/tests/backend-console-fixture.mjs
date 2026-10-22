// 所有服务、日志和监听均限定为本轮私有临时目录与空闲端口。
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const project = fileURLToPath(new URL('../../', import.meta.url));
export async function ownedDirectory(run) {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, 'deviceforge-backend-console-test-'));
  try {
    return await run(directory);
  } finally {
    const actual = await realpath(directory);
    assert.equal(dirname(actual), parent);
    assert.ok(basename(actual).startsWith('deviceforge-backend-console-test-'));
    await rm(actual, { recursive: true, force: true });
  }
}
export async function freePort(port = 0) {
  assert.notEqual(port, 7031, '测试禁止接触预览端口');
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const selected = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (selected === 7031) return freePort();
  return selected;
}
export async function testConfiguration(directory) {
  const config = {
    directory,
    binary: join(
      project,
      'backend',
      'target',
      'debug',
      process.platform === 'win32' ? 'apk-server.exe' : 'apk-server',
    ),
    dataDirectory: join(directory, 'data'),
    userDirectory: join(directory, 'user', '.deviceforge'),
    pluginDirectory: join(directory, 'plugins'),
    browserPluginDirectory: join(directory, 'browser-plugins'),
    logDirectory: join(directory, 'logs'),
    port: await freePort(),
  };
  config.bind = `127.0.0.1:${config.port}`;
  for (const path of [
    config.dataDirectory,
    config.pluginDirectory,
    config.browserPluginDirectory,
    config.logDirectory,
  ])
    await mkdir(path);
  return config;
}
export const record = (message, fields = {}) => ({
  timestamp: '2026-10-20T10:00:00.000Z',
  level: 'INFO',
  target: 'deviceforge.console.test',
  fields: { message, ...fields },
});
export const encoded = (value) => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
export const lines = (writes) => writes.join('\n');
export async function healthy(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/v2/health`, {
    signal: AbortSignal.timeout(1500),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.status, 'ok');
}
