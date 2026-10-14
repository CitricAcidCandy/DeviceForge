import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { allowedDependency, findCycles, sourcePlacementIssue } from '../scripts/architecture-policy.ts';
import { inspectSource } from '../scripts/source-dependencies.ts';
import { checkArchitecture } from '../scripts/check-architecture.ts';

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

test('公共组件统一按PascalCase入口组织，组件私有实现不反向读取汇总或业务', () => {
  const rejected: readonly (readonly [string, string])[] = [
    ['components/Button/index.tsx', 'components/index.ts'],
    ['components/Button/index.tsx', 'components/Panel/types.ts'],
    ['components/Widget/index.tsx', 'services/api/client.ts'],
    ['components/Widget/index.tsx', 'features/tasks/index.ts'],
    ['components/Widget/index.tsx', 'app/runtime.ts'],
    ['components/Widget/index.tsx', 'plugin-sdk/index.ts'],
    ['utils/classnames.ts', 'components/Button/index.tsx'],
    ['utils/classnames.ts', 'services/api/client.ts'],
    ['plugins/example.ts', 'app/runtime.ts'],
  ];
  for (const [from, to] of rejected) assert.equal(allowedDependency(from, to), false, from + ' 不应依赖 ' + to);
  const accepted: readonly (readonly [string, string])[] = [
    ['components/Button/index.tsx', 'utils/classnames.ts'],
    ['components/Panel/index.tsx', 'components/Button/index.tsx'],
    ['components/Widget/index.tsx', 'components/Widget/hooks.ts'],
    ['components/index.ts', 'components/Widget/index.tsx'],
    ['app/product/shell.tsx', 'components/index.ts'],
    ['app/product/shell.tsx', 'components/Button/index.tsx'],
    ['plugins/example.ts', 'plugin-sdk/index.ts'],
  ];
  for (const [from, to] of accepted) assert.equal(allowedDependency(from, to), true, from + ' 应可依赖 ' + to);
});

test('功能按models服务与纯工具分工，只有公开展示入口可由app读取', () => {
  const rejected: readonly (readonly [string, string])[] = [
    ['features/tasks/utils/rules.ts', 'features/tasks/models/controller.ts'],
    ['features/tasks/types/task.ts', 'features/tasks/services/gateway.ts'],
    ['features/tasks/services/gateway.ts', 'features/tasks/models/controller.ts'],
    ['features/tasks/services/gateway.ts', 'features/tasks/components/TaskView/index.tsx'],
    ['features/tasks/models/controller.ts', 'features/tasks/components/TaskView/index.tsx'],
    ['features/tasks/components/TaskView/index.tsx', 'features/tasks/services/gateway.ts'],
    ['features/tasks/index.ts', 'features/tasks/components/index.ts'],
    ['features/tasks/models/controller.ts', 'features/devices/index.ts'],
    ['app/runtime.ts', 'features/tasks/models/controller.ts'],
    ['app/runtime.ts', 'features/tasks/components/TaskView/index.tsx'],
    ['features/tasks/models/controller.ts', 'components/Button/index.tsx'],
  ];
  for (const [from, to] of rejected) assert.equal(allowedDependency(from, to), false);
  const accepted: readonly (readonly [string, string])[] = [
    ['features/tasks/models/controller.ts', 'features/tasks/services/gateway.ts'],
    ['features/tasks/services/gateway.ts', 'features/tasks/utils/rules.ts'],
    ['features/tasks/utils/rules.ts', 'features/tasks/types/task.ts'],
    ['features/tasks/components/TaskView/index.tsx', 'features/tasks/models/controller.ts'],
    ['features/tasks/components/TaskView/index.tsx', 'components/Button/index.tsx'],
    ['app/runtime.ts', 'features/tasks/index.ts'],
    ['app/runtime.ts', 'features/tasks/components/index.ts'],
    ['tests/tasks.test.ts', 'features/tasks/models/controller.ts'],
  ];
  for (const [from, to] of accepted) assert.equal(allowedDependency(from, to), true);
});

test('源码位置拒绝已覆盖的DDD和组件分类目录，不要求空骨架', () => {
  for (const file of ['features/tasks/controller.ts', 'features/tasks/domain/model.ts', 'features/tasks/application/controller.ts',
    'features/tasks/ui/view.tsx', 'components/ui/button.tsx', 'components/common/result.tsx', 'components/integrations/widget.tsx']) {
    assert.ok(sourcePlacementIssue(file), file + ' 应迁出旧结构');
  }
  for (const file of ['features/tasks/index.ts', 'features/tasks/models/controller.ts', 'features/tasks/utils/rules.ts',
    'features/tasks/components/index.ts', 'features/tasks/components/TaskView/index.tsx', 'components/Button/index.tsx',
    'components/Button/types.ts', 'components/index.ts', 'utils/classnames.ts']) assert.equal(sourcePlacementIssue(file), null);
});

test('实际组件入口拒绝别名业务导入、网络和any绕过，维护脚本仍严格使用TS', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deviceforge-architecture-react-'));
  const put = async (file: string, content: string) => { const target = join(directory, file); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, content); };
  try {
    await put('tsconfig.json', JSON.stringify({ compilerOptions: { jsx: 'react-jsx', baseUrl: '.', paths: { '@app/*': ['src/app/*'] } } }));
    await put('src/app/main.ts', 'export const value = 1;');
    await put('src/components/Panel/index.tsx', 'export const Panel = () => <section>面板</section>;');
    await checkArchitecture(directory);
    await put('src/components/Panel/index.tsx', 'export { value } from "@app/main";');
    await assert.rejects(checkArchitecture(directory), /禁止依赖 app\/main.ts/);
    await put('src/components/Panel/index.tsx', 'export const Panel = () => <section onClick={() => globalThis.fetch("/")}>面板</section>;');
    await assert.rejects(checkArchitecture(directory), /网络调用只能位于 shared\/api 适配器/);
    await put('src/components/Panel/index.tsx', 'const unchecked: any = null; export const Panel = () => <section>{unchecked}</section>;');
    await assert.rejects(checkArchitecture(directory), /不得使用 any 绕过类型边界/);
    await put('src/components/Panel/index.tsx', 'export const Panel = () => <section>面板</section>;');
    await put('scripts/untyped.mjs', 'export const value = 1;');
    await assert.rejects(checkArchitecture(directory), /维护脚本与测试必须使用 TypeScript/);
  } finally {
    const resolved = resolve(directory); assert.ok(resolved.startsWith(resolve(tmpdir()) + sep));
    await rm(resolved, { recursive: true, force: true });
  }
});

test('实际React目录接受第三方同级包装与双入口，拒绝UI泄露和依赖反转', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deviceforge-architecture-scaffold-'));
  const put = async (file: string, content: string) => { const target = join(directory, file); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, content); };
  try {
    await put('tsconfig.json', JSON.stringify({ compilerOptions: { jsx: 'react-jsx', module: 'esnext', moduleResolution: 'bundler', baseUrl: '.', paths: { '@tasks/*': ['src/features/tasks/*'] } } }));
    await put('src/features/tasks/README.md', '# 任务功能');
    await put('src/features/tasks/types/task.ts', 'export interface Task { readonly id: string }');
    await put('src/features/tasks/utils/rules.ts', 'export const value = 1;');
    await put('src/features/tasks/services/gateway.ts', 'export { value } from "../utils/rules.ts";');
    await put('src/features/tasks/models/controller.ts', 'export { value } from "../services/gateway.ts";');
    await put('src/features/tasks/index.ts', 'export type { Task } from "./types/task.ts";');
    await put('src/utils/classnames.ts', 'export const identity = <T,>(value: T) => value;');
    await put('src/components/Button/index.tsx', 'import { identity } from "../../utils/classnames.ts"; export const Button = () => <button>{identity("操作")}</button>;');
    await put('node_modules/example-widget/package.json', JSON.stringify({ name: 'example-widget', types: 'index.d.ts' }));
    await put('node_modules/example-widget/index.d.ts', 'export interface WidgetProps { readonly title: string }');
    await put('src/components/Widget/index.tsx', 'import type { WidgetProps } from "example-widget"; import { Button } from "../Button/index.tsx"; export const Widget = (props: WidgetProps) => <section title={props.title}><Button /></section>;');
    await put('src/components/index.ts', 'export { Widget } from "./Widget/index.tsx";');
    await put('src/features/tasks/components/TaskView/index.tsx', 'import { value } from "../../models/controller.ts"; import { Widget } from "../../../../components/Widget/index.tsx"; export const TaskView = () => <Widget title={String(value)} />;');
    await put('src/features/tasks/components/index.ts', 'export { TaskView } from "./TaskView/index.tsx";');
    await put('src/app/main.ts', 'export type { Task } from "../features/tasks/index.ts"; export { TaskView } from "../features/tasks/components/index.ts";');
    await checkArchitecture(directory);
    await put('src/app/main.ts', 'export { TaskView } from "../features/tasks/components/TaskView/index.tsx";');
    await assert.rejects(checkArchitecture(directory), /禁止依赖 features\/tasks\/components\/TaskView\/index.tsx/);
    await put('src/app/main.ts', 'export type { Task } from "../features/tasks/index.ts";');
    await put('src/features/tasks/index.ts', 'export { TaskView } from "./components/index.ts";');
    await assert.rejects(checkArchitecture(directory), /禁止依赖 features\/tasks\/components\/index.ts/);
    await put('src/features/tasks/index.ts', 'export type { Task } from "./types/task.ts";');
    await put('src/features/tasks/components/TaskView/index.tsx', 'export { value } from "../../services/gateway.ts";');
    await assert.rejects(checkArchitecture(directory), /禁止依赖 features\/tasks\/services\/gateway.ts/);
    await put('src/features/tasks/components/TaskView/index.tsx', 'export const TaskView = () => <section>任务</section>;');
    await put('src/components/Widget/index.tsx', 'export { Widget } from "../index.ts";');
    await assert.rejects(checkArchitecture(directory), /禁止依赖 components\/index.ts/);
    await put('src/components/Widget/index.tsx', 'export const Widget = () => <section>组件</section>;');
    await put('src/features/tasks/extra.ts', 'export const extra = 1;');
    await assert.rejects(checkArchitecture(directory), /功能源码必须位于 models\/services\/types\/utils\/components/);
  } finally {
    const resolved = resolve(directory); assert.ok(resolved.startsWith(resolve(tmpdir()) + sep));
    await rm(resolved, { recursive: true, force: true });
  }
});
