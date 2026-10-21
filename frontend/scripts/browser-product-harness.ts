import { createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createProductServices } from '../src/app/product/services.ts';
import { AppsPage } from '../src/pages/devices/apps/components/AppsPanel/index.tsx';
import { DevicesConnect } from '../src/pages/devices/components/DevicesConnect/index.tsx';
import { DeviceApps } from '../src/pages/devices/apps/index.tsx';
import { FilesPage } from '../src/pages/files/index.tsx';
import { AnalysisPage } from '../src/pages/analysis/index.tsx';
import { ToolsPage } from '../src/pages/tools/index.tsx';
import { TasksPage } from '../src/pages/tasks/index.tsx';
import { capabilityGate, decodeAppList } from '../src/features/device-apps/models/apps-contract.ts';
import {
  createProductFixture,
  fixtureArtifact,
  fixtureTaskFiles,
} from './browser-product-fixture.ts';
import type { ProductServices } from '../src/app/product/services.ts';

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 16));
async function until(test: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (!test()) {
    if (Date.now() >= deadline) throw new Error(message);
    await pause();
  }
}
function button(text: string): HTMLButtonElement {
  const element = [...document.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text,
  );
  check(element instanceof HTMLButtonElement, `未找到按钮：${text}`);
  return element;
}
async function click(text: string) {
  const target = button(text);
  check(!target.disabled, `按钮被禁用：${text}`);
  target.click();
  await pause();
}
function input(label: string): HTMLInputElement {
  const element = [...document.querySelectorAll('label')].find(
    (item) => item.textContent?.trim() === label,
  );
  const target =
    element instanceof HTMLLabelElement ? document.getElementById(element.htmlFor) : null;
  check(target instanceof HTMLInputElement, `未找到输入框：${label}`);
  return target;
}
async function fill(label: string, value: string) {
  const target = input(label);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  check(setter, '浏览器缺少原生输入值 setter');
  setter.call(target, value);
  target.dispatchEvent(new Event('input', { bubbles: true }));
  await pause();
}
async function select(label: string, text: string) {
  const target = button(label);
  target.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      pointerType: 'mouse',
      isPrimary: true,
    }),
  );
  await pause();
  const option = [...document.querySelectorAll('[role="option"]')].find(
    (item) => item.textContent?.trim() === text,
  );
  check(option instanceof HTMLElement, `未找到选择项：${text}`);
  option.click();
  await pause();
}
async function tab(text: string) {
  const target = [...document.querySelectorAll('[role="tab"]')].find(
    (item) => item.textContent?.trim() === text,
  );
  check(target instanceof HTMLElement, `未找到页签：${text}`);
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  target.click();
  await pause();
}
async function upload(label: string, filename: string) {
  const target = input(label);
  const transfer = new DataTransfer();
  transfer.items.add(new File(['受控文件'], filename));
  target.files = transfer.files;
  target.dispatchEvent(new Event('change', { bubbles: true }));
  await pause();
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export async function verifyProductPages() {
  const fixture = createProductFixture();
  const checks: { name: string; passed: true }[] = [];
  const target = document.createElement('main');
  document.body.append(target);
  let root = createRoot(target);
  const services = createProductServices({
    baseUrl: location.origin,
    transport: fixture.transport,
    panelTarget: () => target,
  });
  const signal = AbortSignal.timeout(45000);
  const passed = (name: string) => checks.push({ name, passed: true });
  const count = (path: string) =>
    fixture.requests.filter((item) => item.method === 'POST' && item.path === path).length;
  const actions = () =>
    fixture.requests.filter(
      (item) => item.path === '/api/v2/device-actions' && item.method === 'POST',
    );
  const lastAction = () => actions().at(-1)?.input;
  const submitted = () =>
    fixture.requests.filter((item) => item.path === '/api/v2/jobs' && item.method === 'POST');
  const mount = async (
    page: (props: { services: ProductServices }) => ReturnType<typeof createElement>,
  ) => {
    root.unmount();
    target.replaceChildren();
    root = createRoot(target);
    root.render(createElement(StrictMode, null, createElement(page, { services })));
    await pause();
  };
  const choose = (index: number) => {
    const provider = fixture.providers[index];
    check(provider, '受控提供者缺失');
    services.runtime.devices.select({
      providerId: provider.id,
      generation: provider.generation,
      localId: 'device-a',
    });
  };
  try {
    await services.runtime.operations.refresh(signal);
    await services.runtime.devices.refreshDirectories(signal);
    await mount(AppsPage);
    check(button('读取应用列表').disabled, '未选设备仍允许读取应用');
    passed('无设备时应用入口禁用');
    choose(0);
    await pause();
    fixture.setOperations([]);
    await services.runtime.operations.refresh(signal);
    await pause();
    check(button('读取应用列表').disabled, '缺少实际操作目录仍允许提交');
    passed('操作目录缺失禁止提交');
    fixture.restoreOperations();
    await services.runtime.operations.refresh(signal);
    await pause();
    await click('读取应用列表');
    await until(
      () => target.querySelectorAll('tbody tr').length === 30,
      '应用列表没有专用分页表格',
    );
    check(target.textContent?.includes('35 个标识'), '应用列表总数未显示');
    await click('下一页应用');
    check(
      target.querySelectorAll('tbody tr').length === 5 &&
        target.textContent?.includes('com.fixture.app34'),
      '应用下一页未显示真实剩余条目',
    );
    await fill('筛选应用标识', 'com.fixture.app1');
    check(target.querySelectorAll('tbody tr').length === 11, '应用筛选没有按实际标识过滤');
    await fill('筛选应用标识', '');
    await click('启动 com.fixture.app0');
    await until(() => !target.textContent?.includes('正在等待真实结果'), '启动任务未结束');
    const startInput = lastAction();
    check(
      object(startInput) &&
        object(startInput['input']) &&
        startInput['input']['package'] === 'com.fixture.app0' &&
        !('activity' in startInput['input']),
      '启动未使用真实 package 输入',
    );
    passed('应用列表筛选分页与 package 启动');
    const beforeDialog = count('/api/v2/device-actions');
    await click('卸载 com.fixture.app0');
    check(
      document.querySelector('[role="dialog"]')?.textContent?.includes('generation-1'),
      '卸载确认缺少完整目标代次',
    );
    check(count('/api/v2/device-actions') === beforeDialog, '打开卸载弹窗已经提交操作');
    await click('保留应用');
    check(count('/api/v2/device-actions') === beforeDialog, '取消弹窗仍提交卸载');
    passed('官方卸载弹窗固定目标且取消不提交');
    fixture.fail('fixture.first.app.stop');
    await click('停止 com.fixture.app0');
    await until(
      () => target.textContent?.includes('受控任务失败') ?? false,
      '失败任务没有显示诊断',
    );
    check(button('复制日志 ID：fixture-log'), '失败诊断缺少复制日志入口');
    fixture.fail('');
    passed('任务失败显示日志 ID');
    await upload('上传 APK / APKS / HAP', 'fixture.apks');
    await until(
      () => input('设备安装产物 ID').value === fixtureArtifact,
      '安装包上传没有保留产物身份',
    );
    await fill('安装 APKS 模块（可选）', 'base,feature');
    await click('安装到当前设备');
    await until(() => !target.textContent?.includes('正在等待真实结果'), 'APKS 安装等待未结束');
    const installInput = lastAction();
    check(
      object(installInput) &&
        installInput['capability'] === 'app.install_apks' &&
        object(installInput['input']) &&
        JSON.stringify(installInput['input']['modules']) === '["base","feature"]' &&
        installInput['input']['artifact_id'] === fixtureArtifact,
      'APKS 输入没有产物与模块字段',
    );
    const beforeInvalid = actions().length;
    await fill('安装 APKS 模块（可选）', 'ALL,feature');
    await click('安装到当前设备');
    await until(
      () => target.textContent?.includes('ALL只能单选') ?? false,
      '混用 ALL 没有客户端拒绝',
    );
    check(actions().length === beforeInvalid, '无效 APKS 模块仍提交');
    passed('上传 APKS 与模块约束');
    fixture.hold('fixture.first.packages');
    await click('读取应用列表');
    await until(() => fixture.pending() > 0, '受控应用任务未进入轮询');
    choose(1);
    await pause();
    fixture.release();
    await pause();
    check(
      !target.querySelector('tbody') && !target.textContent?.includes('com.fixture.app0'),
      '设备切换后旧应用列表覆盖当前视图',
    );
    check(fixture.aborted() > 0, '设备切换没有撤销整个任务等待');
    passed('设备切换撤销等待并拒绝晚到结果');
    await click('读取应用列表');
    await until(() => target.querySelectorAll('tbody tr').length === 30, '第二提供者列表没有显示');
    await fill('启动 Ability（可选）', 'EntryAbility');
    await click('启动 com.fixture.app0');
    await until(() => !target.textContent?.includes('正在等待真实结果'), '第二提供者启动未结束');
    const bundleStart = lastAction();
    check(
      object(bundleStart) &&
        object(bundleStart['input']) &&
        bundleStart['input']['bundle'] === 'com.fixture.app0' &&
        bundleStart['input']['ability'] === 'EntryAbility' &&
        !('package' in bundleStart['input']),
      '第二提供者启动没有依据 schema 映射 bundle',
    );
    await click('详情 com.fixture.app0');
    await until(
      () => target.textContent?.includes('保留字段') ?? false,
      '应用详情未知字段没有保留',
    );
    await click('清除数据 com.fixture.app0');
    await click('确认清除数据');
    await until(() => !target.textContent?.includes('正在等待真实结果'), '清除数据未结束');
    const reset = lastAction();
    check(
      object(reset) && object(reset['input']) && reset['input']['bundle'] === 'com.fixture.app0',
      '清除数据字段不兼容',
    );
    await click('卸载 com.fixture.app0');
    await click('确认卸载');
    await until(() => !target.textContent?.includes('正在等待真实结果'), '卸载未结束');
    const uninstall = lastAction();
    check(
      object(uninstall) &&
        object(uninstall['input']) &&
        uninstall['input']['package'] === 'com.fixture.app0',
      '卸载没有保持 package 字段',
    );
    passed('不同提供者按 schema 消费 bundle、ability、详情、清数据与 package 卸载');
    await upload('上传 APK / APKS / HAP', 'fixture.hap');
    await until(() => input('设备安装产物 ID').value === fixtureArtifact, 'HAP 上传未完成');
    await click('安装到当前设备');
    await until(() => !target.textContent?.includes('正在等待真实结果'), 'HAP 安装未结束');
    const hap = lastAction();
    check(
      object(hap) && hap['provider_id'] === 'fixture.second' && hap['capability'] === 'app.install',
      'HAP 没有复用声明安装能力',
    );
    passed('HAP 上传与声明安装能力');
    fixture.output('[Fail] dump failed');
    await click('读取应用列表');
    await until(
      () => target.textContent?.includes('应用列表文本未识别') ?? false,
      '未知列表没有独立诊断状态',
    );
    check(!target.querySelector('tbody'), '未知列表仍显示应用行');
    fixture.output(null);
    passed('未知应用列表保留原文且禁用行操作');
    const parsed = decodeAppList(
      {
        result: { output: 'package:com.failed.example\npackage:com.error.example' },
        artifacts: [],
      },
      'fixture-log',
    );
    check(
      parsed.identifiers.length === 2 && parsed.unrecognized.length === 0,
      '合法诊断词包名被误拒',
    );
    const state = services.runtime.devices.snapshot();
    const first = state.selected;
    check(first, '所选设备缺失');
    const wrongVersion = {
      ...state,
      selected: {
        ...first,
        capabilities: first.capabilities.map((item) => ({ ...item, version: 2 })),
      },
    };
    check(
      !capabilityGate(wrongVersion, fixture.allOperations, 'packages').capability,
      'availability 版本不匹配仍准入',
    );
    passed('合法包名与精确 availability 版本');
    fixture.hold('fixture.second.packages');
    await click('读取应用列表');
    await until(() => fixture.pending() > 0, '旧代次任务未进入等待');
    services.runtime.devices.invalidateProvider('fixture.second');
    await pause();
    fixture.release();
    await pause();
    check(
      button('读取应用列表').disabled && !target.querySelector('tbody'),
      '提供者撤销后仍保留旧操作与数据',
    );
    passed('提供者撤销收敛入口与旧结果');
    await services.runtime.devices.refreshDirectories(signal);
    services.runtime.devices.select(null);
    await mount(DevicesConnect);
    await select('连接提供者', 'fixture.first · 扩展甲 · generation-1');
    await fill('设备连接地址', '127.0.0.1:5555');
    await click('连接地址');
    await until(() => !target.textContent?.includes('正在等待真实结果'), '提供者连接未结束');
    const connected = lastAction();
    check(
      object(connected) && connected['device_id'] === null && connected['capability'] === 'connect',
      '提供者连接错误携带设备身份',
    );
    const beforeDisconnect = actions().length;
    await click('断开地址');
    check(actions().length === beforeDisconnect, '打开断开弹窗已提交');
    await click('保持连接');
    await click('断开地址');
    await click('确认断开');
    await until(() => !target.textContent?.includes('正在等待真实结果'), '提供者断开未结束');
    const disconnected = lastAction();
    check(
      object(disconnected) &&
        disconnected['device_id'] === null &&
        disconnected['capability'] === 'disconnect',
      '提供者断开字段不兼容',
    );
    passed('无选中设备的提供者连接与确认断开');
    await mount(DeviceApps);
    await fill('安装包产物 ID', fixtureArtifact);
    await click('运行清单');
    await until(() => target.textContent?.includes('受控安装包') ?? false, '包清单没有专用结果');
    const manifest = submitted().at(-1)?.input;
    check(
      object(manifest) &&
        manifest['operation'] === 'plugin.android-packages.manifest' &&
        object(manifest['input']) &&
        manifest['input']['artifact_id'] === fixtureArtifact,
      '包分析表单没有真实产物字段',
    );
    check(target.textContent?.includes('fixture-log'), '成功包分析没有显示日志');
    passed('包清单表单、专用结果与日志');
    fixture.hold('plugin.android-packages.manifest');
    await click('运行清单');
    await until(() => fixture.pending() > 0, '包分析未进入任务等待');
    await click('取消等待');
    await until(() => !target.textContent?.includes('正在等待真实结果'), '客户端取消没有结束等待');
    fixture.release();
    await pause();
    check(
      !fixture.requests.some((item) => item.path.endsWith('/cancel')),
      '取消等待错误取消了服务器任务',
    );
    passed('取消客户端等待保留服务器任务语义');
    await mount(FilesPage);
    await fill('公开产物 ID', fixtureArtifact);
    await click('读取文件元数据');
    await until(() => target.textContent?.includes('fixture.zip') ?? false, '产物元数据没有显示');
    await fill('每页条目', '2');
    await click('读取目录');
    await until(() => target.querySelectorAll('tbody tr').length === 2, 'ZIP 目录没有分页');
    await click('下一页');
    await until(
      () => target.textContent?.includes('third.apk') ?? false,
      'ZIP 下一页没有真实剩余条目',
    );
    const lastEntries = fixture.requests.filter((item) => item.path.includes('/entries')).at(-1);
    check(
      lastEntries?.path.includes('offset=2') && lastEntries.path.includes('limit=2'),
      'ZIP 分页参数丢失',
    );
    await click('下载原文件');
    await until(() => !target.textContent?.includes('正在等待真实结果'), '原文件下载未结束');
    check(
      fixture.requests.some((item) => item.path.endsWith('/content')),
      '原字节下载没有调用产物内容入口',
    );
    const beforeDelete = fixture.requests.filter((item) => item.method === 'DELETE').length;
    await click('删除产物');
    check(
      document.querySelector('[role="dialog"]')?.textContent?.includes(fixtureArtifact),
      '文件删除确认缺少真实身份',
    );
    const dialog = document.querySelector('[role="dialog"]');
    check(dialog instanceof HTMLElement, '文件删除弹窗没有官方对话框节点');
    check(dialog.contains(document.activeElement), '打开删除弹窗后焦点没有进入弹窗');
    dialog.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }),
    );
    await until(() => !document.querySelector('[role="dialog"]'), 'Esc 没有关闭文件删除弹窗');
    await until(
      () => document.activeElement === button('删除产物'),
      'Esc 关闭后焦点没有返回删除产物按钮',
    );
    check(
      fixture.requests.filter((item) => item.method === 'DELETE').length === beforeDelete,
      'Esc 关闭弹窗仍提交删除',
    );
    passed('文件删除弹窗 Esc 关闭恢复触发按钮焦点');
    await click('删除产物');
    await click('保留文件');
    check(
      fixture.requests.filter((item) => item.method === 'DELETE').length === beforeDelete,
      '取消删除仍提交',
    );
    await click('删除产物');
    await click('确认删除');
    await until(
      () => fixture.requests.filter((item) => item.method === 'DELETE').length === beforeDelete + 1,
      '确认删除未提交',
    );
    passed('文件元数据、ZIP 分页、原字节下载与删除确认');
    await mount(AnalysisPage);
    await fill('分析产物 ID', fixtureArtifact);
    await tab('MessagePack');
    await fill('记录页长', '2');
    await click('读取此页');
    await until(() => target.querySelectorAll('tbody tr').length === 2, 'MessagePack 首分页未显示');
    await click('下一页');
    await until(
      () =>
        target.querySelectorAll('tbody tr').length === 1 &&
        (target.textContent?.includes('丙') ?? false),
      'MessagePack 下一页不正确',
    );
    const msgpack = submitted().at(-1)?.input;
    check(
      object(msgpack) &&
        object(msgpack['input']) &&
        msgpack['input']['offset'] === 2 &&
        msgpack['input']['limit'] === 2,
      'MessagePack 分页表单参数不兼容',
    );
    passed('MessagePack 真实记录与分页输入');
    await tab('表格导入');
    await click('读取工作簿');
    await until(
      () => target.textContent?.includes('工作表一') ?? false,
      '工作簿没有提供真实工作表选择',
    );
    await click('读取当前页');
    await until(() => target.querySelectorAll('tbody tr').length === 2, '表格页未显示');
    check(
      target.textContent?.includes('false') && target.textContent.includes('0'),
      '表格吞掉 0 或 false',
    );
    await fill('目标必填字段', 'count,enabled');
    await click('核对当前页映射');
    await until(
      () => target.textContent?.includes('当前页数据已具备映射资格') ?? false,
      '表格映射误将 0 与 false 判空',
    );
    passed('表格真实表头、当前页映射与 0/false');
    await mount(ToolsPage);
    await click('刷新工具目录');
    await until(() => target.querySelectorAll('tbody tr').length === 1, '工具目录没有专用表格');
    await click('规划全部清单模块');
    await until(() => target.textContent?.includes('更新计划') ?? false, '工具计划未显示');
    const beforeRemove = submitted().length;
    await click('移除');
    await click('保留工具');
    check(submitted().length === beforeRemove, '工具取消移除仍提交');
    await click('移除');
    await click('确认移除');
    await until(() => target.textContent?.includes('未安装') ?? false, '移除后未重读工具目录');
    await click('安装 / 修复');
    await until(() => target.textContent?.includes('当前版本') ?? false, '安装后未重读工具目录');
    passed('工具计划、官方移除确认与安装后真实目录刷新');
    await mount(TasksPage);
    await until(
      () => target.querySelectorAll('.task-row').length >= 2,
      '任务页未显示成功产物任务夹具',
    );
    const firstFile = fixtureTaskFiles[0];
    const secondFile = fixtureTaskFiles[1];
    check(firstFile && secondFile, '成功产物任务夹具缺失');
    async function openTask(jobId: string) {
      const task = [...target.querySelectorAll('button.task-name')].find((item) =>
        item.textContent?.includes(jobId),
      );
      check(task instanceof HTMLButtonElement, `没有找到产物任务：${jobId}`);
      task.click();
      await until(
        () =>
          task.getAttribute('aria-expanded') === 'true' &&
          !target.textContent?.includes('正在等待真实结果'),
        '产物任务未展开完成',
      );
    }
    await openTask(firstFile.jobId);
    await click(`${firstFile.filename} · ${firstFile.bytes.length} 字节`);
    await until(
      () =>
        [...target.querySelectorAll('a[download]')].some(
          (item) => item.textContent === `保存 ${firstFile.filename}`,
        ),
      '任务产物校验后没有保存链接',
    );
    const firstLink = target.querySelector('a[download]');
    check(firstLink instanceof HTMLAnchorElement, '任务产物没有实际保存链接');
    check(
      firstLink.download === firstFile.filename && firstLink.href.startsWith('blob:'),
      '任务保存链接没有保留文件名与 Blob 原字节',
    );
    check(
      fixture.requests.some(
        (item) =>
          item.path === `/api/v2/artifacts/${firstFile.artifactId}/content` &&
          item.method === 'GET',
      ),
      '任务文件没有调用真实产物内容入口',
    );
    const firstBytes = new Uint8Array(await (await fetch(firstLink.href)).arrayBuffer());
    check(
      JSON.stringify([...firstBytes]) === JSON.stringify(firstFile.bytes),
      '任务保存链接原字节发生变化',
    );
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', firstBytes))]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
    check(
      digest === firstFile.sha256 && firstBytes.length === firstFile.bytes.length,
      '任务下载没有保持大小与 SHA-256',
    );
    const oldHref = firstLink.href;
    passed('成功任务展开、产物原字节与 SHA-256 保存链接');
    await openTask(secondFile.jobId);
    check(
      !target.querySelector('a[download]') &&
        !target.textContent?.includes(`保存 ${firstFile.filename}`),
      '切换任务后旧文件保存链接仍可见',
    );
    let oldLinkRevoked = false;
    try {
      await fetch(oldHref);
    } catch {
      oldLinkRevoked = true;
    }
    check(oldLinkRevoked, '切换任务后旧 Blob 文件链接没有撤销');
    await click(`${secondFile.filename} · ${secondFile.bytes.length} 字节`);
    await until(
      () =>
        [...target.querySelectorAll('a[download]')].some(
          (item) => item.textContent === `保存 ${secondFile.filename}`,
        ),
      '切换后新任务没有独立保存链接',
    );
    const secondLink = target.querySelector('a[download]');
    check(
      secondLink instanceof HTMLAnchorElement &&
        secondLink.href !== oldHref &&
        secondLink.download === secondFile.filename,
      '第二任务复用了旧文件链接或名称',
    );
    check(
      JSON.stringify([...new Uint8Array(await (await fetch(secondLink.href)).arrayBuffer())]) ===
        JSON.stringify(secondFile.bytes),
      '切换后新任务产物字节不正确',
    );
    passed('切换任务撤销旧 Blob 链接并独立保存新文件');
    return {
      passed: true,
      checks,
      requests: fixture.requests,
      scope: '真实浏览器 DOM 与受控 API 夹具；不含 Rust 服务、真实设备、视觉审核或生产性能',
    };
  } finally {
    fixture.release();
    root.unmount();
    target.remove();
    await services.dispose();
  }
}
