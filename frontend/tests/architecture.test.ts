import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import {
  allowedDependency,
  findCycles,
  sourcePlacementIssue,
} from '../scripts/architecture-policy.ts';
import { inspectSource } from '../scripts/source-dependencies.ts';
import { checkArchitecture } from '../scripts/check-architecture.ts';

test('解析器识别重导出、动态导入和类型引用，并忽略注释与字符串', () => {
  const result = inspectSource(
    'export * from "../app/a"; const value = import("../shared/a"); type T = import("../features/b").T; // fetch() any\nconst text = "fetch() any";',
    'sample.ts',
  );
  assert.deepEqual(
    result.dependencies.map((entry) => entry.value),
    ['../app/a', '../shared/a', '../features/b'],
  );
  assert.deepEqual(result.issues, []);
  assert.match(
    inspectSource(
      'import(variable); const x: any = globalThis.fetch("/");',
      'sample.ts',
    ).issues.join(),
    /字面量.*any.*network/,
  );
});
test('TSX 事件与泛型组件使用同一导入、网络和类型门禁', () => {
  const result = inspectSource(
    'import type { X } from "../x"; export * from "../shared/a"; const load = () => import("../features/b"); type T = import("../types").T; const View = <T,>(value: T) => <button onClick={() => globalThis.fetch("/")}>{String(value)}</button>; let unchecked: any;',
    'View.tsx',
  );
  assert.deepEqual(
    result.dependencies.map((entry) => entry.value),
    ['../x', '../shared/a', '../features/b', '../types'],
  );
  assert.ok(result.issues.some((issue) => issue.includes('any')));
  assert.ok(result.issues.includes('network'));
  const safe = inspectSource(
    'const text = "fetch() any"; export const View = () => <button title={text}>{/* fetch() any */}安全</button>;',
    'Safe.tsx',
  );
  assert.deepEqual(safe.issues, []);
  assert.match(
    inspectSource(
      'export const View = () => <button onClick={() => import(variable)}>加载</button>;',
      'Dynamic.tsx',
    ).issues.join(),
    /字面量/,
  );
});
test('循环检测包含重导出和类型依赖', () => {
  assert.equal(
    findCycles(
      new Map([
        ['a', ['b']],
        ['b', ['c']],
        ['c', ['a']],
      ]),
    ).length,
    1,
  );
  assert.deepEqual(
    findCycles(
      new Map([
        ['a', ['b']],
        ['b', []],
      ]),
    ),
    [],
  );
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
  for (const [from, to] of rejected)
    assert.equal(allowedDependency(from, to), false, from + ' 不应依赖 ' + to);
  const accepted: readonly (readonly [string, string])[] = [
    ['components/Button/index.tsx', 'utils/classnames.ts'],
    ['components/Panel/index.tsx', 'components/Button/index.tsx'],
    ['components/Widget/index.tsx', 'components/Widget/hooks.ts'],
    ['components/index.ts', 'components/Widget/index.tsx'],
    ['app/product/shell.tsx', 'components/index.ts'],
    ['app/product/shell.tsx', 'components/Button/index.tsx'],
    ['plugins/example.ts', 'plugin-sdk/index.ts'],
  ];
  for (const [from, to] of accepted)
    assert.equal(allowedDependency(from, to), true, from + ' 应可依赖 ' + to);
});

test('实际组件入口拒绝别名业务导入、网络和any绕过，维护脚本仍严格使用TS', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deviceforge-architecture-react-'));
  const put = async (file: string, content: string) => {
    const target = join(directory, file);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content);
  };
  try {
    await put(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: { jsx: 'react-jsx', baseUrl: '.', paths: { '@app/*': ['src/app/*'] } },
      }),
    );
    await put('src/app/main.ts', 'export const value = 1;');
    await put(
      'src/components/Panel/index.tsx',
      'export const Panel = () => <section>面板</section>;',
    );
    await checkArchitecture(directory);
    await put('src/components/Panel/index.tsx', 'export { value } from "@app/main";');
    await assert.rejects(checkArchitecture(directory), /禁止依赖 app\/main.ts/);
    await put(
      'src/components/Panel/index.tsx',
      'export const Panel = () => <section onClick={() => globalThis.fetch("/")}>面板</section>;',
    );
    await assert.rejects(checkArchitecture(directory), /网络调用只能位于 services\/api 适配器/);
    await put(
      'src/components/Panel/index.tsx',
      'const unchecked: any = null; export const Panel = () => <section>{unchecked}</section>;',
    );
    await assert.rejects(checkArchitecture(directory), /不得使用 any 绕过类型边界/);
    await put(
      'src/components/Panel/index.tsx',
      'export const Panel = () => <section>面板</section>;',
    );
    await put('scripts/untyped.mjs', 'export const value = 1;');
    await assert.rejects(checkArchitecture(directory), /维护脚本与测试必须使用 TypeScript/);
  } finally {
    const resolved = resolve(directory);
    assert.ok(resolved.startsWith(resolve(tmpdir()) + sep));
    await rm(resolved, { recursive: true, force: true });
  }
});

test('页面公开入口与私有实现隔离，features不容纳业务UI', () => {
  const rejected: readonly (readonly [string, string])[] = [
    ['app/product/App.tsx', 'pages/tasks/components/TaskTable.tsx'],
    ['pages/tasks/index.tsx', 'pages/devices/components/Details.tsx'],
    ['pages/tasks/index.tsx', 'pages/devices/index.tsx'],
    ['pages/tasks/index.tsx', 'features/tasks/models/controller.ts'],
    ['pages/tasks/index.tsx', 'features/tasks/components/index.ts'],
    ['pages/tasks/index.tsx', 'components/Button/types.ts'],
    ['pages/tasks/index.tsx', 'app/runtime.ts'],
    ['pages/tasks/index.tsx', 'app/product/private.ts'],
    ['pages/tasks/index.tsx', 'shared/jobs/controller.ts'],
    ['pages/tasks/index.tsx', 'shared/api/index.ts'],
    ['pages/tasks/index.tsx', 'plugin-sdk/private.ts'],
    ['pages/tasks/index.tsx', 'plugin-sdk/models/internal.ts'],
    ['features/tasks/index.ts', 'pages/tasks/index.tsx'],
    ['features/tasks/models/controller.ts', 'components/Button/index.tsx'],
    ['features/tasks/models/controller.ts', 'features/devices/models/controller.ts'],
    ['features/tasks/types/task.ts', 'features/devices/types/device.ts'],
    ['features/tasks/services/gateway.ts', 'features/tasks/models/controller.ts'],
    ['features/tasks/utils/rules.ts', 'features/tasks/services/gateway.ts'],
  ];
  for (const [from, to] of rejected)
    assert.equal(allowedDependency(from, to), false, from + ' 不应依赖 ' + to);
  const accepted: readonly (readonly [string, string])[] = [
    ['app/product/App.tsx', 'pages/tasks/index.tsx'],
    ['pages/tasks/index.tsx', 'pages/tasks/components/TaskTable.tsx'],
    ['pages/tasks/index.tsx', 'features/tasks/index.ts'],
    ['pages/tasks/index.tsx', 'components/Button/index.tsx'],
    ['pages/tasks/index.tsx', 'services/api/index.ts'],
    ['pages/tasks/index.tsx', 'shared/jobs/index.ts'],
    ['pages/tasks/index.tsx', 'plugin-sdk/index.ts'],
    ['pages/tasks/index.tsx', 'plugin-sdk/json.ts'],
    ['pages/tasks/index.tsx', 'app/product/services.ts'],
    ['pages/tasks/components/TaskTable.tsx', 'app/product/hooks.ts'],
    ['features/tasks/models/controller.ts', 'features/tasks/services/gateway.ts'],
    ['features/tasks/models/controller.ts', 'features/devices/index.ts'],
    ['features/tasks/types/task.ts', 'features/devices/index.ts'],
    ['features/tasks/services/gateway.ts', 'services/api/index.ts'],
    ['features/tasks/utils/rules.ts', 'features/tasks/types/task.ts'],
    ['tests/tasks.test.ts', 'pages/tasks/components/TaskTable.tsx'],
  ];
  for (const [from, to] of accepted)
    assert.equal(allowedDependency(from, to), true, from + ' 应可依赖 ' + to);
  for (const file of [
    'features/tasks/components/index.ts',
    'features/tasks/components/TaskView/index.tsx',
    'features/tasks/ui/view.tsx',
    'features/tasks/models/View.tsx',
    'pages/index.tsx',
    'components/ui/button.tsx',
  ])
    assert.ok(sourcePlacementIssue(file), file + ' 不符合页面归属');
  for (const file of [
    'pages/tasks/index.tsx',
    'pages/tasks/components/TaskTable.tsx',
    'pages/tasks/types.ts',
    'features/tasks/index.ts',
    'features/tasks/models/controller.ts',
    'components/Widget/index.tsx',
  ])
    assert.equal(sourcePlacementIssue(file), null);
});

test('真实页面目录组合公共请求与核心逻辑，别名和重导出不能泄露页面私有UI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deviceforge-architecture-pages-'));
  const put = async (file: string, content: string) => {
    const target = join(directory, file);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content);
  };
  try {
    await put(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          jsx: 'react-jsx',
          module: 'esnext',
          moduleResolution: 'bundler',
          baseUrl: '.',
          paths: { '@pages/*': ['src/pages/*'] },
        },
      }),
    );
    await put('src/features/tasks/README.md', '# 跨页面任务逻辑');
    await put('src/features/tasks/types/task.ts', 'export interface Task { readonly id: string }');
    await put('src/features/tasks/models/controller.ts', 'export const value = 1;');
    await put('src/features/tasks/index.ts', 'export { value } from "./models/controller.ts";');
    await put('src/services/api/index.ts', 'export const get = () => globalThis.fetch("/");');
    await put(
      'src/components/Button/index.tsx',
      'export const Button = () => <button>操作</button>;',
    );
    await put(
      'node_modules/example-widget/package.json',
      JSON.stringify({ name: 'example-widget', types: 'index.d.ts' }),
    );
    await put(
      'node_modules/example-widget/index.d.ts',
      'export interface WidgetProps { readonly title: string }',
    );
    await put(
      'src/components/Widget/index.tsx',
      'import type { WidgetProps } from "example-widget"; import { Button } from "../Button/index.tsx"; export const Widget = (props: WidgetProps) => <section title={props.title}><Button /></section>;',
    );
    await put(
      'src/pages/tasks/components/TaskTable.tsx',
      'import { Widget } from "../../../components/Widget/index.tsx"; export const TaskTable = () => <Widget title="任务" />;',
    );
    await put(
      'src/pages/tasks/index.tsx',
      'import { value } from "../../features/tasks/index.ts"; import { get } from "../../services/api/index.ts"; import { TaskTable } from "./components/TaskTable.tsx"; export const TasksPage = () => <section title={String(value)} onClick={() => get()}><TaskTable /></section>;',
    );
    await put(
      'src/pages/devices/index.tsx',
      'export const DevicesPage = () => <section>设备</section>;',
    );
    await put('src/app/App.tsx', 'export { TasksPage } from "../pages/tasks/index.tsx";');
    await checkArchitecture(directory);
    await put(
      'src/app/App.tsx',
      'export { TaskTable } from "@pages/tasks/components/TaskTable.tsx";',
    );
    await assert.rejects(
      checkArchitecture(directory),
      /禁止依赖 pages\/tasks\/components\/TaskTable.tsx/,
    );
    await put('src/app/App.tsx', 'export { TasksPage } from "../pages/tasks/index.tsx";');
    await put(
      'src/pages/devices/index.tsx',
      'export { TaskTable } from "../tasks/components/TaskTable.tsx";',
    );
    await assert.rejects(
      checkArchitecture(directory),
      /禁止依赖 pages\/tasks\/components\/TaskTable.tsx/,
    );
    await put(
      'src/pages/devices/index.tsx',
      'export const DevicesPage = () => <section>设备</section>;',
    );
    await put(
      'src/features/tasks/index.ts',
      'export { TaskTable } from "../../pages/tasks/components/TaskTable.tsx";',
    );
    await assert.rejects(
      checkArchitecture(directory),
      /禁止依赖 pages\/tasks\/components\/TaskTable.tsx/,
    );
    await put('src/features/tasks/index.ts', 'export { value } from "./models/controller.ts";');
    await put(
      'src/features/tasks/components/BadView.tsx',
      'export const BadView = () => <section>应归页面</section>;',
    );
    await assert.rejects(
      checkArchitecture(directory),
      /features 只保留跨页面业务逻辑，业务 UI 必须归属 pages/,
    );
  } finally {
    const resolved = resolve(directory);
    assert.ok(resolved.startsWith(resolve(tmpdir()) + sep));
    await rm(resolved, { recursive: true, force: true });
  }
});

test('跨功能只经公开核心入口，类型引用也禁止内部路径和循环', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deviceforge-architecture-features-'));
  const put = async (file: string, content: string) => {
    const target = join(directory, file);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content);
  };
  try {
    await put(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          module: 'esnext',
          moduleResolution: 'bundler',
          baseUrl: '.',
          paths: { '@features/*': ['src/features/*'] },
        },
      }),
    );
    await put('src/features/devices/README.md', '# 设备公共类型');
    await put(
      'src/features/devices/types/device.ts',
      'export interface Device { readonly id: string }',
    );
    await put('src/features/devices/index.ts', 'export type { Device } from "./types/device.ts";');
    await put('src/features/device-apps/README.md', '# 设备应用跨页逻辑');
    await put(
      'src/features/device-apps/types/app.ts',
      'import type { Device } from "@features/devices/index.ts"; export interface DeviceApp { readonly device: Device }',
    );
    await put(
      'src/features/device-apps/index.ts',
      'export type { DeviceApp } from "./types/app.ts";',
    );
    await checkArchitecture(directory);
    await put(
      'src/features/device-apps/types/app.ts',
      'import type { Device } from "@features/devices/types/device.ts"; export interface DeviceApp { readonly device: Device }',
    );
    await assert.rejects(
      checkArchitecture(directory),
      /禁止依赖 features\/devices\/types\/device.ts/,
    );
    await put(
      'src/features/device-apps/types/app.ts',
      'import type { Device } from "@features/devices/index.ts"; export interface DeviceApp { readonly device: Device }',
    );
    await put(
      'src/features/devices/types/device.ts',
      'import type { DeviceApp } from "@features/device-apps/index.ts"; export interface Device { readonly id: string; readonly apps: readonly DeviceApp[] }',
    );
    await assert.rejects(checkArchitecture(directory), /循环导入/);
  } finally {
    const resolved = resolve(directory);
    assert.ok(resolved.startsWith(resolve(tmpdir()) + sep));
    await rm(resolved, { recursive: true, force: true });
  }
});
