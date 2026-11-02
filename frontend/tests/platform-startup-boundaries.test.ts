import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { checkPlatformStartupBoundaries } from '../scripts/platform-startup-boundaries.ts';

async function fixture(context: TestContext, files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'deviceforge-startup-boundaries-'));
  context.after(async () => {
    const path = relative(resolve(tmpdir()), resolve(root));
    assert.ok(path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
    await rm(root, { recursive: true, force: true });
  });
  for (const [name, text] of Object.entries(files)) {
    const target = join(root, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  }
  return root;
}

test('启动边界只跟随平台静态运行时依赖，type-only缺失目标不读取或执行', async (context) => {
  const root = await fixture(context, {
    'src/app/main.ts': [
      'throw new Error("检查器不得执行启动代码");',
      'import type { Hidden } from "../pages/not-present.ts";',
      'import { type Other } from "../features/automation/not-present.ts";',
      'export type * from "../features/settings/not-present.ts";',
      'export { type Third } from "../pages/not-present-again.ts";',
      'import type Alias = require("../pages/not-present-require.ts");',
      'export { platform } from "./product/platform-services.js";',
    ].join('\n'),
    'src/app/product/platform-services.ts': 'export { platform } from "../platform-runtime.ts";',
    'src/app/platform-runtime.ts': 'export const platform = 1;',
  });
  const result = await checkPlatformStartupBoundaries({ frontendRoot: root });
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.files, ['src/app/main.ts', 'src/app/platform-runtime.ts', 'src/app/product/platform-services.ts']);
});

test('启动边界经再导出和循环仍定位业务违规的文件行号与完整静态链', async (context) => {
  const root = await fixture(context, {
    'src/app/main.ts': 'import "./platform.ts";',
    'src/app/platform.ts': 'export * from "./bridge.ts";',
    'src/app/bridge.ts': 'export * from "./platform.ts";\nexport * from "../pages/tool.ts";',
    'src/pages/tool.ts': 'throw new Error("被禁业务源码不得执行");',
  });
  const result = await checkPlatformStartupBoundaries({ frontendRoot: root });
  assert.deepEqual(result.files, ['src/app/bridge.ts', 'src/app/main.ts', 'src/app/platform.ts']);
  assert.equal(result.violations.length, 1);
  const violation = result.violations[0];
  assert.ok(violation);
  assert.equal(violation.code, 'forbidden-runtime-dependency');
  assert.equal(violation.file, 'src/app/bridge.ts');
  assert.equal(violation.line, 2);
  assert.equal(violation.specifier, '../pages/tool.ts');
  assert.equal(violation.target, 'src/pages/tool.ts');
  assert.deepEqual(violation.chain, ['src/app/main.ts', 'src/app/platform.ts', 'src/app/bridge.ts', 'src/pages/tool.ts']);
});

test('启动边界不跟随lazy或裸依赖，保留纯平台feature和mirroring-streaming', async (context) => {
  const root = await fixture(context, {
    'src/app/main.ts': [
      'import "public-package-not-installed";',
      'import "../features/device-target/index.ts";',
      'import "../features/mirroring-streaming/index.ts";',
      'export const loadBusiness = () => import("../pages/not-present.ts");',
      'export const loadUnknown = (path: string) => import(path);',
      'export type Deferred = import("../features/frida/not-present.ts").Deferred;',
    ].join('\n'),
    'src/features/device-target/index.ts': 'export const platform = true;',
    'src/features/mirroring-streaming/index.ts': 'throw new Error("投屏源码不得被检查器执行");',
  });
  const result = await checkPlatformStartupBoundaries({ frontendRoot: root });
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.files, ['src/app/main.ts', 'src/features/device-target/index.ts', 'src/features/mirroring-streaming/index.ts']);
});

test('启动边界无法解析本地静态import或再导出时明确失败而不是视为通过', async (context) => {
  const root = await fixture(context, {
    'src/app/main.ts': 'import "./missing.ts";\nexport * from "./missing-export.js";',
  });
  const result = await checkPlatformStartupBoundaries({ frontendRoot: root });
  assert.deepEqual(result.files, ['src/app/main.ts']);
  assert.deepEqual(result.violations.map(({ code, file, line, specifier, target, chain }) =>
    ({ code, file, line, specifier, target, chain })), [
    { code: 'unresolved-local-import', file: 'src/app/main.ts', line: 1, specifier: './missing.ts',
      target: 'src/app/missing.ts', chain: ['src/app/main.ts', 'src/app/missing.ts'] },
    { code: 'unresolved-local-import', file: 'src/app/main.ts', line: 2, specifier: './missing-export.js',
      target: 'src/app/missing-export.js', chain: ['src/app/main.ts', 'src/app/missing-export.js'] },
  ]);
});

test('启动边界禁止业务页旧product与runtime兼容入口以及指定旧业务features', async (context) => {
  const features = ['ai-assistant', 'ai-sdk', 'ai-sdk-streaming', 'ai-streaming', 'performance', 'frida',
    'automation', 'settings', 'package-analysis', 'dex-analysis', 'msgpack', 'interactive-sessions',
    'artifact-browser', 'tool-supply'];
  const targets = ['src/pages/example/index.tsx', 'src/app/product/services.ts', 'src/app/product/legacy-services.ts',
    'src/app/product/legacy-business.ts', 'src/app/product/App.tsx', 'src/app/product/legacy-pages/index.ts',
    'src/app/product/advanced.ts', 'src/app/runtime.ts', 'src/app/composition/legacy-runtime.ts',
    'src/app/composition/legacy-runtime-business.ts', ...features.map((name) => `src/features/${name}/index.ts`)];
  const files: Record<string, string> = {
    'src/app/main.ts': targets.map((target) => `import "../${target.slice('src/'.length)}";`).join('\n'),
  };
  for (const target of targets) files[target] = 'export const value = true;';
  const root = await fixture(context, files);
  const result = await checkPlatformStartupBoundaries({ frontendRoot: root });
  assert.deepEqual(result.files, ['src/app/main.ts']);
  assert.equal(result.violations.length, targets.length);
  assert.ok(result.violations.every((violation) => violation.code === 'forbidden-runtime-dependency'));
  assert.deepEqual(result.violations.map((violation) => violation.target), targets);
});

test('启动边界保留混合导入默认导入空绑定及import-equals的运行时边', async (context) => {
  const root = await fixture(context, {
    'src/app/main.ts': [
      'import { type Hidden, visible } from "../features/automation/index.ts";',
      'export { type Hidden, visible } from "../features/settings/index.ts";',
      'import value = require("../features/msgpack/index.ts");',
      'import Default, { type Hidden } from "../features/frida/index.ts";',
      'import {} from "../features/performance/index.ts";',
      'export {} from "../features/ai-sdk/index.ts";',
    ].join('\n'),
    'src/features/automation/index.ts': 'export const visible = 1;',
    'src/features/settings/index.ts': 'export const visible = 1;',
    'src/features/msgpack/index.ts': 'export const value = 1;',
    'src/features/frida/index.ts': 'export default 1;',
    'src/features/performance/index.ts': 'export {};',
    'src/features/ai-sdk/index.ts': 'export {};',
  });
  const result = await checkPlatformStartupBoundaries({ frontendRoot: root });
  assert.equal(result.violations.length, 6);
  assert.ok(result.violations.every((violation) => violation.code === 'forbidden-runtime-dependency'));
  assert.deepEqual(result.violations.map((violation) => violation.line), [1, 2, 3, 4, 5, 6]);
});

test('启动边界将样式和JSON作为可读资源叶节点，不把内容当TypeScript执行', async (context) => {
  const root = await fixture(context, {
    'src/app/main.ts': 'import "./styles.css";\nimport schema from "./schema.json";',
    'src/app/styles.css': '@theme { --color-platform: #fff; }',
    'src/app/schema.json': '{"platform":true}',
  });
  const result = await checkPlatformStartupBoundaries({ frontendRoot: root });
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.files, ['src/app/main.ts', 'src/app/schema.json', 'src/app/styles.css']);
});

test('启动边界拒绝无法读取的入口与存在语法错误的源码', async (context) => {
  const root = await fixture(context, {
    'src/app/main.ts': 'import { broken from "./platform.ts";',
    'src/app/platform.ts': 'export const platform = true;',
  });
  const missing = await checkPlatformStartupBoundaries({ frontendRoot: root, entry: 'src/app/not-present.ts' });
  assert.deepEqual(missing.files, []);
  assert.equal(missing.violations[0]?.code, 'unreadable-source');
  const invalid = await checkPlatformStartupBoundaries({ frontendRoot: root });
  assert.ok(invalid.violations.some((violation) => violation.code === 'invalid-source' && violation.file === 'src/app/main.ts'));
});

test('启动边界不能把仅有声明的本地运行时依赖当成可执行实现', async (context) => {
  const root = await fixture(context, {
    'src/app/main.ts': 'import "./types.d.ts";',
    'src/app/types.d.ts': 'export interface Platform {}',
  });
  const result = await checkPlatformStartupBoundaries({ frontendRoot: root });
  assert.equal(result.violations[0]?.code, 'invalid-source');
  assert.equal(result.violations[0]?.file, 'src/app/types.d.ts');
});
