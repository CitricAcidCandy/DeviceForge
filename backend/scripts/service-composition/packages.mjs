import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { json, save, sha256 } from './common.mjs';

// 原生程序可能超过通用小型脚本夹具的 64 KiB 限额；只封装固定的三份成员。
function archive(files) {
  const blocks = [];
  for (const [path, content] of files) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    assert.ok(bytes.length <= 256 * 1024 * 1024, '原生示例单文件超过验收上限');
    const header = Buffer.alloc(512);
    const name = `package/${path}`;
    assert.ok(Buffer.byteLength(name) < 100);
    header.write(name);
    for (const [offset, length, value] of [[100, 8, 0o755], [108, 8, 0], [116, 8, 0],
      [124, 12, bytes.length], [136, 12, 0]]) {
      header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
    }
    header.fill(32, 148, 156);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

export async function installExample(context, kind) {
  const { root, binary, directories, api, report } = context;
  const example = join(root, 'examples', `server-service-${kind}`);
  const manifest = JSON.parse(await readFile(join(example, 'manifest.json'), 'utf8'));
  assert.equal(manifest.protocol_version, 6);
  const source = binary(`deviceforge-service-${kind}`);
  assert.ok((await stat(source)).size <= 256 * 1024 * 1024);
  const bytes = await readFile(source);
  const entry = `bin/deviceforge-service-${kind}${process.platform === 'win32' ? '.exe' : ''}`;
  const descriptor = JSON.parse(await readFile(join(example, 'package.json'), 'utf8'));
  // 源示例清单保留 Windows 入口；本机验收归档显式选择本次平台，不伪装跨平台分发。
  descriptor.deviceforge.entrypoints = { [`${process.platform}-${process.arch}`]: { runtime: 'native', path: entry } };
  manifest.args = ['--smoke-directory', directories[kind]];
  const tgz = archive([['package.json', json(descriptor)], ['manifest.json', json(manifest)], [entry, bytes]]);
  const file = join(context.evidence, `${manifest.id}.tgz`);
  await writeFile(file, tgz);
  report.packages.push({ id: manifest.id, path: file, size: tgz.length, sha256: sha256(tgz),
    entry_sha256: sha256(bytes), protocol_version: 6, platform: `${process.platform}-${process.arch}` });
  const installed = await api.call('/api/v2/plugin-packages/server?format=tgz', {
    method: 'POST', headers: { authorization: `Bearer ${context.token}`, 'content-type': 'application/gzip' }, body: tgz,
    timeout: 15000,
  });
  assert.equal(installed.status, 201, `原生包安装失败：${installed.body.error?.code ?? installed.status}`);
  const deployment = join(context.plugins, manifest.id);
  const deployed = JSON.parse(await readFile(join(deployment, 'manifest.json'), 'utf8'));
  assert.equal(deployed.protocol_version, 6);
  assert.equal(sha256(await readFile(deployed.executable)), sha256(bytes), '实际部署入口必须与冻结原生程序相同');
  report.packages.at(-1).deployed_executable = deployed.executable;
  await save(join(context.evidence, `${manifest.id}.deployment.json`), deployed);
  return { manifest: deployed, path: join(deployment, 'manifest.json') };
}
