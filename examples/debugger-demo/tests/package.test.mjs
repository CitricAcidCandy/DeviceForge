import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32 as standardCrc32 } from 'node:zlib';
import { buildPackages, componentFiles } from '../tools/pack.mjs';
import { crc32, zip } from '../tools/archive.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// 独立解读 ZIP 目录和本地头，核对 CRC、偏移、长度与实际字节。
function unpack(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const directory = offset;
  const files = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    assert.equal(bytes.readUInt16LE(offset + 10), 0);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const local = bytes.readUInt32LE(offset + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    assert.equal(bytes.readUInt32LE(local + 18), size);
    const localName = bytes.readUInt16LE(local + 26);
    assert.equal(bytes.subarray(local + 30, local + 30 + localName).toString('utf8'), name);
    const start = local + 30 + localName + bytes.readUInt16LE(local + 28);
    const content = bytes.subarray(start, start + size);
    assert.equal(standardCrc32(content), bytes.readUInt32LE(offset + 16));
    assert.equal(standardCrc32(content), bytes.readUInt32LE(local + 14));
    assert.ok(start + size <= directory);
    assert.ok(!files.has(name));
    files.set(name, content);
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  assert.equal(offset, end);
  assert.equal(bytes.readUInt32LE(end + 12), end - directory);
  return files;
}

test('ZIP 字节符合标准 CRC 且拒绝越界与重复路径', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(unpack(zip([['hello.txt', Buffer.from('你好')]])).get('hello.txt').toString(), '你好');
  for (const path of ['/x', '../x', 'x/../y', 'x\\y', 'x//y'])
    assert.throws(() => zip([[path, Buffer.from('x')]]));
  assert.throws(() => zip([['x', Buffer.from('x')], ['x', Buffer.from('y')]]));
});

test('组件归档身份一致、入口和相对导入完整且不包含源码路径依赖', async () => {
  const built = await buildPackages();
  for (const kind of ['browser', 'server']) {
    const bytes = built.outputs.find((item) => item.filename === `${kind}.zip`).bytes;
    const files = unpack(bytes);
    assert.deepEqual([...files.keys()].sort(), [...componentFiles[kind]].sort());
    const descriptor = JSON.parse(files.get('package.json'));
    const manifest = JSON.parse(files.get('plugin.json'));
    assert.equal(descriptor.version, manifest.version);
    assert.equal(descriptor.deviceforge.kind, kind);
    assert.ok(files.has(descriptor.deviceforge.entrypoints.any.path));
    assert.equal(descriptor.dependencies, undefined);
    for (const [path, source] of files) {
      if (!/\.(?:m?js)$/.test(path)) continue;
      const text = source.toString('utf8');
      assert.doesNotMatch(text, /frontend\/src|backend\/crates|\.\.\/.*plugin-sdk|__DEVICEFORGE/);
      for (const match of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
        const dependency = match[1];
        assert.ok(dependency.startsWith('./'), `只允许包内相对导入：${path}`);
        assert.ok(files.has(join(dirname(path), dependency).split(sep).join('/')));
      }
    }
  }
});

test('成套发布闭包使用真实 ZIP 字节、摘要和长度，重复生成字节一致', async () => {
  const built = await buildPackages();
  const files = unpack(built.outputs.find((item) => item.filename === 'debugger-demo.zip').bytes);
  const release = JSON.parse(files.get('release.json'));
  assert.equal(release.format_version, 1);
  assert.equal(release.host_api_version, 2);
  assert.equal(release.components.length, 2);
  for (const component of release.components) {
    const variant = component.variants[0];
    const bytes = files.get(variant.path);
    assert.equal(bytes.length, variant.size);
    assert.equal(digest(bytes), variant.sha256);
    assert.equal(JSON.parse(unpack(bytes).get('plugin.json')).id, component.id);
  }
  const again = await buildPackages();
  assert.deepEqual(again.checksums, built.checksums);
});

test('复制交付文件后可独立打包和导入，默认拒绝覆盖，测试临时目录回收', async () => {
  const temporary = await mkdtemp(join(root, '.test-standalone-'));
  try {
    for (const [kind, files] of Object.entries(componentFiles)) {
      for (const path of files) {
        const target = join(temporary, kind, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, await readFile(join(root, kind, path)), { flag: 'wx' });
      }
    }
    await mkdir(join(temporary, 'tools'));
    for (const path of ['archive.mjs', 'pack.mjs'])
      await writeFile(join(temporary, 'tools', path), await readFile(join(root, 'tools', path)), { flag: 'wx' });
    const standalone = await import(pathToFileURL(join(temporary, 'tools/pack.mjs')).href);
    const output = join(temporary, 'out');
    const checksums = await standalone.writePackages(output);
    for (const entry of checksums) assert.equal(digest(await readFile(join(output, entry.filename))), entry.sha256);
    await assert.rejects(standalone.writePackages(output), { code: 'EEXIST' });
    const plugin = (await import(pathToFileURL(join(temporary, 'browser/src/index.js')).href)).default;
    assert.equal(plugin.id, 'demo.debugger.browser');
    assert.equal(checksums.length, 3);
  } finally {
    // 只递归回收本测试创建、已核对在示例目录内的绝对路径。
    const checked = resolve(temporary);
    const child = relative(root, checked);
    assert.ok(child.startsWith('.test-standalone-') && !child.startsWith(`..${sep}`) && !isAbsolute(child));
    await rm(checked, { recursive: true, force: true });
  }
});
