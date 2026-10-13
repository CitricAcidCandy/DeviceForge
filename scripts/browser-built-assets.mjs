import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

async function capture(directory) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.name.endsWith('.js')).sort((left, right) => left.name.localeCompare(right.name));
  assert.ok(entries.length > 0 && entries.length <= 128, '浏览器构建 JS 成员数量无效');
  const assets = new Map();
  const inputs = [];
  let totalBytes = 0;
  for (const entry of entries) {
    assert.ok(entry.isFile() && !entry.isSymbolicLink() && /^[a-zA-Z0-9._-]+\.js$/.test(entry.name), '浏览器构建成员不是普通 JS 文件');
    const path = join(directory, entry.name);
    const content = await readFile(path);
    totalBytes += content.length;
    assert.ok(content.length <= 8 * 1024 * 1024 && totalBytes <= 32 * 1024 * 1024, '浏览器验收构建资产超限');
    assets.set(entry.name, content);
    inputs.push({ path, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
  }
  return { assets, inputs };
}

export async function mountBuiltBrowserAssets(vite, directory) {
  const built = await capture(directory);
  vite.middlewares.use('/assets', (request, response, next) => {
    const name = new URL(request.url, 'http://127.0.0.1').pathname.slice(1);
    const content = built.assets.get(name);
    if (!content) { next(); return; }
    response.setHeader('content-type', 'text/javascript; charset=utf-8');
    response.end(content);
  });
  vite.middlewares.use((request, response, next) => {
    const name = new URL(request.url, 'http://127.0.0.1').pathname.slice(1);
    if (name.includes('/') || !/^[a-zA-Z0-9._-]+\.js$/.test(name)) { next(); return; }
    const content = built.assets.get(name);
    if (!content) { next(); return; }
    response.setHeader('content-type', 'text/javascript; charset=utf-8');
    response.end(content);
  });
  return {
    inputs: built.inputs,
    async verify() {
      assert.deepEqual((await capture(directory)).inputs, built.inputs, '浏览器构建成员与原字节在验收期间改变');
    },
  };
}
