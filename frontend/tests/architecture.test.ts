import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { allowedDependency, findCycles, sourcePlacementIssue } from '../scripts/architecture-policy.ts';
import { inspectSource } from '../scripts/source-dependencies.ts';
import { checkArchitecture } from '../scripts/check-architecture.ts';

test('功能、SDK、展示层与宿主的反向依赖被拒绝', () => {
  const rejected: readonly (readonly [string, string])[] = [['features/devices/a.ts','features/tasks/b.ts'],['plugin-sdk/index.ts','shared/api/generated.ts'],['shared/ui/a.ts','shared/api/client.ts'],['plugins/a.ts','app/main.ts']];
  for (const [from, to] of rejected) assert.equal(allowedDependency(from, to), false);
  assert.equal(allowedDependency('features/devices/infrastructure/a.ts','shared/api/client.ts'), true);
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
    await mkdir(join(directory,'src/components/ui'), { recursive: true });
    await writeFile(join(directory,'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/app/*'] } } }));
    await writeFile(join(directory,'src/app/a.ts'), 'export const value = 1;');
    await writeFile(join(directory,'src/components/ui/b.ts'), 'export {value} from "@app/a";');
    await assert.rejects(checkArchitecture(directory), /禁止依赖 app\/a.ts/);
    await writeFile(join(directory,'src/components/ui/b.ts'), 'export const value = "安全展示";');
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
    await mkdir(join(directory, 'src/components/ui/controls'), { recursive: true });
    await writeFile(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx', baseUrl: '.', paths: { '@app/*': ['src/app/*'] } } }));
    await writeFile(join(directory, 'src/components/ui/Panel.tsx'), 'export const Panel = () => <section>面板</section>;');
    await writeFile(join(directory, 'src/components/ui/controls/index.tsx'), 'export const Control = () => <button>操作</button>;');
    await writeFile(join(directory, 'src/app/View.tsx'), 'import { Panel } from "../components/ui/Panel"; import { Control } from "../components/ui/controls"; export const View = () => <Panel><Control /></Panel>;');
    await checkArchitecture(directory);
    await writeFile(join(directory, 'src/components/ui/Panel.tsx'), 'export { View } from "@app/View";');
    await assert.rejects(checkArchitecture(directory), /禁止依赖 app\/View.tsx/);
    await writeFile(join(directory, 'src/components/ui/Panel.tsx'), 'export const Panel = () => <section onClick={() => globalThis.fetch("/")}>面板</section>;');
    await assert.rejects(checkArchitecture(directory), /网络调用只能位于 shared\/api 适配器/);
    await writeFile(join(directory, 'src/components/ui/Panel.tsx'), 'const unchecked: any = null; export const Panel = () => <section>{unchecked}</section>;');
    await assert.rejects(checkArchitecture(directory), /不得使用 any 绕过类型边界/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('公共组件按基础、通用展示与第三方包装分层，禁止业务和反向依赖', () => {
  const rejected: readonly (readonly [string, string])[] = [
    ['components/ui/button.tsx', 'components/common/page-title.tsx'],
    ['components/ui/button.tsx', 'components/integrations/chart/view.tsx'],
    ['components/common/page-title.tsx', 'components/integrations/chart/view.tsx'],
    ['components/lib/utils.ts', 'components/ui/button.tsx'],
    ...['shared/api/client.ts', 'features/tasks/index.ts', 'app/runtime.ts', 'plugins/index.ts', 'plugin-sdk/index.ts'].map(to => ['components/integrations/chart/view.tsx', to] as const),
    ['components/common/result.tsx', 'shared/jobs/index.ts'],
    ['shared/lib/utils.ts', 'shared/api/client.ts'],
  ];
  for (const [from, to] of rejected) assert.equal(allowedDependency(from, to), false, from + ' 不应依赖 ' + to);
  const accepted: readonly (readonly [string, string])[] = [
    ['components/ui/button.tsx', 'components/lib/utils.ts'],
    ['components/common/page-title.tsx', 'components/ui/button.tsx'],
    ['components/integrations/chart/view.tsx', 'components/common/empty-state.tsx'],
    ['components/integrations/chart/view.tsx', 'components/ui/button.tsx'],
    ['components/common/page-title.tsx', 'shared/lib/utils.ts'],
    ['app/product/shell.tsx', 'components/common/page-title.tsx'],
    ['features/android-profile/ui/view.tsx', 'components/ui/button.tsx'],
  ];
  for (const [from, to] of accepted) assert.equal(allowedDependency(from, to), true, from + ' 应可依赖 ' + to);
});

test('功能源码根目录只留公开入口，模块按需分层而不要求空目录', () => {
  assert.equal(sourcePlacementIssue('features/tasks/index.ts'), null);
  assert.equal(sourcePlacementIssue('features/tasks/application/controller.ts'), null);
  assert.equal(sourcePlacementIssue('features/tasks/domain/models.ts'), null);
  assert.ok(sourcePlacementIssue('features/tasks/controller.ts'));
  assert.ok(sourcePlacementIssue('features/tasks/helpers/controller.ts'));
  assert.equal(allowedDependency('app/runtime.ts', 'features/tasks/index.ts'), true);
  assert.equal(allowedDependency('app/runtime.ts', 'features/tasks/domain/models.ts'), false);
  assert.equal(allowedDependency('tests/tasks.test.ts', 'features/tasks/domain/models.ts'), true);
  const rejected: readonly (readonly [string, string])[] = [
    ['features/tasks/domain/model.ts', 'features/tasks/application/controller.ts'],
    ['features/tasks/domain/model.ts', 'features/tasks/infrastructure/client.ts'],
    ['features/tasks/domain/model.ts', 'features/tasks/ui/view.tsx'],
    ['features/tasks/infrastructure/client.ts', 'features/tasks/application/controller.ts'],
    ['features/tasks/infrastructure/client.ts', 'features/tasks/ui/view.tsx'],
    ['features/tasks/application/controller.ts', 'features/tasks/ui/view.tsx'],
    ['features/tasks/application/controller.ts', 'components/common/notice.tsx'],
    ['features/tasks/domain/model.ts', 'components/ui/button.tsx'],
    ['features/tasks/infrastructure/client.ts', 'components/ui/button.tsx'],
  ];
  for (const [from, to] of rejected) assert.equal(allowedDependency(from, to), false);
  assert.equal(allowedDependency('features/tasks/application/controller.ts', 'features/tasks/domain/model.ts'), true);
  assert.equal(allowedDependency('features/tasks/ui/view.tsx', 'features/tasks/application/controller.ts'), true);
});

test('实际目录接受第三方通用包装，拒绝类型入口绕过和功能根部源码', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deviceforge-architecture-components-'));
  const put = async (file: string, source: string) => {
    const target = join(directory, file); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, source);
  };
  try {
    await put('tsconfig.json', JSON.stringify({ compilerOptions: { jsx: 'react-jsx', moduleResolution: 'bundler', module: 'esnext', baseUrl: '.', paths: { '@feature/*': ['src/features/*'] } } }));
    await put('src/features/tasks/README.md', '# 任务模块');
    await put('src/features/tasks/domain/model.ts', 'export interface Task { readonly id: string }');
    await put('src/features/tasks/index.ts', 'export type { Task } from "./domain/model.ts";');
    await put('src/components/lib/utils.ts', 'export const identity = <T,>(value: T) => value;');
    await put('src/components/ui/button.tsx', 'import { identity } from "../lib/utils.ts"; export const Button = () => <button>{identity("操作")}</button>;');
    await put('src/components/common/empty-state.tsx', 'export { Button as EmptyState } from "../ui/button.tsx";');
    await put('node_modules/example-widget/package.json', JSON.stringify({ name: 'example-widget', types: 'index.d.ts' }));
    await put('node_modules/example-widget/index.d.ts', 'export interface WidgetProps { readonly title: string }');
    await put('src/components/integrations/widget/view.tsx', 'import type { WidgetProps } from "example-widget"; import { EmptyState } from "../../common/empty-state.tsx"; export const Widget = (props: WidgetProps) => <section title={props.title}><EmptyState /></section>;');
    await put('src/app/main.ts', 'import type { Task } from "../features/tasks/index.ts"; export type CurrentTask = Task;');
    await checkArchitecture(directory);
    await put('src/app/main.ts', 'import type { Task } from "@feature/tasks/domain/model.ts"; export type CurrentTask = Task;');
    await assert.rejects(checkArchitecture(directory), /禁止依赖 features\/tasks\/domain\/model.ts/);
    await put('src/app/main.ts', 'export type { Task } from "../features/tasks/index.ts";');
    await put('src/components/common/empty-state.tsx', 'export { Widget } from "../integrations/widget/view.tsx";');
    await assert.rejects(checkArchitecture(directory), /禁止依赖 components\/integrations\/widget\/view.tsx/);
    await put('src/components/common/empty-state.tsx', 'export { Button as EmptyState } from "../ui/button.tsx";');
    await put('src/features/tasks/extra.ts', 'export const extra = 1;');
    await assert.rejects(checkArchitecture(directory), /功能源码必须位于 domain\/application\/infrastructure\/ui/);
  } finally {
    const resolved = resolve(directory); const temporaryRoot = resolve(tmpdir()) + sep;
    assert.ok(resolved.startsWith(temporaryRoot), '临时夹具清理必须限于本次临时目录');
    await rm(resolved, { recursive: true, force: true });
  }
});
