import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { archive, control, fixture } from '../device-provider/fixtures.mjs';

export const names = {
  device: 'android.app.stop',
  provider: 'legacy.provider',
  ordinary: 'legacy.echo',
  missing: 'harmony.packages',
  bad: 'legacy.bad',
  result: 'legacy.bad_result',
};

// 模拟贡献仅证明通用绑定；使用旧 ID 不表示 Android 平台命令已迁出。
export async function inputs(directory) {
  const first = await fixture('alias_smoke_device', join(directory, 'markers'), {
    apiVersion: 2,
    executionTimeoutMs: 120000,
  });
  const bad = await fixture('alias_smoke_bad', join(directory, 'markers'));
  const ordinary = {
    id: 'alias_smoke_plain',
    directory: join(directory, 'markers', 'alias_smoke_plain'),
  };
  await mkdir(ordinary.directory, { recursive: true });
  ordinary.manifest = {
    id: ordinary.id,
    version: '1.0.0',
    protocol_version: 3,
    args: [],
    operations: [{ name: 'echo', title: '普通模拟贡献', input_schema: { type: 'object' } }],
  };
  const descriptor = {
    name: 'deviceforge-alias-smoke-plain',
    version: '1.0.0',
    type: 'module',
    deviceforge: {
      kind: 'server',
      manifest: 'plugin.json',
      entrypoints: { any: { runtime: 'node', path: 'dist/index.mjs' } },
    },
  };
  const source = await readFile(
    new URL('../device-provider/node-provider.mjs', import.meta.url),
    'utf8',
  );
  ordinary.archive = archive([
    ['package.json', JSON.stringify(descriptor)],
    ['plugin.json', JSON.stringify(ordinary.manifest)],
    ['dist/index.mjs', source],
    ['dist/fixture.json', JSON.stringify(ordinary)],
  ]);
  await control(ordinary, 'valid', 'plain-initial');
  const artifacts = [];
  for (const protocol of [2, 3]) {
    const item = {
      id: `alias_smoke_artifact_${protocol}`,
      directory: join(directory, 'markers', `artifact_${protocol}`),
      protocol,
    };
    await mkdir(item.directory, { recursive: true });
    const manifest = {
      id: item.id,
      version: '1.0.0',
      protocol_version: protocol,
      args: [],
      artifacts: { input_fields: [], outputs: true },
      operations: [{ name: 'emit', title: '真实发布产物', input_schema: { type: 'object' } }],
    };
    const description = { ...descriptor, name: `deviceforge-alias-smoke-artifact-${protocol}` };
    const artifactSource = await readFile(
      new URL('./artifact-provider.mjs', import.meta.url),
      'utf8',
    );
    item.archive = archive([
      ['package.json', JSON.stringify(description)],
      ['plugin.json', JSON.stringify(manifest)],
      ['dist/index.mjs', artifactSource],
      ['dist/fixture.json', JSON.stringify(item)],
    ]);
    artifacts.push(item);
  }
  const capability = (plugin_id, capability_) => ({
    kind: 'device_capability',
    plugin_id,
    capability: capability_,
    version: 1,
  });
  const value = { kind: 'value', wrapped: true };
  const bind = (id, target, input, result) => ({
    operation: { id, title: '真实服务模拟绑定', input_schema: { type: 'object' } },
    target,
    input,
    result,
  });
  const config = {
    format_version: 1,
    bindings: [
      bind(names.device, capability(first.id, 'device_write'), 'device_envelope', value),
      bind(names.provider, capability(first.id, 'provider_read'), 'device_envelope', {
        kind: 'object',
        wrapped: true,
        fields: [
          { name: 'label', source: { kind: 'input', pointer: '/label' } },
          { name: 'provider_id', source: { kind: 'value', pointer: '/provider_id' } },
          { name: 'device_id', source: { kind: 'value', pointer: '/device_id' } },
          { name: 'absent', source: { kind: 'value', pointer: '/absent' }, optional: true },
        ],
      }),
      bind(
        names.ordinary,
        { kind: 'operation', plugin_id: ordinary.id, operation: `plugin.${ordinary.id}.echo` },
        'identity',
        value,
      ),
      bind(
        names.missing,
        capability('not_installed_alias_provider', 'device_write'),
        'device_envelope',
        value,
      ),
      bind(
        names.bad,
        { kind: 'operation', plugin_id: bad.id, operation: `plugin.${bad.id}.discover` },
        'identity',
        value,
      ),
      bind(names.result, capability(first.id, 'device_read'), 'device_envelope', {
        kind: 'object',
        wrapped: true,
        fields: [{ name: 'required', source: { kind: 'value', pointer: '/absent' } }],
      }),
      ...artifacts.map((item) =>
        bind(
          `legacy.artifact_${item.protocol}`,
          { kind: 'operation', plugin_id: item.id, operation: `plugin.${item.id}.emit` },
          'identity',
          { kind: 'artifact', filename: 'result.json' },
        ),
      ),
    ],
  };
  const path = join(directory, 'operation-bindings.json');
  await writeFile(path, `${JSON.stringify(config)}\n`, 'utf8');
  return { first, bad, ordinary, artifacts, config, path };
}
