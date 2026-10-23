// 验收可显式消费本轮交叉目标产物，默认仍沿用各构建模式的目录。
import assert from 'node:assert/strict';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const backend = fileURLToPath(new URL('../', import.meta.url));

export function smokeBinaryDirectory(profile, environment = process.env) {
  assert.ok(['debug', 'release'].includes(profile), '验收构建模式无效');
  const selected = environment.DEVICEFORGE_SMOKE_BINARY_DIR;
  if (!selected) return resolve(backend, 'target', profile);
  assert.ok(isAbsolute(selected), '验收二进制目录必须为绝对路径');
  return resolve(selected);
}

export function smokeBinary(name, profile, environment = process.env) {
  assert.match(name, /^[a-z][a-z0-9-]*$/, '验收程序名称无效');
  return resolve(
    smokeBinaryDirectory(profile, environment),
    `${name}${process.platform === 'win32' ? '.exe' : ''}`,
  );
}
