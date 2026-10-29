import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { checkPluginBoundaries } from '../scripts/plugin-boundaries.ts';

async function fixture(run: (root: string, put: (file: string, content: string) => Promise<void>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'deviceforge-plugin-boundaries-'));
  const put = async (file: string, content: string) => {
    const target = join(root, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  };
  try {
    await put('src/app/private.ts', 'export const secret = 1;');
    await put('src/features/private/index.ts', 'export const secret = 1;');
    await put('plugins/example/package.json', '{"name":"example","type":"module"}');
    await run(root, put);
  } finally {
    const target = resolve(root);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep));
    await rm(target, { recursive: true, force: true });
  }
}

test('实际扫描插件生产源码，允许工程内依赖和公开发行说明符', async () => {
  await fixture(async (root, put) => {
    await put('plugins/example/src/helper.ts', 'export const value = 1;');
    await put('plugins/example/src/index.ts',
      'import { value } from "./helper.ts"; import { mountReact } from "deviceforge-host"; export { value, mountReact };');
    assert.deepEqual(await checkPluginBoundaries(root), []);
    await put('plugins/example/src/hidden/deep.ts', 'export { secret } from "../../../../src/app/private.ts";');
    assert.match((await checkPluginBoundaries(root)).join('\n'), /deep.ts:1:.*宿主私有/);
  });
});

test('静态、动态、类型和重导出均不能绕过宿主边界', async () => {
  await fixture(async (root, put) => {
    const invalid = [
      'import { secret } from "../../../src/app/private.ts";',
      'export { secret } from "../../../src/features/private/index.ts";',
      'const load = () => import("../../../src/app/private.ts");',
      'type T = import("../../../src/app/private.ts");',
      'const load = (path: string) => import(path);',
      'const load = require("../../../src/app/private.ts");',
      'import legacy = require("../../../src/app/private.ts");',
      'const load = createRequire(import.meta.url); load("../../../src/app/private.ts");',
    ];
    for (const source of invalid) {
      await put('plugins/example/index.ts', source);
      assert.notDeepEqual(await checkPluginBoundaries(root), [], source);
    }
    await put('plugins/example/index.ts', 'const text = "import(宿主)"; // require("../src/app")\nexport { text };');
    assert.deepEqual(await checkPluginBoundaries(root), []);
  });
});

test('拒绝宿主别名、绝对路径和跨插件源码引用', async () => {
  await fixture(async (root, put) => {
    const invalid = [
      'export * from "@/app/private";',
      'export * from "/src/app/private.ts";',
      'export * from "file:///G:/Rust/DeviceForge/frontend/src/app/private.ts";',
      'export * from "../another/src/index.ts";',
      `export * from ${JSON.stringify('C:\\private\\source.ts')};`,
    ];
    for (const source of invalid) {
      await put('plugins/example/index.ts', source);
      assert.notDeepEqual(await checkPluginBoundaries(root), [], source);
    }
  });
});

test('tsconfig paths 未使用也不能映射到宿主或其他插件源码', async () => {
  await fixture(async (root, put) => {
    await put('plugins/example/index.ts', 'export const value = 1;');
    await put('plugins/example/tsconfig.json', JSON.stringify({ compilerOptions: {
      baseUrl: '.', paths: { '@host/*': ['../../src/*'] },
    } }));
    assert.match((await checkPluginBoundaries(root)).join('\n'), /paths.*宿主私有/);
    await put('plugins/example/tsconfig.json', JSON.stringify({ compilerOptions: {
      baseUrl: '.', paths: { '@other/*': ['../another/src/*'] },
    } }));
    assert.match((await checkPluginBoundaries(root)).join('\n'), /paths.*工程边界/);
    await put('plugins/example/tsconfig.json', JSON.stringify({ compilerOptions: {
      baseUrl: '.', paths: { '@local/*': ['src/*'] },
    } }));
    await put('plugins/example/src/helper.ts', 'export const value = 1;');
    await put('plugins/example/index.ts', 'export { value } from "@local/helper";');
    assert.deepEqual(await checkPluginBoundaries(root), []);
  });
});

test('继承配置的别名和三斜线引用不能藏住宿主依赖', async () => {
  await fixture(async (root, put) => {
    await put('plugins/example/config/base.json', JSON.stringify({ compilerOptions: {
      baseUrl: '..', paths: { '@host/*': ['../../src/*'] },
    } }));
    await put('plugins/example/tsconfig.json', '{"extends":"./config/base.json"}');
    await put('plugins/example/index.ts', 'export const value = 1;');
    assert.match((await checkPluginBoundaries(root)).join('\n'), /paths.*宿主私有/);
    await put('plugins/example/tsconfig.json', '{}');
    await put('plugins/example/index.ts', '/// <reference path="../../src/app/private.ts" />\nexport const value = 1;');
    assert.match((await checkPluginBoundaries(root)).join('\n'), /宿主私有/);
  });
});

test('无 baseUrl 的继承 paths 按声明配置位置解析，通配符后越界同样拒绝', async () => {
  await fixture(async (root, put) => {
    await put('plugins/example/index.ts', 'export const value = 1;');
    await put('plugins/example/config/base.json', JSON.stringify({ compilerOptions: {
      paths: { '@host/*': ['../../../src/*'] },
    } }));
    await put('plugins/example/tsconfig.json', '{"extends":"./config/base.json"}');
    assert.match((await checkPluginBoundaries(root)).join('\n'), /paths.*宿主私有/);
    await put('plugins/example/tsconfig.json', JSON.stringify({ compilerOptions: {
      paths: { '@host/*': ['./*/../../../src/app/private.ts'] },
    } }));
    assert.match((await checkPluginBoundaries(root)).join('\n'), /paths.*宿主私有/);
  });
});

test('编译产物和依赖目录不冒充生产源码，嵌套生产目录仍受检查', async () => {
  await fixture(async (root, put) => {
    await put('plugins/example/src/index.ts', 'export const value = 1;');
    await put('plugins/example/dist/index.js', 'require("../../../../src/app/private.ts");');
    await put('plugins/example/node_modules/dependency/index.js', 'require("../../../../../src/app/private.ts");');
    assert.deepEqual(await checkPluginBoundaries(root), []);
    await put('plugins/example/components/detail.tsx', 'import("../../../src/app/private.ts");');
    assert.notDeepEqual(await checkPluginBoundaries(root), []);
  });
});
