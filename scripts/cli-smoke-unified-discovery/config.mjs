import assert from 'node:assert/strict';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const providers = Object.freeze([
  Object.freeze({
    id: 'raw_npx_android',
    protocol: 2,
    platform: 'android',
    alias: 'android.devices',
  }),
  Object.freeze({
    id: 'raw_npx_harmony',
    protocol: 3,
    platform: 'harmony',
    alias: 'harmony.devices',
  }),
]);

function inside(root, path) {
  const part = relative(root, path);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

// 只升级本次临时目录已有配置；保留调用方设置的相对环境路径和全部原绑定。
export async function configure(temporary, environment) {
  assert.equal(typeof environment.APK_OPERATION_BINDINGS, 'string', '必须先调用 configureNpxAlias');
  const root = await realpath(resolve(temporary));
  const path = await realpath(resolve(environment.APK_OPERATION_BINDINGS));
  assert.ok(inside(root, path), '绑定配置必须实际位于本次 temporary 内');
  const info = await stat(path);
  assert.ok(info.isFile() && info.size <= 64 * 1024, '已有绑定配置必须是有界普通文件');
  const before = JSON.parse(await readFile(path, 'utf8'));
  assert.ok([1, 2].includes(before.format_version) && Array.isArray(before.bindings));
  const originals = structuredClone(before.bindings);
  const names = new Set(originals.map((binding) => binding.operation.id));
  assert.equal(names.size, originals.length, '既有绑定不得重复');
  for (const item of providers) assert.ok(!names.has(item.alias), '不能覆盖已有旧发现绑定');
  const additions = providers.map((item) => ({
    operation: {
      id: item.alias,
      title: `npx统一发现 ${item.platform}`,
      input_schema: { type: 'object', additionalProperties: false },
    },
    target: { kind: 'device_discovery', plugin_id: item.id },
    input: 'identity',
    result: { kind: 'device_discovery', platform: item.platform },
  }));
  const after = { ...before, format_version: 2, bindings: [...originals, ...additions] };
  assert.ok(after.bindings.length <= 256);
  const text = `${JSON.stringify(after, null, 2)}\n`;
  assert.ok(Buffer.byteLength(text, 'utf8') <= 64 * 1024);
  await writeFile(path, text, 'utf8');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(saved.bindings.slice(0, originals.length), originals, '原绑定必须完整保留');
  assert.deepEqual(saved.bindings.slice(originals.length), additions);
  return {
    path,
    formatVersion: 2,
    preservedBindings: originals.length,
    addedAliases: providers.map((item) => item.alias),
    providerIds: providers.map((item) => item.id),
  };
}
