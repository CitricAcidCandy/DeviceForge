import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// 复用前端已安装的同版验证器，不为分发入口增加运行依赖。
const require = createRequire(new URL('../../../frontend/package.json', import.meta.url));
const Ajv = require('ajv');
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const root = fileURLToPath(new URL('../', import.meta.url));
const ids = [
  'ai-assistant',
  'ai-sdk',
  'android-device',
  'android-packages',
  'artifact-copy',
  'automation',
  'cooperative-demo',
  'dex-analysis',
  'echo',
  'frida',
  'harmony-device',
  'marketplace',
  'mirroring',
  'msgpack',
  'performance-demo',
  'settings',
  'terminal',
  'tool-supply',
];
const definitions = new Map();
for (const id of ids) {
  const directory = join(root, id);
  const names = await readdir(directory);
  const manifests = names.filter((name) =>
    ['manifest.json', 'manifest.example.json'].includes(name),
  );
  for (const name of manifests) {
    const manifest = JSON.parse(await readFile(join(directory, name), 'utf8'));
    if (definitions.has(id))
      assert.deepEqual(manifest.configuration, definitions.get(id), `${id} 正式和示例声明须一致`);
    definitions.set(id, manifest.configuration);
  }
}

test('18 插件 schema 可编译且默认值和公开配置模板有效', async () => {
  for (const [id, definition] of definitions) {
    const validate = ajv.compile(definition.schema);
    assert.equal(
      validate(definition.defaults),
      true,
      `${id} 默认配置：${JSON.stringify(validate.errors)}`,
    );
    const directory = join(root, id);
    for (const name of (await readdir(directory)).filter(
      (name) => name.includes('.config.') && name.endsWith('.example.json'),
    )) {
      const value = JSON.parse(await readFile(join(directory, name), 'utf8'));
      assert.equal(validate(value), true, `${id}/${name}：${JSON.stringify(validate.errors)}`);
    }
  }
});

test('所有插件拒绝未知配置项且只有真实消费的字段可写', () => {
  for (const [id, definition] of definitions) {
    const validate = ajv.compile(definition.schema);
    assert.equal(validate({ ...definition.defaults, invented: true }), false, id);
  }
  const android = definitions.get('android-device');
  const validate = ajv.compile(android.schema);
  assert.equal(validate({ ...android.defaults, profile: { root_access: 'invented' } }), false);
  assert.equal(
    validate({
      ...android.defaults,
      unicode_input: { package: 'other', component: 'other', action: 'other', extra: 'other' },
    }),
    false,
  );
});

test('AI 固定资格、终端结构化方案、工具来源互斥和文件密码引用保持约束', () => {
  const sdk = definitions.get('ai-sdk');
  const validateSdk = ajv.compile(sdk.schema);
  assert.equal(validateSdk({ ...sdk.defaults, sdk_version: '0.0.0' }), false);
  assert.equal(
    validateSdk({
      ...sdk.defaults,
      thread_options: { webSearchMode: 'live', webSearchEnabled: true },
    }),
    false,
  );
  assert.equal(
    validateSdk({ ...sdk.defaults, thread_options: { workingDirectory: 'C:/other' } }),
    false,
  );
  assert.equal(validateSdk({ ...sdk.defaults, environment: { APK_API_TOKEN: '不能透传' } }), false);
  for (const key of ['profile', 'node_version', 'sdk_version', 'cli_version'])
    assert.equal(sdk.schema.properties[key].readOnly, true);
  const terminal = definitions.get('terminal');
  assert.equal(ajv.compile(terminal.schema)({ ...terminal.defaults, profiles: {} }), false);
  assert.equal(
    ajv.compile(terminal.schema)({
      ...terminal.defaults,
      profiles: { other: { executable: 'python', args: [], resource_scope: 'arbitrary' } },
    }),
    false,
  );
  const supply = definitions.get('tool-supply');
  assert.equal(
    ajv.compile(supply.schema)({
      ...supply.defaults,
      manifest_url: 'https://example.com/catalog.json',
    }),
    false,
  );
  assert.equal(
    ajv.compile(supply.schema)({ ...supply.defaults, download_limit_bytes: 2147483649 }),
    false,
  );
  const packages = definitions.get('android-packages');
  assert.equal(
    ajv.compile(packages.schema)({
      ...packages.defaults,
      signing: { password: '不可保存明文密码' },
    }),
    false,
  );
  assert.equal(packages.schema.properties.signing.properties.store_password_file.type, 'string');
});

test('动态环境变量和远端请求头标记为敏感，目录变更说明明确', () => {
  for (const id of ['ai-assistant', 'ai-sdk']) {
    const values = definitions.get(id).schema.properties.environment.additionalProperties;
    assert.equal(values.writeOnly, true);
    assert.equal(values.format, 'password');
  }
  const settings = definitions.get('settings').schema.properties;
  assert.equal(settings.remote.properties.headers.additionalProperties.writeOnly, true);
  assert.match(settings.storage_root.description, /不自动迁移/);
});
