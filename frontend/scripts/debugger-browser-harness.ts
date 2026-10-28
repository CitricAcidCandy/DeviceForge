import { createFrontendRuntime, createNamedSlotAdapter } from '../src/app/public-runtime.ts';
import { installPublicUi } from '../src/app/public-ui.ts';
import { createInstalledPackageImporter } from '../src/app/installed-package-importer.ts';
import { pageSlotId } from '../src/plugin-sdk/index.ts';
import type { JsonValue } from '../src/plugin-sdk/index.ts';
import { debuggerFixtureIds as ids, debuggerJson, debuggerLoopback, debuggerObject as obj,
  debuggerReceipt, debuggerRecords as rows, debuggerText as text } from './debugger-fixture-contract.ts';
import '../src/app/styles.css';

let runtime: ReturnType<typeof createFrontendRuntime> | null = null;
let slots: Awaited<ReturnType<typeof createNamedSlotAdapter>> | null = null;
let releaseUi: ReturnType<typeof installPublicUi> | null = null;
const sessions = new Set<string>();
const checks: { name: string; details: JsonValue }[] = [];
let pick: Promise<Record<string, unknown>> | null = null;
let selectedSession = '';
let selectedRoot = '';
let oldNode: JsonValue = null;
let beforeSnapshot = '';
const signal = () => AbortSignal.timeout(15000);
function current() { if (!runtime) throw new Error('浏览器验收尚未挂载'); return runtime; }
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function rejectionCode(error: unknown) {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
}
const record = (name: string, details: unknown = {}) => checks.push({ name, details: debuggerJson(details) });
async function until(condition: () => boolean, message: string) {
  const deadline = Date.now() + 12000;
  while (!condition() && Date.now() < deadline) await new Promise<void>((done) => setTimeout(done, 40));
  check(condition(), message);
}
async function service(action: string, fields: Record<string, JsonValue> = {}) {
  const extensions = current().host.extensions; check(extensions, '缺少宿主公开扩展服务');
  const budget = action === 'call' && fields['name'] === 'deviceforge.debug_reload'
    ? AbortSignal.timeout(45000) : signal();
  return extensions.callService('host.debugger', '1', { action, ...fields }, budget);
}
export async function call(name: string, input: JsonValue) {
  const result = await service('call', { name: `deviceforge.debug_${name}`, input });
  return { data: debuggerReceipt(result.data), logId: result.logId };
}
async function command(name: string, parameters: JsonValue = {}, session = selectedSession) {
  return (await call(name, { session_id: session, parameters })).data;
}
function ref(node: Record<string, unknown>): JsonValue {
  return debuggerJson({ id: node['id'], generation: node['generation'], revision: node['revision'] });
}
export function snapshot() { return { checks: [...checks], bridge: current().debugger?.snapshot(), sessions: [...sessions] }; }

export async function mount(base: string) {
  debuggerLoopback(base);
  check(!runtime, '不允许重复创建运行实例');
  releaseUi = installPublicUi();
  const main = document.createElement('main'); main.dataset.debuggerAcceptance = '';
  const target = (name: string) => {
    const node = document.createElement('section'); node.setAttribute('aria-label', name); main.append(node); return node;
  };
  const panels = target('独立插件面板');
  const append = target('追加槽'), replace = target('替换槽'), page = target('页面槽'), tools = target('开发者工具槽');
  document.body.replaceChildren(main);
  const defaultContent = (root: HTMLElement) => { root.textContent = '受控默认内容'; return () => root.replaceChildren(); };
  slots = await createNamedSlotAdapter([
    { id: 'debugger.fixture.append', target: append, renderDefault: defaultContent },
    { id: 'debugger.fixture.replace', target: replace, renderDefault: defaultContent },
    { id: pageSlotId(ids.provider, '/debugger-fixture'), target: page },
    { id: 'developer.tools', target: tools },
  ]);
  runtime = createFrontendRuntime({ baseUrl: base, transport: window.fetch.bind(window), panelTarget: () => panels, slotAdapter: slots,
    esmImporter: createInstalledPackageImporter(base),
    packageEntryResolver: (info, runId) => `/api/v2/browser-plugins/${encodeURIComponent(info.id)}/runs/${runId}/assets/${info.entryPath}`,
    developerTools: true, debugger: { document,
      slots: [
        { id: 'debugger.fixture.append', label: '追加槽', modes: ['append'], description: '受控追加' },
        { id: 'debugger.fixture.replace', label: '替换槽', modes: ['replace'], description: '受控替换' },
      ],
    } });
  check(runtime.debugger, '冻结前端没有新调试器底座');
  await service('start');
  record('独立工厂显式启动桥', runtime.debugger.snapshot());
}
export async function enable() {
  const host = current();
  await host.pluginPackages.refresh('browser', signal());
  for (const id of [ids.provider, ids.consumer, ids.official]) await host.pluginPackages.enable('browser', id, signal());
  await host.webPlugins.mount(ids.provider, `${ids.provider}.panel`);
  await host.webPlugins.mount(ids.consumer, `${ids.consumer}.panel`);
  for (const mode of ['append', 'replace']) await host.extensions.mountComponent(`${ids.provider}.${mode}`);
  await host.extensions.mountModule(`${ids.provider}.page`);
  await until(() => !!document.querySelector('[data-deviceforge-debugger]'), '官方 Debugger 未通过 developer.tools 自动挂载');
  for (const id of [ids.provider, ids.consumer, ids.official]) await target(id);
  const before = await call('targets', {});
  const instanceId = text(host.debugger?.snapshot().instanceId);
  const instances = rows(before.data['browser_instances']);
  check(instances.length === 1 && instances[0]?.['instance_id'] === instanceId, '受控宿主中实例必须明确且唯一');
  check(instances[0]?.['active_sessions'] === 0, '未选择目标时不得自行打开会话');
  check(document.querySelector('[aria-label="追加槽"] [data-deviceforge-default-slot]'), 'append 未保留默认内容');
  check(!document.querySelector('[aria-label="替换槽"] [data-deviceforge-default-slot]'), 'replace 未替换默认内容');
  record('独立两插件与官方包原入口装载', { instance_id: instanceId, plugins: [ids.provider, ids.consumer, ids.official] });
  let rejected = false;
  try { await call('ui_tree', { session_id: 'no-selection-acceptance', parameters: {} }); }
  catch (error) { rejected = /^debugger_(?:session_not_found|inactive_session|session_unavailable|not_found)$/.test(rejectionCode(error)); }
  check(rejected, '未明确选择目标仍能采集');
  record('无选择拒绝采集且零活动会话');
}
export async function enableSecondary() {
  await current().pluginPackages.refresh('browser', signal());
  await current().pluginPackages.enable('browser', ids.provider, signal());
  await current().webPlugins.mount(ids.provider, `${ids.provider}.panel`);
  const selected = await target();
  const opened = (await call('session', { action: 'open', target: selected })).data;
  const session = text(opened['session_id']); sessions.add(session);
  const inspected = await command('inspect', {}, session);
  check(rows(inspected['roots']).length === 1, '第二标签页不应混入第一标签页的其余挂载');
  return { target: selected, session_id: session, inspection: inspected };
}
export async function target(pluginId: string = ids.provider) {
  const instance = text(current().debugger?.snapshot().instanceId);
  const expected = current().webPlugins.diagnosticSnapshot().find((entry) => entry.id === pluginId);
  check(expected, '目标没有本地运行代次');
  const deadline = Date.now() + 12000;
  // 只刷新目录等待正常心跳登记；不重复打开会话或重放任何动作。
  do {
    const directory = (await call('targets', {})).data;
    const matches = rows(directory['browser_targets']).filter((item) => item['instance_id'] === instance &&
      item['plugin_id'] === pluginId && item['generation'] === String(expected.generation));
    if (matches.length === 1 && matches[0]) return debuggerJson(matches[0]);
    await new Promise<void>((done) => setTimeout(done, 100));
  } while (Date.now() < deadline);
  throw new Error('目标必须包含本实例、插件与当前代次，登记等待已到期');
}
export async function select(pluginId: string = ids.provider) {
  const result = (await call('session', { action: 'open', target: await target(pluginId) })).data;
  selectedSession = text(result['session_id']); sessions.add(selectedSession);
  const inspected = await command('inspect');
  check(inspected['registration_failures'] === 0, '当前插件有语义或资源登记失败');
  check(!JSON.stringify(inspected).includes('挂载前未选事件'), '未选择时的事件被追溯采集');
  const roots = rows(inspected['roots']);
  check(roots.length === (pluginId === ids.provider ? 4 : 1), 'panel、append、replace、page 挂载根覆盖不足');
  selectedRoot = text(roots.find((root) => root['contribution_id'] === `${pluginId}.panel`)?.['root_id']);
  record('显式实例目标与四类挂载根', { target: await target(pluginId), roots });
  return selectedSession;
}
export async function structureAndActions() {
  const initial = await command('ui_tree', { root_id: selectedRoot });
  const tree = obj(initial['tree']); beforeSnapshot = text(tree['id']);
  const nodes = rows(tree['nodes']);
  check(!JSON.stringify(tree).includes('仅供检查脱敏的合成口令'), '结构树泄露合成口令');
  const local = nodes.find((node) => node['name'] === '本地计数'); check(local, '结构树没有本地按钮');
  oldNode = ref(local);
  const high = await command('ui_action', { root_id: selectedRoot, action: { type: 'highlight', target: oldNode } });
  check(high['status'] === 'applied', '高亮没有应用');
  const root = document.querySelector(`[data-deviceforge-panel="${ids.provider}.panel"]`); check(root, '提供者根不存在');
  check(root.querySelector('button')?.classList.contains('outline-2'), '高亮类没有落入目标');
  record('树查询与高亮', { root_id: selectedRoot, snapshot_id: beforeSnapshot });
  for (const name of ['禁用动作', '设备动作', '只读动作', '未知动作', '本地计数']) {
    const query = await command('ui_query', { root_id: selectedRoot, query: { role: 'button', name } });
    const node = rows(query['nodes'])[0]; check(node, '受限动作目标缺失：' + name);
    const action = await command('ui_action', { root_id: selectedRoot,
      action: { type: 'click', target: ref(node), confirmed: name !== '本地计数' } });
    check(action['status'] === 'rejected', '受限节点动作未拒绝：' + name);
  }
  check(root.querySelector('output')?.textContent === '', '拒绝动作仍产生业务计数');
  record('禁用设备只读未知及未确认节点拒绝');
  // 查询与动作也会采集当前状态；只保留十份快照，差异基线应紧邻待验证动作。
  beforeSnapshot = text(obj((await command('ui_tree', { root_id: selectedRoot }))['tree'])['id']);
  const fresh = await command('ui_query', { root_id: selectedRoot, query: { name: '本地计数', role: 'button' } });
  const node = rows(fresh['nodes'])[0]; check(node, '本地按钮缺失');
  const applied = await command('ui_action', { root_id: selectedRoot, action: { type: 'click', target: ref(node), confirmed: true } });
  check(applied['status'] === 'dispatched' && root.querySelector('output')?.textContent === '1', '本地动作及可见业务结果不一致');
  const assertion = await command('ui_assert', { root_id: selectedRoot, assertion: { query: { name: '计数1' }, condition: 'exists' } });
  check(assertion['status'] === 'passed', '结构断言未通过');
  const after = obj((await command('ui_tree', { root_id: selectedRoot }))['tree']);
  const diff = await command('ui_diff', { root_id: selectedRoot, before_id: beforeSnapshot, after_id: text(after['id']) });
  check(diff['status'] === 'indeterminate' && typeof diff['reason'] === 'string' && diff['reason'].includes('覆盖不完整') &&
    rows(diff['changed']).length + rows(diff['added']).length > 0 && rows(diff['removed']).length === 0,
  '含密码不透明节点时应保留实际变更，但不能冒充完整可比较或确认删除');
  record('确认本地动作结构断言与快照差异', { assertion, diff });
}
export async function beginPick() {
  check(!pick, '不允许重复拾取');
  pick = command('ui_action', { root_id: selectedRoot, action: { type: 'pick' } });
  // 驱动在同一页面随后点击，启动方法本身不等待用户事件。
  void pick.catch(() => undefined);
}
export async function finishPick() {
  check(pick, '拾取没有开始');
  await until(() => (current().debugger?.snapshot().inflight ?? 0) > 0, '拾取未进入本机桥');
  await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  const root = document.querySelector(`[data-deviceforge-panel="${ids.provider}.panel"]`); check(root, '拾取目标根缺失');
  const button = root.querySelector('button'); check(button, '拾取按钮缺失');
  const before = root.querySelector('output')?.textContent;
  button.click();
  const result = await pick; pick = null;
  check(result['status'] === 'picked' && obj(result['owner'])['pluginId'] === ids.provider, '拾取没有返回当前所有者');
  check(root.querySelector('output')?.textContent === before, '拾取穿透执行了业务点击');
  record('一次拾取拦截且不触发业务', result);
}
export async function invokeService(consumer = false) {
  if (consumer) await select(ids.consumer);
  const result = await command('invoke', { kind: consumer ? 'command' : 'service',
    id: consumer ? `${ids.consumer}.consume` : ids.service,
    ...(consumer ? {} : { version: '1' }),
    input: { message: consumer ? '独立消费者' : '公开服务试调用', value: 42 },
    confirmed: true, allow_unknown_side_effects: true, include_result: true });
  const data = obj(result['data']), job = obj(data['job']);
  const jobId = text(job['id']), logId = text(result['logId']);
  check(data['submission_log_id'] === logId, '服务试调用丢失原始提交日志 ID');
  const original = await current().host.getJob(jobId, signal());
  check(original.data.id === jobId && original.data.operation === ids.operation && original.data.status === 'succeeded', '服务结果不是原 Job');
  let logs: Record<string, unknown> = {};
  const deadline = Date.now() + 5000;
  do {
    logs = obj((await service('logs', { input: { log_id: logId, order: 'asc' } })).data);
    if (rows(logs['entries']).length > 0 && JSON.stringify(logs).includes(jobId)) break;
    await new Promise<void>((done) => setTimeout(done, 100));
  } while (Date.now() < deadline);
  check(rows(logs['entries']).length > 0 && JSON.stringify(logs).includes(jobId), '公开日志查询没有关联原 Job');
  record(consumer ? '独立消费者服务组合关联原任务日志' : '服务试调用关联原任务日志', { job_id: jobId, log_id: logId, logs });
}

export async function inspectServerAndInvoke() {
  const directory = (await call('targets', {})).data;
  const plugin = rows(directory['server_plugins']).find((item) => item['id'] === 'online_echo_v2');
  check(plugin, '受控服务器插件不在真实目录中');
  const target = debuggerJson({ target_kind: 'server', instance_id: null, plugin_id: plugin['id'],
    generation: plugin['generation'], version: plugin['version'] });
  const opened = (await call('session', { action: 'open', target })).data;
  const session = text(opened['session_id']); sessions.add(session);
  try {
    const inspected = await command('inspect', {}, session);
    check(JSON.stringify(inspected).includes(ids.operation), '服务器检查没有返回所属操作');
    const invoked = await command('invoke', { kind: 'operation', id: ids.operation,
      input: { message: '显式服务器试调用', value: 73 }, confirmed: true,
      allow_unknown_side_effects: true }, session);
    const jobId = text(invoked['job_id']);
    let finished = false;
    const deadline = Date.now() + 5000;
    while (!finished && Date.now() < deadline) {
      const original = await current().host.getJob(jobId, signal());
      check(original.data.operation === ids.operation, '服务器试调用绕过了原操作');
      finished = original.data.status === 'succeeded';
      if (!finished) await new Promise<void>((done) => setTimeout(done, 50));
    }
    check(finished, '服务器试调用没有沿原 Job 结束');
    const exported = await command('report', { export: 'markdown' }, session);
    const artifact = obj(exported['artifact']), metadata = obj(artifact['metadata']);
    const downloaded = await current().artifacts.download(text(metadata['id']), signal());
    check((await downloaded.data.text()).includes('online_echo_v2'), 'Markdown 报告没有实际目标');
    const reloaded = await command('reload', { confirmed: true, follow: false, timeout_ms: 30000 }, session);
    check(JSON.stringify(reloaded).includes('online_echo_v2'), '服务器重载没有返回本次目标');
    const after = rows((await call('targets', {})).data['server_plugins'])
      .find((item) => item['id'] === 'online_echo_v2');
    check(after && after['generation'] !== plugin['generation'], '服务器重载没有产生新代');
    record('服务器公开检查试调用原任务与真实报告重载', { job_id: jobId, report: exported, reload: reloaded });
  } finally {
    await call('session', { action: 'close', session_id: session }); sessions.delete(session);
  }
}
export async function report() {
  const result = await command('report', { export: 'json' });
  const report = obj(result['report']), artifact = obj(result['artifact']);
  check(obj(report['target'])['plugin_id'] === ids.provider, '报告目标与所选插件不一致');
  const metadata = obj(artifact['metadata']);
  const downloaded = await current().artifacts.download(text(metadata['id']), signal());
  const content = obj(JSON.parse(await downloaded.data.text()));
  check(obj(content['target'])['plugin_id'] === ids.provider && JSON.stringify(content) === JSON.stringify(report), '原产物内容与报告证据不一致');
  record('报告持久化与原产物下载', { report, artifact, downloaded: debuggerJson(downloaded.logId) });
  return debuggerJson(result);
}
export async function beforeUpdate() {
  await closeSessions(); await select();
  const tree = obj((await command('ui_tree', { root_id: selectedRoot }))['tree']);
  const local = rows(tree['nodes']).find((node) => node['name'] === '本地计数'); check(local, '更新前节点缺失');
  oldNode = ref(local);
  return { session_id: selectedSession, target: await target(), node: oldNode };
}
export async function reloadBrowserExplicitly() {
  const previous = await target();
  const result = await command('reload', { confirmed: true, follow: true, timeout_ms: 30000 });
  const receipt = obj(result['command']);
  check(receipt['state'] === 'succeeded' && result['followed'] === true, '浏览器重载未取得新代跟随回执');
  const next = await target();
  check(obj(next)['generation'] !== obj(previous)['generation'], '浏览器重载没有新代次');
  await current().webPlugins.mount(ids.provider, `${ids.provider}.panel`);
  for (const mode of ['append', 'replace']) await current().extensions.mountComponent(`${ids.provider}.${mode}`);
  await current().extensions.mountModule(`${ids.provider}.page`);
  await closeSessions(); await select();
  record('浏览器重载使用当前安装源并显式跟随新代', { previous, next, result });
}
export async function update(base64: string) {
  const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
  await current().pluginPackages.update('browser', ids.provider, new Blob([bytes]), 'application/zip', signal());
  await current().pluginPackages.enable('browser', ids.provider, signal());
  await current().webPlugins.mount(ids.provider, `${ids.provider}.panel`);
  for (const mode of ['append', 'replace']) await current().extensions.mountComponent(`${ids.provider}.${mode}`);
  await current().extensions.mountModule(`${ids.provider}.page`);
  await target();
  let oldRejected = false;
  try { await command('ui_action', { root_id: selectedRoot, action: { type: 'click', target: oldNode, confirmed: true } }); }
  catch (error) { oldRejected = /^debugger_(?:target_changed|stale_target|stale_generation|inactive_session|target_not_selected|session_inactive)$/.test(rejectionCode(error)); }
  check(oldRejected, '更新后的旧会话仍能操作旧节点');
  const previous = oldNode;
  await closeSessions(); await select();
  const stale = await command('ui_action', { root_id: selectedRoot, action: { type: 'click', target: previous, confirmed: true } });
  check(stale['status'] === 'rejected', '更新后新会话未拒绝旧节点引用');
  check(obj(await target())['version'] === '1.0.1', '目录没有更新到新构建');
  record('更新换代后旧会话与旧节点拒绝', { stale, target: await target() });
}
export async function focusOfficial() {
  await closeSessions();
  await until(() => current().debugger?.snapshot().activeSessions === 0, '旧受控会话未结束');
  await service('focus', { input: { target_kind: 'browser', plugin_id: ids.provider } });
  const choose = () => [...document.querySelectorAll('[data-deviceforge-debugger] article')]
    .find((item) => item.querySelector('h3')?.textContent === ids.provider)?.querySelector('button');
  await until(() => !!choose() && !choose()?.disabled, '官方面板没有当前实例目标的明确选择控件');
  check(current().debugger?.snapshot().activeSessions === 0, 'focus 带入候选时擅自打开采集会话');
  choose()?.click();
  await until(() => (current().debugger?.snapshot().activeSessions ?? 0) > 0, '官方面板明确选择后未打开目标会话');
  const official = document.querySelector('[data-deviceforge-debugger]'); check(official, '官方面板节点不存在');
  check(official.textContent?.trim(), '官方面板内容为空');
  await until(() => {
    const roots = official.querySelector<HTMLSelectElement>('[aria-label="挂载根"]');
    return !!roots && [...roots.options].some(item => item.text.includes(`${ids.provider}.panel`));
  }, '官方面板检查结束后仍未列出真实面板挂载根');
  const rootSelect = official.querySelector<HTMLSelectElement>('[aria-label="挂载根"]');
  check(rootSelect, '官方面板没有公开挂载根选择器');
  const option = [...rootSelect.options].find(item => item.text.includes(`${ids.provider}.panel`));
  check(option, '官方面板未列出真实面板挂载根');
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  check(setter, '浏览器没有原生选择器值入口');
  setter.call(rootSelect, option.value); rootSelect.dispatchEvent(new Event('change', { bubbles: true }));
  const readTree = () => [...official.querySelectorAll('button')].find(node => node.textContent === '读取新快照');
  await until(() => !!readTree() && !readTree()?.disabled, '选择挂载根后快照读取仍不可用');
  readTree()?.click();
  await until(() => official.querySelectorAll('[role="treeitem"]').length > 0, '官方面板没有显示实际树快照');
  const selected = [...official.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')].find(node => node.textContent?.includes('本地计数'));
  check(selected, '官方树没有实际业务按钮'); selected.click();
  await until(() => !!official.querySelector('[aria-label="节点详情"]')?.textContent?.includes('本地计数'), '节点详情没有当前选择');
  const list = official.querySelector<HTMLElement>('[role="tree"]'); check(list, '树列表缺失');
  await until(() => {
    const row = selected.getBoundingClientRect(), area = list.getBoundingClientRect();
    return list.clientHeight >= 160 && row.top >= area.top && row.bottom <= area.bottom;
  }, '树的有效高度不足，或当前选择不在树自身可视区域中');
  record('树列表保留至少160像素且当前选择可见', { height: list.clientHeight });
  record('官方公开focus入口显式目标会话');
}
export function officialGeometry() {
  const root = document.querySelector('[data-deviceforge-debugger]'); check(root, '官方调试器根不存在');
  const panel = root.querySelector('[role="dialog"]'); check(panel, '官方调试面板未展开');
  const resize = root.querySelector('[aria-label="拖动调整调试面板尺寸"]'); check(resize, '调尺寸控件不存在');
  const rect = panel.getBoundingClientRect(), handle = resize.getBoundingClientRect();
  check(rect.width > 0 && rect.height > 0, '调试面板没有实际布局尺寸');
  check(rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
    '调试面板超出当前窗口');
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
    drag: { x: rect.x + Math.min(260, rect.width / 3), y: rect.y + 24 },
    resize: { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 } };
}
export function officialControl(action: 'collapse' | 'open' | 'keyboard') {
  const root = document.querySelector('[data-deviceforge-debugger]'); check(root, '官方调试器根不存在');
  const button = action === 'keyboard'
    ? [...root.querySelectorAll('button')].find((node) => node.textContent === '键盘调尺寸')
    : root.querySelector<HTMLButtonElement>(`[aria-label="${action === 'collapse' ? '收起调试器，保留会话' : '打开调试器'}"]`);
  check(button, '调试器控件不存在：' + action); button.focus(); button.click();
  record('官方面板显式控件', { action });
}
export async function unloadOfficial() {
  check(document.querySelector('[data-deviceforge-debugger]'), '官方面板卸载前不存在');
  await current().pluginPackages.disable('browser', ids.official, signal());
  await until(() => !document.querySelector('[data-deviceforge-debugger]') &&
    (current().debugger?.snapshot().activeSessions ?? -1) === 0, 'Debugger 卸载后 DOM 或自身会话仍存活');
  const entries = current().extensions.catalog();
  check(!entries.components.some((entry) => entry.pluginId === ids.official), 'Debugger 贡献卸载后残留');
  check(current().webPlugins.diagnosticSnapshot().some((entry) => entry.id === ids.provider), '卸载 Debugger 影响了目标业务插件');
  record('Debugger卸载清理自身挂载贡献及会话');
}
export async function reconnectExplicitly() {
  const previous = text(current().debugger?.snapshot().instanceId);
  const generation = obj(await target())['generation'];
  const reconnected = await service('reconnect', { input: { confirmed: true } });
  const instance = text(current().debugger?.snapshot().instanceId);
  check(instance !== previous, '显式重连必须建立新实例');
  const next = await target();
  check(obj(next)['instance_id'] === instance && obj(next)['generation'] === generation,
    '重连不得重载业务插件或沿用旧实例引用');
  check(current().debugger?.snapshot().activeSessions === 0, '重连不能自动重放旧会话或动作');
  record('显式重连新实例且不重载业务不重放会话', { previous, instance, response: reconnected.data });
}
export async function closeSessions() {
  for (const id of [...sessions]) {
    try { await call('session', { action: 'close', session_id: id }); }
    finally { sessions.delete(id); }
  }
  selectedSession = ''; selectedRoot = '';
}
export async function dispose() {
  const failures: string[] = [];
  try { await closeSessions(); } catch (error) { failures.push(String(error)); }
  try { await runtime?.dispose(); } catch (error) { failures.push(String(error)); }
  try { await slots?.dispose(); } catch (error) { failures.push(String(error)); }
  try { await releaseUi?.(); } catch (error) { failures.push(String(error)); }
  releaseUi = null;
  runtime = null; slots = null; document.querySelector('[data-debugger-acceptance]')?.remove();
  check(failures.length === 0, failures.join('；'));
  return { disposed: true, checks };
}
