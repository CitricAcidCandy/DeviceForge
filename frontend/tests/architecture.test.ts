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
test('TSX 事件与泛型组件使用同一导入、网络和类型门禁', () => {
  const result = inspectSource('import type { X } from "../x"; export * from "../shared/a"; const load = () => import("../features/b"); type T = import("../types").T; const View = <T,>(value: T) => <button onClick={() => globalThis.fetch("/")}>{String(value)}</button>; let unchecked: any;', 'View.tsx');
  assert.deepEqual(result.dependencies.map((entry) => entry.value), ['../x', '../shared/a', '../features/b', '../types']);
  assert.ok(result.issues.some((issue) => issue.includes('any')));
  assert.ok(result.issues.includes('network'));
  const safe = inspectSource('const text = "fetch() any"; export const View = () => <button title={text}>{/* fetch() any */}安全</button>;', 'Safe.tsx');
  assert.deepEqual(safe.issues, []);
  assert.match(inspectSource('export const View = () => <button onClick={() => import(variable)}>加载</button>;', 'Dynamic.tsx').issues.join(), /字面量/);
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
test('实际 TSX 文件解析组件与目录入口，并拒绝跨层、网络及 any 绕过', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deviceforge-architecture-tsx-'));
  try {
    await mkdir(join(directory, 'src/app'), { recursive: true });
    await mkdir(join(directory, 'src/shared/ui/controls'), { recursive: true });
    await writeFile(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx', baseUrl: '.', paths: { '@app/*': ['src/app/*'] } } }));
    await writeFile(join(directory, 'src/shared/ui/Panel.tsx'), 'export const Panel = () => <section>面板</section>;');
    await writeFile(join(directory, 'src/shared/ui/controls/index.tsx'), 'export const Control = () => <button>操作</button>;');
    await writeFile(join(directory, 'src/app/View.tsx'), 'import { Panel } from "../shared/ui/Panel"; import { Control } from "../shared/ui/controls"; export const View = () => <Panel><Control /></Panel>;');
    await checkArchitecture(directory);
    await writeFile(join(directory, 'src/shared/ui/Panel.tsx'), 'export { View } from "@app/View";');
    await assert.rejects(checkArchitecture(directory), /禁止依赖 app\/View.tsx/);
    await writeFile(join(directory, 'src/shared/ui/Panel.tsx'), 'export const Panel = () => <section onClick={() => globalThis.fetch("/")}>面板</section>;');
    await assert.rejects(checkArchitecture(directory), /网络调用只能位于 shared\/api 适配器/);
    await writeFile(join(directory, 'src/shared/ui/Panel.tsx'), 'const unchecked: any = null; export const Panel = () => <section>{unchecked}</section>;');
    await assert.rejects(checkArchitecture(directory), /不得使用 any 绕过类型边界/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
