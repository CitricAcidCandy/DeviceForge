import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

// 仅使用已冻结的公开配置形状；设备版本与平台由实际manifest/提供者独立核对。
export function discoveryBinding({ operation, pluginId, platform, legacy = false }) {
  assert.ok(typeof operation === 'string' && operation.length > 0);
  assert.ok(typeof pluginId === 'string' && pluginId.length > 0);
  if (legacy) assert.ok(typeof platform === 'string' && platform.length > 0);
  return {
    operation: { id: operation, title: '统一发现真实验收别名', input_schema: { type: 'object' } },
    target: { kind: 'device_discovery', plugin_id: pluginId },
    input: 'identity',
    result: legacy ? { kind: 'device_discovery', platform } : { kind: 'identity' },
  };
}

export async function writeBindings(path, declarations) {
  const config = { format_version: 2, bindings: declarations.map(discoveryBinding) };
  assert.equal(
    new Set(config.bindings.map((binding) => binding.operation.id)).size,
    config.bindings.length,
    '测试配置的别名必须唯一，不能用重复ID遮蔽失败原因',
  );
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return config;
}
