// 操作真实产品控件；公开接口只用于核对实际状态和触发旧修订拒绝。
const pause = (ms = 30) => new Promise((done) => setTimeout(done, ms));
const visible = (node) => Boolean(node?.getClientRects().length) && getComputedStyle(node).visibility !== 'hidden';
async function wait(read, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await pause(); }
  throw new Error(`产品浏览器等待超时：${label}`);
}
function check(condition, message) { if (!condition) throw new Error(message); }
function button(label, root = document) {
  return [...root.querySelectorAll('button')].find((node) => visible(node) &&
    (typeof label === 'string' ? node.textContent.trim() === label || node.getAttribute('aria-label') === label : label.test(node.textContent.trim())));
}
async function click(label, root = document) {
  const node = await wait(() => { const value = button(label, root); return value && !value.disabled ? value : null; }, `按钮 ${label}`);
  node.click(); await pause();
}
const dialog = () => [...document.querySelectorAll('[role="dialog"]')].filter(visible).at(-1);
function input(label, value, root = document) {
  const field = [...root.querySelectorAll('label')].find((node) => node.textContent.trim().startsWith(label));
  check(field?.htmlFor, `缺少字段标签 ${label}`);
  const control = document.getElementById(field.htmlFor);
  check(control instanceof HTMLInputElement && !control.disabled, `字段不可编辑 ${label}`);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(control, value);
  control.dispatchEvent(new Event('input', { bubbles: true }));
}
async function api(path, options = {}, expected = 200) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...options.headers } });
  const value = await response.json();
  check(response.status === expected, `${path} 状态 ${response.status}`);
  check(value.log_id === response.headers.get('x-deviceforge-log-id'), `${path} 日志标识不一致`);
  return value;
}
async function stage(name) { await fetch(`/__smoke/stage?name=${encodeURIComponent(name)}`, { method: 'POST' }); }
async function screenshot(name) {
  await pause(120);
  const response = await fetch(`/__smoke/capture?name=${name}`);
  check(response.ok, `截图失败 ${name}`);
}

export async function verifyProductInstallations() {
  const result = { passed: false, checks: [], progress: [] };
  let observation;
  try {
    const config = await (await fetch('/__smoke/start')).json();
    const card = () => [...document.querySelectorAll('.marketplace-card')].find((node) => visible(node) && node.textContent.includes(config.releaseId));
    await stage('设置真实市场来源');
    await wait(() => button('保存并刷新'), '真实设置页');
    input('市场地址', config.market); await pause(); await click('保存并刷新');
    await wait(() => localStorage.getItem('deviceforge.marketplace.url') === config.market, '保存市场地址');
    const navigation = document.querySelector('button[data-navigation-route="marketplace"]');
    check(navigation, '缺少市场导航'); navigation.click();
    await wait(card, '第三方完整发布市场卡片');
    check(card().textContent.includes('浏览器验收第三方功能'), '卡片未使用外显名称');
    check(card().textContent.includes('配置、启停与浏览器重试验收'), '卡片未显示发布简介');
    check(button('下载发布清单', card()) && !button('下载', card()), '完整发布卡片必须明确下载发布清单');
    await screenshot('01-discovery'); result.checks.push('真实市场发现名称与描述');

    await stage('从产品市场安装完整发布');
    observation = new MutationObserver(() => {
      for (const node of document.querySelectorAll('[aria-label="安装任务进度"]')) {
        const text = node.textContent;
        if (!result.progress.includes(text)) result.progress.push(text);
      }
    });
    observation.observe(document.body, { subtree: true, childList: true, characterData: true });
    await click('安装', card()); await wait(dialog, '安装详情');
    check(button('下载发布清单', dialog()) && !button('下载', dialog()), '完整发布详情必须明确下载发布清单');
    result.checks.push('完整发布卡片与详情明确下载发布清单');
    await click('安装', dialog());
    await wait(() => globalThis.__installationBrowserSmoke?.attempts === 1, '真实浏览器首次激活');
    await click('关闭', dialog()); await click(/^已安装\s+1$/);
    await wait(() => button('重试本客户端', card()), '浏览器失败重试入口');
    check(card().textContent.includes('首次激活失败'), '浏览器错误未呈现到功能卡片');
    const initial = (await api('/api/v2/plugin-installations')).data.find((item) => item.id === config.releaseId);
    check(initial?.enabled && initial.components.length === 2, '完整安装目录不正确');
    result.initial_revision = initial.revision;
    if (config.lanHost) {
      check(new URL(location.href).hostname === new URL(config.lanHost).hostname, '产品页面未使用本机局域网地址');
      const health = await api(`${config.lanHost}/api/v2/health`);
      check(health.data, '局域网宿主健康响应缺失');
      const browser = initial.components.find((item) => item.kind === 'browser');
      const componentUrl = new URL(browser.entry_url, config.lanHost).href;
      const component = await fetch(componentUrl);
      check(component.status === 200 && (await component.text()).includes('panels:[]'), '局域网浏览器组件读取失败');
      result.local_lan = { page_origin: location.origin, server_origin: config.lanHost, component_url: componentUrl,
        component_status: component.status, scope: '本机LAN地址浏览器，非第二台物理客户端' };
      result.checks.push('本机真实局域网IPv4页面及宿主组件GET');
    }
    await screenshot('02-browser-failed'); result.checks.push('产品一次安装服务器浏览器工具且展示客户端失败');

    await stage('产品页重试当前浏览器');
    await click('重试本客户端', card());
    await wait(() => globalThis.__installationBrowserSmoke?.runs.length === 1, '真实SDK提交检查任务');
    check(globalThis.__installationBrowserSmoke.runs[0].result.absolute === true, '工具绝对路径绑定失败');
    await wait(() => !button('重试本客户端', card()), '重试成功后收起重试入口');
    result.checks.push('本客户端重试通过真实SDK调用服务器');

    await stage('产品配置真实服务器组件');
    await click('配置', card()); await wait(dialog, '组件配置选择');
    await click(`服务器组件 · ${config.serverId}`, dialog());
    await wait(() => button('保存配置', dialog()), '真实插件配置表单');
    input('setting', '用户配置不丢失', dialog()); await pause();
    await screenshot('03-configuration'); await click('保存配置', dialog());
    await wait(() => dialog()?.textContent.includes('配置已保存并生效'), '配置保存结果');
    const saved = (await api(`/api/v2/plugin-configurations/server/${config.serverId}`)).data;
    check(saved.values.setting === '用户配置不丢失', '配置未写入真实宿主');
    result.configuration_revision = saved.revision;
    await click('关闭', dialog()); await click('关闭', dialog());
    result.checks.push('按真实组件标识保存基础配置');

    await stage('产品停用和重新启用');
    await click('停用', card()); await wait(() => button('启用', card()) && !button('启用', card()).disabled, '停用完成');
    check(globalThis.__installationBrowserSmoke.cleanups >= 1, '停用未清理浏览器作用域');
    check((await api('/api/v2/plugin-installations')).data[0].enabled === false, '服务器仍启用');
    await screenshot('04-disabled'); await click('启用', card());
    await wait(() => globalThis.__installationBrowserSmoke.runs.length === 2, '重新启用调用真实SDK');
    check(globalThis.__installationBrowserSmoke.runs.at(-1).result.configuration === '用户配置不丢失', '重新启用未应用保存值');
    await wait(() => button('停用', card()) && !button('停用', card()).disabled, '启用完成');
    await screenshot('05-enabled'); result.checks.push('统一停用清理与重新启用保留配置');

    await stage('发布新版本并从产品更新');
    const published = await fetch('/__smoke/publish-update', { method: 'POST' }); check(published.ok, '新版本发布失败');
    await click('发现资源'); await click('刷新');
    await wait(() => [...document.querySelectorAll('.marketplace-card')].some((node) => visible(node) && node.textContent.includes('1.1.0')), '新版本市场条目');
    await click(/^已安装\s+1$/); await wait(() => button('更新', card()), '已安装更新入口');
    await click('更新', card()); await wait(dialog, '更新详情'); await click('更新', dialog());
    await wait(() => globalThis.__installationBrowserSmoke.runs.at(-1)?.version === '1.1.0', '更新后真实浏览器执行');
    await click('关闭', dialog());
    const updated = (await api('/api/v2/plugin-installations')).data.find((item) => item.id === config.releaseId);
    check(updated.revision !== initial.revision && updated.version === '1.1.0', '发布修订未更新');
    const run = globalThis.__installationBrowserSmoke.runs.at(-1);
    check(run.result.value === '第二版本工具' && run.result.configuration === '用户配置不丢失', '新工具或用户配置未保留');
    const stale = await api('/api/v2/jobs', { method: 'POST', headers: { 'x-deviceforge-plugin-release': JSON.stringify({ id: config.releaseId, revision: initial.revision }) },
      body: JSON.stringify({ operation: `plugin.${config.serverId}.inspect`, input: {} }) }, 409);
    result.stale_revision = { code: stale.error.code, log_id: stale.log_id };
    await screenshot('06-updated'); result.checks.push('产品更新保留配置与旧修订HTTP409');

    await stage('产品卸载完整发布');
    await click('卸载', card()); await wait(dialog, '卸载确认'); await click('确认卸载', dialog());
    await wait(() => document.body.textContent.includes('还没有安装插件'), '统一卸载后清空组件缓存');
    check((await api('/api/v2/plugin-installations')).data.length === 0, '卸载后安装目录非空');
    await screenshot('07-uninstalled'); result.checks.push('产品卸载清空目录');
    result.runtime = globalThis.__installationBrowserSmoke;
    result.passed = true; await stage('产品浏览器验收通过');
  } catch (error) {
    result.error = { message: error.message, stack: error.stack };
    result.visible_text = document.body.innerText.slice(0, 12000);
    await screenshot('99-failure').catch(() => undefined);
  } finally { observation?.disconnect(); }
  return result;
}
