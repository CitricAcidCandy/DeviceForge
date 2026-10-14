import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const text = (block, start, length) =>
  block
    .subarray(start, start + length)
    .toString('utf8')
    .replace(/\0.*$/s, '');
function octal(block, start, length) {
  const value = text(block, start, length).trim();
  assert.match(value, /^[0-7]+$/, '本次npm TAR数值必须为有效八进制');
  const parsed = Number.parseInt(value, 8);
  assert.ok(Number.isSafeInteger(parsed));
  return parsed;
}

// 只读本次npm归档，不解压落盘；执行成员不接受链接、重复或越界路径。
export async function archiveMembers(path, expectedSha256) {
  const compressed = await readFile(path);
  assert.match(expectedSha256, /^[\da-f]{64}$/);
  assert.equal(digest(compressed), expectedSha256, '实际解析的保留TGZ必须与当次原始摘要相等');
  assert.ok(compressed.length <= 64 * 1024 * 1024, '本次归档超过64MiB验收上限');
  const tar = gunzipSync(compressed, { maxOutputLength: 256 * 1024 * 1024 });
  const members = [];
  const seen = new Set();
  let ended = false;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((value) => value === 0)) {
      assert.ok(
        tar.subarray(offset).every((value) => value === 0),
        'TAR结束后仍有非零成员',
      );
      ended = true;
      break;
    }
    let checksum = 0;
    for (let index = 0; index < 512; index++)
      checksum += index >= 148 && index < 156 ? 32 : block[index];
    assert.equal(checksum, octal(block, 148, 8), 'TAR成员头校验失败');
    const prefix = text(block, 345, 155);
    const name = `${prefix ? `${prefix}/` : ''}${text(block, 0, 100)}`;
    const type = block[156];
    const directory = type === 53;
    const parts = (directory ? name.replace(/\/$/, '') : name).split('/');
    assert.ok(
      parts[0] === 'package' &&
        !/[\\:]/.test(name) &&
        parts.every((part) => part !== '' && part !== '.' && part !== '..'),
      'TAR成员路径越界',
    );
    assert.ok(!seen.has(name), 'TAR成员重复');
    seen.add(name);
    assert.ok(directory || type === 0 || type === 48, '本次npm成员必须是普通文件或目录');
    const size = octal(block, 124, 12);
    assert.ok(offset + 512 + size <= tar.length, 'TAR成员正文截断');
    if (directory) assert.equal(size, 0);
    else {
      const bytes = tar.subarray(offset + 512, offset + 512 + size);
      members.push({ relative_path: parts.slice(1).join('/'), bytes: size, sha256: digest(bytes) });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(ended && members.length > 0, '本次npm归档缺少完整结束标记或文件');
  return members.sort((left, right) =>
    left.relative_path < right.relative_path
      ? -1
      : left.relative_path > right.relative_path
        ? 1
        : 0,
  );
}

export async function verifyArchiveCache(archive, packageRoot, resources, expectedSha256) {
  const members = await archiveMembers(archive, expectedSha256);
  for (const resource of resources) {
    assert.ok(
      members.some((member) => member.relative_path === resource.relative_path),
      '运行资源必须在本次TGZ中',
    );
  }
  for (const member of members) {
    const path = join(packageRoot, ...member.relative_path.split('/'));
    const stat = await lstat(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), '缓存成员必须为普通文件');
    const bytes = await readFile(path);
    assert.equal(bytes.length, member.bytes, `TGZ与缓存长度不符：${member.relative_path}`);
    assert.equal(digest(bytes), member.sha256, `TGZ与缓存摘要不符：${member.relative_path}`);
  }
  const descriptor = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(descriptor.bin?.deviceforge, 'cli/bin/deviceforge.mjs');
  const entry = await realpath(join(packageRoot, descriptor.bin.deviceforge));
  const shimPath = resolve(
    packageRoot,
    '../../.bin',
    process.platform === 'win32' ? 'deviceforge.cmd' : 'deviceforge',
  );
  const shim = await readFile(shimPath);
  let parsedTarget = entry;
  if (process.platform === 'win32') {
    const lines = shim
      .toString('utf8')
      .replaceAll('\r\n', '\n')
      .trim()
      .split('\n')
      .map((line) => line.trim());
    const prefix = [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      '',
      'IF EXIST "%dp0%\\node.exe" (',
      'SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      'SET "_prog=node"',
      'SET PATHEXT=%PATHEXT:;.JS;=;%',
      ')',
      '',
    ];
    assert.deepEqual(lines.slice(0, -1), prefix, '本次npm Windows shim只允许已知命令模板');
    const invocation = lines
      .at(-1)
      .match(
        /^endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%"\s+"(%dp0%\\[^"\r\n]+)" %\*$/,
      );
    assert.ok(invocation, '必须解析实际执行行，不能从注释猜测入口');
    parsedTarget = await realpath(
      resolve(dirname(shimPath), invocation[1].slice('%dp0%\\'.length)),
    );
    assert.equal(parsedTarget, entry, 'npm实际调用目标必须是本次CLI缓存入口');
  } else assert.equal(await realpath(shimPath), entry);
  return {
    archive_sha256: expectedSha256,
    members,
    matched_files: members.length,
    passed: true,
    bin: {
      path: shimPath,
      entry,
      parsed_target: parsedTarget,
      bytes: shim.length,
      sha256: digest(shim),
    },
  };
}
