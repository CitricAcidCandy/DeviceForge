// 仅从明确的 SDK 文件构造 HDC 闭包；不会复制同目录中的日志或其他工具。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { writeZip, archiveMembers } from './archive.mjs';
import { measureFile } from './io.mjs';

function importedLibraries(bytes) {
  const pe = bytes.readUInt32LE(0x3c), optional = pe + 24;
  if (bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0' || bytes.readUInt16LE(pe + 4) !== 0x8664 || bytes.readUInt16LE(optional) !== 0x20b)
    throw new Error('HDC 入口必须为 Windows x64 PE');
  const count = bytes.readUInt16LE(pe + 6), size = bytes.readUInt16LE(pe + 20), sections = [];
  for (let index = 0; index < count; index++) {
    const offset = optional + size + index * 40;
    sections.push({ virtual: bytes.readUInt32LE(offset + 12), size: Math.max(bytes.readUInt32LE(offset + 8), bytes.readUInt32LE(offset + 16)), raw: bytes.readUInt32LE(offset + 20) });
  }
  const rawOffset = (rva) => {
    const section = sections.find((section) => section.virtual <= rva && rva < section.virtual + section.size);
    if (!section) throw new Error('HDC 导入表越界');
    return section.raw + rva - section.virtual;
  };
  let offset = rawOffset(bytes.readUInt32LE(optional + 112 + 8));
  const libraries = [];
  while (!bytes.subarray(offset, offset + 20).every((byte) => byte === 0)) {
    if (offset + 20 > bytes.length || libraries.length >= 256) throw new Error('HDC 导入表无效');
    const nameOffset = rawOffset(bytes.readUInt32LE(offset + 12)), end = bytes.indexOf(0, nameOffset);
    if (end < nameOffset || end - nameOffset > 256) throw new Error('HDC 导入名称无效');
    libraries.push(bytes.toString('ascii', nameOffset, end));
    offset += 20;
  }
  return libraries;
}

const source = resolve(process.argv[2] ?? 'E:/React_Js/Electron/ApkTool/Tools/hdc'),
  destination = resolve(process.argv[3] ?? 'artifacts/plugin-release-candidates-20261022/hdc-tools');
const members = [], evidence = [];
for (const name of ['hdc.exe', 'libusb_shared.dll', 'NOTICE.txt', 'oh-uni-package.json']) {
  const path = join(source, name), measured = await measureFile(path), bytes = await readFile(path),
    imports = name.endsWith('.exe') || name.endsWith('.dll') ? importedLibraries(bytes) : [];
  const permitted = /^(?:libusb_shared|PSAPI|USER32|ADVAPI32|IPHLPAPI|USERENV|WS2_32|dbghelp|ole32|SHELL32|KERNEL32|CRYPT32|api-ms-win-crt-[a-z0-9-]+)\.dll$/i;
  if (imports.some((name) => !permitted.test(name))) throw new Error('HDC 存在未封闭的非系统 DLL 依赖');
  members.push({ name, path });
  evidence.push({ name, ...measured, imports });
}
const notice = (await readFile(join(source, 'NOTICE.txt'), 'utf8'));
if (!/libusb/i.test(notice) || !/hdc/i.test(notice)) throw new Error('HDC SDK 许可资料未覆盖 hdc/libusb');
await mkdir(destination);
const archive = join(destination, 'hdc-5.0.0.71-win32-x64-local-repack.zip');
await writeZip(archive, members);
const report = { version: '5.0.0.71', source, archive, ...await measureFile(archive), members: evidence, excluded: ['test111111111.log', '其余 SDK 工具'], redistribution: '保留 SDK NOTICE，来自既有本机 SDK 的独立 HDC 闭包；未声明 Harmony 真机验收' };
const actual = await archiveMembers(archive, 'zip', { collect: false });
if (actual.size !== members.length) throw new Error('HDC 再包装成员数量不一致');
await writeFile(join(destination, 'provenance.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
