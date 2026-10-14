import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendRuntime } from '../src/app/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type {
  Dispose,
  HostContext,
  ThemeContribution,
  WebPlugin,
} from '../src/plugin-sdk/index.ts';
import { isThemeContribution, copyThemeContribution } from '../src/plugins/themes/rules.ts';
import { dom } from './dom-fixtures.ts';
import { success, job } from './fixtures.ts';

function runtime(target?: HTMLElement) {
  return createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async () => success(job()),
    ...(target ? { themeTarget: target } : {}),
  });
}
function register(
  instance: ReturnType<typeof runtime>,
  id: string,
  themes: readonly ThemeContribution[],
  activate?: WebPlugin['activate'],
) {
  instance.webPlugins.register({
    id,
    trusted: true,
    plugin: {
      id,
      version: '1.0',
      apiVersion: 2,
      panels: [],
      contributions: { themes },
      ...(activate ? { activate } : {}),
    },
  });
}

test('主题纯校验拒绝结构、变量限额和 UTF-8 样式限额，复制结果冻结', () => {
  const valid: ThemeContribution = {
    id: 'theme.test',
    title: '主题',
    variables: { '--中文': 'value' },
  };
  assert.equal(isThemeContribution(valid), true);
  const invalid: readonly unknown[] = [
    null,
    { ...valid, title: ' ' },
    { ...valid, variables: [] },
    { ...valid, variables: new Map() },
    { ...valid, variables: { color: 'red' } },
    { ...valid, variables: { ['--' + 'x'.repeat(127)]: 'x' } },
    { ...valid, variables: { '--x': 'x'.repeat(4097) } },
    { ...valid, variables: { '--x': ' ' } },
    { ...valid, variables: { '--x': 1 } },
    { ...valid, css: '中'.repeat(90000) },
    { ...valid, colorScheme: 'unknown' },
  ];
  for (const value of invalid) assert.equal(isThemeContribution(value), false);
  assert.equal(isThemeContribution({ ...valid, css: 'x'.repeat(256 * 1024) }), true);
  const copied = copyThemeContribution(valid);
  assert.ok(Object.isFrozen(copied));
  assert.ok(Object.isFrozen(copied.variables));
});

test('主题显式选择应用变量、配色和可信样式，卸载精确恢复宿主基线', async () => {
  const target = dom();
  target.style.setProperty('--base', '宿主', 'important');
  target.style.setProperty('margin', '2px');
  const instance = runtime(target);
  register(instance, 'theme', [
    {
      id: 'theme.dark',
      title: '暗色',
      variables: { '--base': '插件', '--new': '值' },
      css: ':root{--theme-probe: 1}',
      colorScheme: 'dark',
    },
  ]);
  await instance.webPlugins.load('theme');
  assert.equal(instance.themes.snapshot().selected, null);
  instance.themes.select('theme.dark');
  assert.equal(target.style.getPropertyValue('--base'), '插件');
  assert.equal(target.style.getPropertyPriority('--base'), 'important');
  assert.equal(target.style.getPropertyValue('--new'), '值');
  assert.equal(target.style.getPropertyValue('color-scheme'), 'dark');
  assert.equal(
    target.ownerDocument.head.querySelectorAll('style[data-deviceforge-theme="theme.dark"]').length,
    1,
  );
  instance.themes.select(null);
  assert.equal(target.style.getPropertyValue('--base'), '宿主');
  assert.equal(target.style.getPropertyPriority('--base'), 'important');
  assert.equal(target.style.getPropertyValue('--new'), '');
  assert.equal(target.style.getPropertyValue('margin'), '2px');
  assert.equal(
    target.ownerDocument.head.querySelectorAll('style[data-deviceforge-theme]').length,
    0,
  );
  await instance.webPlugins.unload('theme');
  await instance.dispose();
});

test('主题限额、重复标识、未知选择和无目标选择保持协议边界', async () => {
  const instance = runtime(dom());
  const tooMany = Object.fromEntries(
    Array.from({ length: 129 }, (_, index) => [`--v${index}`, 'x']),
  );
  assert.throws(
    () => register(instance, 'bad', [{ id: 'bad.theme', title: '坏', variables: tooMany }]),
    /SDK v2/,
  );
  register(instance, 'one', [{ id: 'one.theme', title: '一' }]);
  assert.throws(() => register(instance, 'two', [{ id: 'one.theme', title: '重复' }]), /命名空间/);
  await instance.webPlugins.load('one');
  assert.throws(
    () => instance.themes.select('missing'),
    (error: unknown) => error instanceof HostError && error.code === 'theme_unavailable',
  );
  const noTarget = runtime();
  register(noTarget, 'plain', [{ id: 'plain.theme', title: '无目标' }]);
  await noTarget.webPlugins.load('plain');
  assert.throws(
    () => noTarget.themes.select('plain.theme'),
    (error: unknown) => error instanceof HostError && error.code === 'theme_unavailable',
  );
  await instance.dispose();
  await noTarget.dispose();
});

test('旧插件上下文主题入口在撤销后拒绝，监听异常不阻断恢复', async () => {
  const target = dom();
  const instance = runtime(target);
  let pluginContext: HostContext | undefined;
  register(
    instance,
    'scoped',
    [{ id: 'scoped.theme', title: '主题', variables: { '--x': '1' } }],
    async (context) => {
      pluginContext = context;
      context.themes?.subscribe(() => {
        throw new Error('监听错误');
      });
    },
  );
  await instance.webPlugins.load('scoped');
  pluginContext?.themes?.select('scoped.theme');
  assert.equal(target.style.getPropertyValue('--x'), '1');
  await instance.webPlugins.unload('scoped');
  assert.equal(target.style.getPropertyValue('--x'), '');
  assert.throws(
    () => pluginContext?.themes?.snapshot(),
    (error: unknown) => error instanceof HostError && error.kind === 'cancelled',
  );
  await instance.dispose();
});

test('主题登记对象复制冻结，后续修改不会改变目录', async () => {
  const target = dom();
  const instance = runtime(target);
  const variables: Record<string, string> = { '--x': 'before' };
  const declaration = { id: 'copy.theme', title: '复制', variables };
  register(instance, 'copy', [declaration]);
  await instance.webPlugins.load('copy');
  variables['--x'] = 'after';
  declaration.title = '篡改';
  instance.themes.select('copy.theme');
  assert.equal(target.style.getPropertyValue('--x'), 'before');
  assert.equal(instance.themes.snapshot().themes[0]?.title, '复制');
  await instance.dispose();
});

test('主题切换和 DOM 应用失败保留原主题，运行实例关闭恢复基础且即时拒绝旧入口', async () => {
  const target = dom();
  target.style.setProperty('--base', 'original');
  target.style.setProperty('color-scheme', 'light', 'important');
  const instance = runtime(target);
  register(instance, 'switch', [
    {
      id: 'switch.one',
      title: '一',
      variables: { '--base': 'one', '--only-one': '1' },
      css: '.one{color:red}',
      colorScheme: 'dark',
    },
    { id: 'switch.two', title: '二', variables: { '--base': 'two' }, css: '.two{color:blue}' },
  ]);
  await instance.webPlugins.load('switch');
  instance.themes.select('switch.one');
  const head = target.ownerDocument.head;
  const append = head.append.bind(head);
  let fail = true;
  head.append = (...nodes) => {
    if (fail) {
      fail = false;
      throw new Error('应用失败');
    }
    append(...nodes);
  };
  assert.throws(() => instance.themes.select('switch.two'), /应用失败/);
  assert.equal(instance.themes.snapshot().selected?.id, 'switch.one');
  assert.equal(target.style.getPropertyValue('--base'), 'one');
  assert.equal(head.querySelectorAll('style[data-deviceforge-theme]').length, 1);
  instance.themes.select('switch.two');
  assert.equal(target.style.getPropertyValue('--only-one'), '');
  assert.equal(target.style.getPropertyValue('color-scheme'), 'light');
  assert.equal(target.style.getPropertyPriority('color-scheme'), 'important');
  const closing = instance.dispose();
  assert.throws(
    () => instance.themes.snapshot(),
    (error: unknown) => error instanceof HostError && error.code === 'themes_closed',
  );
  await closing;
  assert.equal(target.style.getPropertyValue('--base'), 'original');
  assert.equal(target.style.getPropertyPriority('--base'), '');
  assert.equal(head.querySelectorAll('style[data-deviceforge-theme]').length, 0);
});

test('动态登记统一拒绝重复贡献标识，撤销选中主题后可复用 ID，激活失败恢复基础', async () => {
  const target = dom();
  const instance = runtime(target);
  let context: HostContext | undefined;
  register(instance, 'dynamic', [], async (value) => {
    context = value;
  });
  await instance.webPlugins.load('dynamic');
  const registerDynamic = context?.extensions?.register;
  assert.ok(registerDynamic);
  const remove = registerDynamic({
    themes: [{ id: 'dynamic.dark', title: '动态', variables: { '--dynamic': '1' } }],
  });
  assert.throws(
    () =>
      registerDynamic({
        commands: [
          { id: 'dynamic.dark', title: '冲突', execute: async () => ({ data: null, logId: null }) },
        ],
      }),
    /冲突/,
  );
  instance.themes.select('dynamic.dark');
  await remove();
  assert.equal(target.style.getPropertyValue('--dynamic'), '');
  assert.equal(instance.themes.snapshot().selected, null);
  const again = registerDynamic({ themes: [{ id: 'dynamic.dark', title: '再次' }] });
  await again();
  register(
    instance,
    'broken',
    [{ id: 'broken.dark', title: '失败', variables: { '--broken': '1' } }],
    async (value) => {
      value.themes?.select('broken.dark');
      throw new Error('激活失败');
    },
  );
  await assert.rejects(instance.webPlugins.load('broken'), /激活失败/);
  assert.equal(instance.themes.snapshot().selected, null);
  assert.equal(target.style.getPropertyValue('--broken'), '');
  assert.equal(
    instance.themes.snapshot().themes.some((entry) => entry.pluginId === 'broken'),
    false,
  );
  await instance.dispose();
});

test('目录通知重入卸载不留下半登记主题或贡献标识', async () => {
  const instance = runtime(dom());
  let unloading: Promise<void> | undefined;
  const stop: Dispose = instance.themes.subscribe((snapshot) => {
    if (snapshot.themes.some((entry) => entry.pluginId === 'reentry'))
      unloading = instance.webPlugins.unload('reentry');
  });
  register(instance, 'reentry', [{ id: 'reentry.dark', title: '重入' }]);
  await assert.rejects(
    instance.webPlugins.load('reentry'),
    (error: unknown) => error instanceof HostError && error.kind === 'cancelled',
  );
  await unloading;
  assert.deepEqual(instance.themes.snapshot().themes, []);
  await stop();
  await instance.webPlugins.load('reentry');
  assert.equal(instance.themes.snapshot().themes.length, 1);
  await instance.dispose();
});

test('通知期间重入清除主题时后续监听仅收到最新选择', async () => {
  const instance = runtime(dom());
  register(instance, 'notify', [{ id: 'notify.theme', title: '通知' }]);
  await instance.webPlugins.load('notify');
  const stopFirst = instance.themes.subscribe((snapshot) => {
    if (snapshot.selected) instance.themes.select(null);
  });
  const received: (string | null)[] = [];
  const stopSecond = instance.themes.subscribe((snapshot) => {
    received.push(snapshot.selected?.id ?? null);
    assert.equal(snapshot.selected?.id, instance.themes.snapshot().selected?.id);
  });
  received.length = 0;
  instance.themes.select('notify.theme');
  assert.deepEqual(received, [null]);
  assert.equal(instance.themes.snapshot().selected, null);
  await stopFirst();
  await stopSecond();
  await instance.dispose();
});
