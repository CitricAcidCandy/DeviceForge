// 报告只记录本轮夹具数据；不读取用户令牌或真实配置。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export const save = (path, value) => writeFile(path, json(value));

export async function identity(path) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const bytes of createReadStream(path)) { hash.update(bytes); size += bytes.length; }
  return { path, size, sha256: hash.digest('hex') };
}

export async function poll(read, done, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (done(value)) return value;
    await delay(50);
  }
  throw new Error(`等待超时：${label}`);
}

export async function tree(root) {
  const files = [];
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), info = await lstat(path);
      assert.ok(!info.isSymbolicLink(), '审计目录不得含符号链接');
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) files.push({ ...(await identity(path)), path: relative(root, path).replaceAll('\\', '/') });
    }
  }
  await visit(root);
  return files;
}

export function check(report, name, evidence = {}) {
  report.checks.push({ name, passed: true, at: new Date().toISOString(), ...evidence });
}

export function assertView(view, target) {
  assert.deepEqual(view.target, target);
  assert.match(view.revision ?? '', /^[a-f0-9]{64}$/, '依赖修订必须为公开的 SHA-256 身份');
  assert.equal(typeof view.ready, 'boolean');
  assert.ok(Array.isArray(view.dependencies));
  const ids = new Set();
  for (const dependency of view.dependencies) {
    assert.ok(typeof dependency.id === 'string' && !ids.has(dependency.id)); ids.add(dependency.id);
    for (const key of ['name', 'version_requirement']) assert.equal(typeof dependency[key], 'string');
    for (const key of ['required', 'installable']) assert.equal(typeof dependency[key], 'boolean');
    assert.ok(['ready', 'missing', 'incompatible', 'failed'].includes(dependency.status));
    assert.ok([null, 'environment', 'shared', 'local'].includes(dependency.source));
    assert.ok(dependency.version === null || typeof dependency.version === 'string');
    assert.ok(dependency.message === null || typeof dependency.message === 'string');
    if (dependency.status === 'ready') assert.ok(dependency.source && dependency.version);
  }
  assert.equal(view.ready, view.dependencies.every((dependency) => !dependency.required || dependency.status === 'ready'));
  return view;
}
