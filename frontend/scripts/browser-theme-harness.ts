import { createFrontendRuntime } from '/__production_host__';
import type { ThemeAccess, ThemeSnapshot } from '../src/plugin-sdk/index.ts';

const observationKey = Symbol.for('deviceforge.browser-theme-smoke.contexts');
const token = '--df-theme-smoke-color';
const extraToken = '--df-theme-smoke-extra';
const ids = { first: 'theme_probe_a', second: 'theme_probe_b', failing: 'theme_probe_fail' };
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function themeAccess(value: unknown): value is ThemeAccess {
  return (
    object(value) &&
    typeof value['snapshot'] === 'function' &&
    typeof value['select'] === 'function' &&
    typeof value['subscribe'] === 'function'
  );
}
interface Observation {
  readonly id: string;
  readonly kind: string;
  readonly run: string;
  readonly themes: ThemeAccess;
  readonly events: readonly unknown[];
}
function observation(value: unknown): value is Observation {
  return (
    object(value) &&
    typeof value['id'] === 'string' &&
    typeof value['kind'] === 'string' &&
    typeof value['run'] === 'string' &&
    themeAccess(value['themes']) &&
    Array.isArray(value['events'])
  );
}
function observed(
  records: readonly unknown[],
  id: string,
  kind: string,
  run?: string,
): Observation {
  const value = [...records]
    .reverse()
    .find(
      (item) =>
        observation(item) &&
        item.id === id &&
        item.kind === kind &&
        (run === undefined || item.run === run),
    );
  check(observation(value), '未取得上传包的真实公开主题上下文');
  return value;
}
function rejected(run: () => unknown, kind: string, code: string): void {
  let reason: unknown;
  try {
    run();
  } catch (error) {
    reason = error;
  }
  check(
    object(reason) && reason['kind'] === kind && reason['code'] === code,
    '主题调用没有精确公开错误：' + code,
  );
}
function generation(value: unknown): number {
  check(object(value) && typeof value['generation'] === 'number', '浏览器启用结果缺少代次');
  return value['generation'];
}
function styleState(target: HTMLElement, probe: HTMLElement) {
  return {
    tokenValue: target.style.getPropertyValue(token),
    tokenPriority: target.style.getPropertyPriority(token),
    extraValue: target.style.getPropertyValue(extraToken),
    extraPriority: target.style.getPropertyPriority(extraToken),
    schemeValue: target.style.getPropertyValue('color-scheme'),
    schemePriority: target.style.getPropertyPriority('color-scheme'),
    computedColor: getComputedStyle(probe).color,
    computedBorder: getComputedStyle(probe).borderTopWidth,
  };
}

export async function verifyThemes() {
  const checks: { name: string; passed: true }[] = [];
  const snapshots: ThemeSnapshot[] = [];
  const records: unknown[] = [];
  Reflect.set(globalThis, observationKey, records);
  const target = document.createElement('section');
  const probe = document.createElement('div');
  const panel = document.createElement('section');
  probe.className = 'theme-smoke-probe';
  probe.style.color = `var(${token})`;
  probe.style.border = '1px solid black';
  target.append(probe);
  target.style.setProperty(token, 'rgb(11, 22, 33)', 'important');
  target.style.setProperty('color-scheme', 'light', 'important');
  document.body.append(target, panel);
  const baseline = styleState(target, probe);
  const originalStyles = Array.from(document.querySelectorAll('style'));
  const signal = AbortSignal.timeout(45000);
  const options = {
    baseUrl: location.origin,
    transport: fetch.bind(globalThis),
    panelTarget: () => panel,
    esmImporter: async (url: string, current: AbortSignal) => {
      current.throwIfAborted();
      return import(/* @vite-ignore */ url);
    },
    packageEntryResolver: (
      info: { readonly id: string; readonly entryPath: string },
      runId: string,
    ) =>
      `/api/v2/browser-plugins/${encodeURIComponent(info.id)}/runs/${runId}/assets/${info.entryPath}`,
  };
  const runtime = createFrontendRuntime({ ...options, themeTarget: target });
  let disposed = false;
  const checkBaseline = (name: string) => {
    check(
      JSON.stringify(styleState(target, probe)) === JSON.stringify(baseline),
      name + ' 未精确恢复基线与 priority',
    );
    check(
      Array.from(document.querySelectorAll('style')).every((style) =>
        originalStyles.includes(style),
      ),
      name + ' 仍有主题样式节点',
    );
  };
  const archive = async (kind: keyof typeof ids) => {
    const response = await fetch(`/__fixture__/${kind}.tgz`, { signal });
    check(response.ok, '主题归档读取失败');
    return response.blob();
  };
  try {
    const withoutTarget = createFrontendRuntime(options);
    try {
      await withoutTarget.pluginPackages.upload(
        'browser',
        await archive('first'),
        'application/gzip',
        signal,
      );
      await withoutTarget.pluginPackages.enable('browser', ids.first, signal);
      check(
        withoutTarget.themes.snapshot().themes.some((theme) => theme.id === ids.first + '.main'),
        '无target时主题目录不可发现',
      );
      rejected(
        () => withoutTarget.themes.select(ids.first + '.main'),
        'protocol',
        'theme_unavailable',
      );
      withoutTarget.themes.select(null);
      await withoutTarget.pluginPackages.remove('browser', ids.first, signal);
      checkBaseline('无target运行');
      checks.push({ name: '未配置主题target仍可发现，非空选择精确拒绝，清除允许', passed: true });
    } finally {
      await withoutTarget.dispose();
    }
    const release = runtime.themes.subscribe((value) => snapshots.push(value));
    await runtime.pluginPackages.upload(
      'browser',
      await archive('first'),
      'application/gzip',
      signal,
    );
    const first = await runtime.pluginPackages.enable('browser', ids.first, signal);
    const firstGeneration = generation(first.data);
    const firstContext = observed(records, ids.first, 'plugin');
    check(firstContext.events.length >= 1, '主题订阅未取得初始快照');
    check(
      runtime.themes.snapshot().themes.some((theme) => theme.id === ids.first + '.dynamic'),
      '激活动态主题未注册',
    );
    check(runtime.themes.snapshot().selected === null, '加载主题擅自覆盖宿主基线');
    checkBaseline('加载未选择');
    runtime.themes.select(ids.first + '.main');
    const applied = styleState(target, probe);
    check(
      applied.tokenValue === 'rgb(71, 81, 91)' &&
        applied.tokenPriority === 'important' &&
        applied.extraValue === '本代主题变量' &&
        applied.extraPriority === 'important',
      '主题变量未覆盖 important 基线',
    );
    check(
      applied.schemeValue === 'dark' &&
        applied.schemePriority === 'important' &&
        applied.computedColor === 'rgb(71, 81, 91)' &&
        applied.computedBorder === '7px',
      '主题CSS/color-scheme未实际生效',
    );
    const selected = runtime.themes.snapshot().selected;
    check(
      selected?.pluginId === ids.first && selected.generation === firstGeneration,
      '主题目录缺少正确owner-generation',
    );
    checks.push({
      name: '真实上传包通过公开贡献改变变量、CSS、color-scheme和computed样式',
      passed: true,
    });
    await runtime.pluginPackages.upload(
      'browser',
      await archive('second'),
      'application/gzip',
      signal,
    );
    await runtime.pluginPackages.enable('browser', ids.second, signal);
    check(runtime.themes.snapshot().selected?.id === ids.first + '.main', '后加载主题覆盖显式选择');
    rejected(() => runtime.themes.select('unknown.theme'), 'protocol', 'theme_unavailable');
    check(
      JSON.stringify(styleState(target, probe)) === JSON.stringify(applied),
      '未知主题失败改变当前样式',
    );
    runtime.themes.select(ids.second + '.main');
    check(
      styleState(target, probe).computedColor === 'rgb(121, 131, 141)' &&
        styleState(target, probe).computedBorder === '9px',
      '显式切换主题失败',
    );
    runtime.themes.select(null);
    checkBaseline('显式清除');
    checks.push({ name: '多提供者显式选择、未知主题拒绝及切换清除恢复', passed: true });
    runtime.themes.select(ids.first + '.dynamic');
    check(
      styleState(target, probe).computedColor === 'rgb(1, 2, 3)' &&
        styleState(target, probe).schemeValue === 'normal',
      '动态主题未应用',
    );
    check(
      runtime.extensions
        .catalog()
        .commands.some((command) => command.id === ids.first + '.release_dynamic'),
      '主题验收命令未登记',
    );
    const dynamic = await runtime.extensions.executeCommand(
      ids.first + '.release_dynamic',
      {},
      signal,
    );
    check(
      dynamic.logId && object(dynamic.data) && dynamic.data['released'] === true,
      '上传包未通过公开命令释放动态主题',
    );
    check(
      !runtime.themes.snapshot().themes.some((theme) => theme.id === ids.first + '.dynamic') &&
        runtime.themes.snapshot().selected === null,
      '动态贡献释放后仍然选中或残留',
    );
    checkBaseline('动态贡献释放');
    checks.push({ name: '动态注册主题、实际选择及释放恢复', passed: true });
    await runtime.webPlugins.mount(ids.first, ids.first + '.panel');
    const childContext = observed(records, ids.first, 'panel', firstContext.run);
    childContext.themes.select(ids.second + '.main');
    check(styleState(target, probe).computedBorder === '9px', '子scope主题入口未调用公开主题');
    await runtime.webPlugins.unmount(ids.first, ids.first + '.panel');
    const childEventCount = childContext.events.length;
    rejected(() => childContext.themes.snapshot(), 'cancelled', 'plugin_unloaded');
    rejected(() => childContext.themes.select(ids.first + '.main'), 'cancelled', 'plugin_unloaded');
    rejected(() => childContext.themes.subscribe(() => undefined), 'cancelled', 'plugin_unloaded');
    runtime.themes.select(null);
    checkBaseline('子scope释放后宿主清除');
    check(childContext.events.length === childEventCount, '已撤销子scope继续收到主题订阅');
    checks.push({ name: '挂载子scope实际调用、unmount撤销入口和订阅', passed: true });
    runtime.themes.select(ids.first + '.main');
    const oldSnapshot = runtime.themes.snapshot();
    await runtime.pluginPackages.disable('browser', ids.first, signal);
    check(runtime.themes.snapshot().selected === null, '主题提供者停用后未回到基线');
    checkBaseline('停用恢复');
    rejected(() => firstContext.themes.select(ids.first + '.main'), 'cancelled', 'plugin_unloaded');
    rejected(() => firstContext.themes.snapshot(), 'cancelled', 'plugin_unloaded');
    rejected(() => firstContext.themes.subscribe(() => undefined), 'cancelled', 'plugin_unloaded');
    check(oldSnapshot.selected?.id === ids.first + '.main', '卸载前主题快照未保留');
    checks.push({ name: '显式选中主题卸载后撤销代际并恢复基线', passed: true });
    await runtime.pluginPackages.enable('browser', ids.first, signal);
    const reloaded = runtime.themes
      .snapshot()
      .themes.find((theme) => theme.id === ids.first + '.main');
    check(
      reloaded !== undefined && reloaded.generation !== firstGeneration,
      '主题重载未产生新owner代次',
    );
    const nextContext = observed(records, ids.first, 'plugin');
    check(nextContext.run !== firstContext.run, '重载复用旧在线模块');
    const oldEventCount = firstContext.events.length;
    nextContext.themes.select(ids.first + '.main');
    check(styleState(target, probe).computedBorder === '7px', '重载新代主题未生效');
    check(firstContext.events.length === oldEventCount, '旧代主题订阅收到新代通知');
    runtime.themes.select(null);
    checkBaseline('新代选择清除');
    const configurationTarget = { kind: 'browser', id: ids.first } as const;
    runtime.themes.select(ids.first + '.main');
    const currentConfiguration = await runtime.pluginConfigurations.get(configurationTarget, signal);
    check(currentConfiguration.definition?.apply_policy === 'plugin_reload', '在线主题未声明重载配置');
    const savedConfiguration = await runtime.pluginConfigurations.save(configurationTarget, currentConfiguration.revision,
      { color: 'rgb(51, 61, 71)', borderWidth: 13, colorScheme: 'light' }, signal);
    check(savedConfiguration.pendingReload, '主题配置保存后未标记待重载');
    check(styleState(target, probe).computedBorder === '7px', '仅保存配置改变了运行中主题');
    const appliedConfiguration = await runtime.pluginConfigurations.apply(configurationTarget, savedConfiguration.revision, signal);
    check(!appliedConfiguration.pendingReload, '主题成功激活后仍标记待重载');
    check(runtime.themes.snapshot().selected?.id === ids.first + '.main', '配置重载丢失有效选中主题');
    check(styleState(target, probe).computedColor === 'rgb(51, 61, 71)' &&
      styleState(target, probe).computedBorder === '13px' && styleState(target, probe).schemeValue === 'light', '重载主题未实际消费已保存配置');
    rejected(() => nextContext.themes.snapshot(), 'cancelled', 'plugin_unloaded');
    const resetConfiguration = await runtime.pluginConfigurations.reset(configurationTarget, appliedConfiguration.revision, signal);
    check(resetConfiguration.pendingReload, '恢复默认未标记待重载');
    await runtime.pluginConfigurations.apply(configurationTarget, resetConfiguration.revision, signal);
    check(runtime.themes.snapshot().selected?.id === ids.first + '.main' && styleState(target, probe).computedBorder === '7px', '恢复默认并重载未保留有效主题');
    runtime.themes.select(null);
    checkBaseline('主题配置重载后清除');
    checks.push({ name: '在线主题配置保存保留旧值、重载实际生效并保留有效选择、恢复默认', passed: true });
    await runtime.pluginPackages.upload(
      'browser',
      await archive('failing'),
      'application/gzip',
      signal,
    );
    let failed = false;
    try {
      await runtime.pluginPackages.enable('browser', ids.failing, signal);
    } catch {
      failed = true;
    }
    check(failed, '激活失败主题未失败');
    check(
      runtime.themes.snapshot().themes.every((theme) => theme.pluginId !== ids.failing),
      '激活失败残留主题目录',
    );
    checkBaseline('激活失败回滚');
    checks.push({ name: '激活失败回滚贡献及DOM样式', passed: true });
    const badListenerRelease = runtime.themes.subscribe(() => {
      throw new Error('监听器失败夹具');
    });
    runtime.themes.select(ids.second + '.main');
    await runtime.pluginPackages.disable('browser', ids.second, signal);
    checkBaseline('失败监听器不妨碍撤销');
    await badListenerRelease();
    checks.push({ name: '异常监听器不阻断选择及提供者撤销', passed: true });
    for (const id of Object.values(ids)) await runtime.pluginPackages.remove('browser', id, signal);
    check(
      (await runtime.pluginPackages.refresh('browser', signal)).data.length === 0,
      '验收后在线主题部署目录未清空',
    );
    await runtime.pluginPackages.upload(
      'browser',
      await archive('second'),
      'application/gzip',
      signal,
    );
    await runtime.pluginPackages.enable('browser', ids.second, signal);
    runtime.themes.select(ids.second + '.main');
    await release();
    await runtime.dispose();
    disposed = true;
    checkBaseline('运行时销毁');
    rejected(() => runtime.themes.snapshot(), 'cancelled', 'themes_closed');
    rejected(() => runtime.themes.select(null), 'cancelled', 'themes_closed');
    return {
      passed: true,
      checks,
      snapshots,
      baseline,
      applied,
      restored: styleState(target, probe),
      firstGeneration,
      reloadedGeneration: reloaded.generation,
      dynamicThemesObserved: true,
      explicitSelection: true,
      ownerGenerationRevocation: true,
      baselineRestored: true,
      childScopeRevocation: true,
      oldSubscriptionsRevoked: true,
      activationRollback: true,
      configurationReloadApplied: true,
      disposed,
    };
  } finally {
    if (!disposed) await runtime.dispose();
    Reflect.deleteProperty(globalThis, observationKey);
    target.remove();
    panel.remove();
  }
}
