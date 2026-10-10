import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { allowedDependency, findCycles } from '../scripts/architecture-policy.ts';
import { inspectSource } from '../scripts/source-dependencies.ts';
import { checkArchitecture } from '../scripts/check-architecture.ts';

test('功能、SDK、展示层与宿主的反向依赖被拒绝', () => {
  const rejected: readonly (readonly [string, string])[] = [['features/devices/a.ts','features/tasks/b.ts'],['plugin-sdk/index.ts','shared/api/generated.ts'],['shared/ui/a.ts','shared/api/client.ts'],['plugins/a.ts','app/main.ts']];
  for (const [from, to] of rejected) assert.equal(allowedDependency(from, to), false);
  assert.equal(allowedDependency('features/devices/a.ts','shared/api/client.ts'), true);
  assert.equal(allowedDependency('plugins/a.ts','plugin-sdk/index.ts'), true);
  assert.equal(allowedDependency('features/plugin-packages/index.ts','features/server-plugins/index.ts'), false);
  assert.equal(allowedDependency('features/tasks/index.ts','plugins/extensions/registry.ts'), false);
  assert.equal(allowedDependency('plugins/extensions/registry.ts','shared/api/client.ts'), false);
  assert.equal(allowedDependency('app/runtime.ts','features/tasks/index.ts'), true);
});
test('解析器识别重导出、动态导入和类型引用，并忽略注释与字符串', () => {
  const result = inspectSource('export * from "../app/a"; const value = import("../shared/a"); type T = import("../features/b").T; // fetch() any\nconst text = "fetch() any";', 'sample.ts');
  assert.deepEqual(result.dependencies.map((entry) => entry.value), ['../app/a','../shared/a','../features/b']);
  assert.deepEqual(result.issues, []);
  assert.match(inspectSource('import(variable); const x: any = globalThis.fetch("/");', 'sample.ts').issues.join(), /字面量.*any.*network/);
});
test('Svelte 模板与脚本使用同一网络和类型门禁', () => {
  const result = inspectSource('<script lang="ts">import type {X} from "../x"; let value: any;</script><button onclick={() => fetch("/")}>点击</button>', 'App.svelte');
  assert.equal(result.dependencies[0]?.value, '../x');
  assert.ok(result.issues.some((issue) => issue.includes('any')));
  assert.ok(result.issues.includes('network'));
});
test('循环检测包含重导出和类型依赖', () => {
  assert.equal(findCycles(new Map([['a',['b']],['b',['c']],['c',['a']]])).length, 1);
  assert.deepEqual(findCycles(new Map([['a',['b']],['b',[]]])), []);
});
test('实际文件门禁拒绝跨层导入及路径别名绕过', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deviceforge-architecture-'));
  try {
    await mkdir(join(directory,'src/app'), { recursive: true });
    await mkdir(join(directory,'src/shared/ui'), { recursive: true });
    await writeFile(join(directory,'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/app/*'] } } }));
    await writeFile(join(directory,'src/app/a.ts'), 'export const value = 1;');
    await writeFile(join(directory,'src/shared/ui/b.ts'), 'export {value} from "@app/a";');
    await assert.rejects(checkArchitecture(directory), /禁止依赖 app\/a.ts/);
    await writeFile(join(directory,'src/shared/ui/b.ts'), 'export const value = "安全展示";');
    await checkArchitecture(directory);
    await mkdir(join(directory, 'scripts'));
    await writeFile(join(directory, 'scripts/untyped.mjs'), 'export const value = 1;');
    await assert.rejects(checkArchitecture(directory), /维护脚本与测试必须使用 TypeScript/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
