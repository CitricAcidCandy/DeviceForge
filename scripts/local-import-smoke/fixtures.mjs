// 小型本地夹具不运行工具、不联网，也不触发 npm 安装脚本。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { browserFixture, serverFixture } from '../../backend/scripts/online-plugins/fixtures.mjs';

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const toolId = 'local-import-fixture';
export const toolBytes = Buffer.from('本地导入持久化工具夹具：仅文本，不执行。\r\n', 'utf8');
export const settingsOwner = 'local-import-fixture';
export const sections = {
  deviceInfo: { title: '离线配置', enabled: true },
  permissions: ['fixture'],
};

// 标准 stored ZIP，逐项填写 CRC32、UTF-8 标记与中央目录偏移。
export function zip(files) {
  assert.ok(files.length > 0 && files.length <= 32);
  const local = [],
    central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8');
    const bytes = Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes, 'utf8');
    assert.ok(bytes.length <= 65536 && name.length <= 255);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, bytes);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(bytes.length, 20);
    entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export const toolArchive = () => zip([{ path: 'bundle/entry.txt', bytes: toolBytes }]);
export function toolCatalog(archive) {
  return {
    manifestVersion: 'local-20261020',
    modules: [
      {
        name: toolId,
        type: 'tool',
        version: '1.0.0',
        url: 'https://127.0.0.1:9/not-used.zip',
        sha256: digest(archive),
        size: archive.length,
        required: false,
        archiveRoot: 'bundle',
        entryFile: 'entry.txt',
      },
    ],
  };
}

export function pluginArchives() {
  return [browserFixture(), serverFixture(1)].map((fixture) => ({
    ...fixture,
    archive: zip(fixture.files),
  }));
}

export async function deploy(root, data, profile) {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const deployed = [];
  for (const id of ['tool-supply', 'settings']) {
    const directory = join(data, 'plugins', id);
    await mkdir(directory, { recursive: true });
    const manifest = JSON.parse(
      await readFile(join(root, 'backend', 'plugins', id, 'manifest.json'), 'utf8'),
    );
    const filename = `deviceforge-${id}-plugin${suffix}`;
    const source = join(root, 'backend', 'target', profile, filename);
    manifest.executable = join(directory, filename);
    // 旁置配置以可执行文件为基准；复制到私有部署可避免读取构建目录里的旧配置。
    await copyFile(source, manifest.executable);
    deployed.push({ id, path: manifest.executable });
    manifest.args = [];
    const config =
      id === 'tool-supply'
        ? {
            local_manifest: join(data, 'missing-catalog.json'),
            install_root: join(data, 'tools'),
            allow_http: false,
            download_limit_bytes: 1048576,
            extracted_limit_bytes: 1048576,
            file_limit: 100,
          }
        : { format_version: 1, storage_root: join(data, 'settings') };
    manifest.configuration.defaults = config;
    await writeFile(
      join(directory, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      join(directory, `${id}.config.json`),
      `${JSON.stringify(config, null, 2)}\n`,
      'utf8',
    );
  }
  return deployed;
}
