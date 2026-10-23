// DOM断言与网络断言分别留证，页面发布完全经过产品表单。
import {
  api, button, check, click, closeDialog, control, dialog, input, pause,
  releaseCard, request, screenshot, selectZip, stage, wait,
} from './controls.mjs';

export async function verifyProductPublications(config) {
  const result = { passed: false, dom_assertions: [], progress: [], snapshots: [], feedback_captures: [] };
  let observer;
  const gateway = async (path, options) => {
    const response = await request(new URL(`/__publication/${path}`, config.gateway), options);
    check(response.ok, `发布验收控制路由失败 ${path}`);
    return response.json();
  };
  const phase = async (mode, name) => {
    await stage(name);
    await gateway('control', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode, phase: name }) });
  };
  const snapshot = async (name) => {
    const value = await gateway('snapshot');
    result.snapshots.push({ name, phase: value.phase, sequence: value.requests.length,
      dialog_text: dialog()?.innerText ?? null });
    return value.requests.filter((item) => item.phase === value.phase);
  };
  async function openPublication(fixture) {
    await click('上传发布');
    await wait(() => dialog()?.textContent.includes('发布完整功能插件'), '默认完整功能发布模式');
    await selectZip(config, fixture);
    await click('检查完整 ZIP', dialog());
    await wait(() => dialog()?.querySelector('[aria-label="完整功能插件预览"]'), '完整包本地预览');
    const preview = dialog().querySelector('[aria-label="完整功能插件预览"]');
    check(preview.textContent.includes(fixture.id) && preview.textContent.includes(fixture.name), '预览身份未保持实际清单值');
    check(preview.textContent.includes('服务器组件') && preview.textContent.includes('浏览器组件'), '预览缺少成套组件');
    input('市场简介', `网页完整发布验收：${fixture.id}`, dialog());
    await pause();
  }
  function verifyPublicationSteps(name, completed) {
    const list = dialog()?.querySelector('ol[aria-label="完整功能插件发布步骤"]');
    check(list, '完整功能发布步骤缺少可访问列表');
    const steps = [...list.querySelectorAll('li')].map((node) => ({
      state: node.getAttribute('data-state'), current: node.getAttribute('aria-current'), text: node.innerText,
    }));
    check(steps.length === 3, '完整功能发布步骤必须保持三步');
    if (completed) {
      check(steps.every((step) => step.state === 'complete'), '发布成功后三步必须全部完成');
      check(steps.every((step) => step.current !== 'step'), '发布成功后不得仍向读屏声明进行中步骤');
    } else {
      check(steps[2].current === 'step', '上传依赖期间第三步必须为当前步骤');
      check(steps.slice(0, 2).every((step) => step.current !== 'step'), '上传依赖期间不得仍停在预览步骤');
    }
    result.dom_assertions.push({ name, passed: true, steps });
  }
  async function capturePublicationFeedback(name, completed = false) {
    const root = dialog();
    const targets = completed
      ? [...root.querySelectorAll('section[role="status"]')].filter((node) => node.textContent.includes('已发布「'))
      : [...root.querySelectorAll('[role="alert"], [role="status"], p')].filter((node) =>
        node.getAttribute('role') === 'alert' ||
        (node.getAttribute('role') === 'status' && node.getAttribute('aria-label') !== '完整发布进度') ||
        node.textContent.includes('取消等待或请求失败不表示服务器已经回滚'));
    check(targets.length > 0, `截图缺少真实结果区 ${name}`);
    // 只滚动真实页面，不更改节点、样式或可见性；原上部图保留在旧轮证据目录。
    targets.at(-1).scrollIntoView({ behavior: 'instant', block: 'end', inline: 'nearest' });
    let previous, stable = 0;
    const rectangles = await wait(async () => {
      await pause(100);
      const values = targets.map((node) => {
        const rect = node.getBoundingClientRect();
        const clip = { top: 0, left: 0, right: innerWidth, bottom: innerHeight };
        for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor), bounds = ancestor.getBoundingClientRect();
          if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
            clip.top = Math.max(clip.top, bounds.top); clip.bottom = Math.min(clip.bottom, bounds.bottom);
          }
          if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
            clip.left = Math.max(clip.left, bounds.left); clip.right = Math.min(clip.right, bounds.right);
          }
        }
        return { text: node.innerText, role: node.getAttribute('role'),
          top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
          fully_visible: rect.width > 0 && rect.height > 0 && rect.top >= clip.top - 1 &&
            rect.bottom <= clip.bottom + 1 && rect.left >= clip.left - 1 && rect.right <= clip.right + 1 };
      });
      const signature = JSON.stringify(values);
      stable = signature === previous ? stable + 1 : 0; previous = signature;
      return stable >= 2 && values.every((value) => value.fully_visible) ? values : null;
    }, `反馈完整进入视口且布局稳定 ${name}`, 5000);
    await screenshot(name);
    result.feedback_captures.push({ name, scroll_only: true, layout_stable: true, targets: rectangles });
  }
  async function publishFixture(fixture, name, image) {
    await phase('normal', name);
    await openPublication(fixture);
    await click('确认上传并发布', dialog());
    await wait(() => dialog()?.textContent.includes(`已发布「${fixture.name}」`), '真实市场发布成功');
    verifyPublicationSteps(`${name}：成功后三步全部完成且无进行中读屏状态`, true);
    const value = await snapshot(name);
    result.dom_assertions.push({ name, passed: true, text: dialog().innerText });
    await capturePublicationFeedback(image, true);
    await click('完成', dialog());
    await wait(() => !dialog(), '完成后关闭发布弹窗');
    return value;
  }
  try {
    const startResponse = await request('/__smoke/start');
    check(startResponse.ok, '本轮浏览器证据连接失败');
    const start = await startResponse.json();
    config.market = start.market;
    Object.assign(config, await gateway('config'));
    observer = new MutationObserver(() => {
      const node = document.querySelector('[aria-label="完整发布进度"]');
      if (node && !result.progress.includes(node.textContent)) result.progress.push(node.textContent);
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    await wait(() => button('保存并刷新'), '真实设置页');
    input('市场地址', config.market); await pause(); await click('保存并刷新');
    await wait(() => localStorage.getItem('deviceforge.marketplace.url') === config.market, '独占市场地址保存');
    const navigation = document.querySelector('button[data-navigation-route="marketplace"]');
    check(navigation, '缺少市场导航'); navigation.click();
    await wait(() => button('上传发布'), '市场页面');
    await click('上传发布');
    await wait(() => dialog()?.textContent.includes('发布完整功能插件'), '默认完整发布入口');
    check(button('完整功能插件', dialog())?.getAttribute('aria-pressed') === 'true', '上传入口没有默认选择完整功能发布');
    await click('独立组件或其他资源', dialog());
    await wait(() => dialog()?.querySelector('[aria-label="上传发布步骤"]'), '旧兼容上传步骤');
    check(button('独立组件或其他资源', dialog())?.getAttribute('aria-pressed') === 'true', '旧兼容模式没有明确选中状态');
    await click('完整功能插件', dialog());
    await wait(() => dialog()?.textContent.includes('发布完整功能插件'), '切回完整功能发布');
    result.dom_assertions.push({ name: '默认完整发布与旧兼容模式显式切换', passed: true });
    await closeDialog();

    await phase('legacy', 'legacy-capabilities');
    await openPublication(config.fixtures.first);
    await screenshot('01-publication-preview');
    await click('确认上传并发布', dialog());
    await wait(() => dialog()?.querySelector('[role="alert"]'), '旧市场能力失败提示');
    check(/能力|不支持|升级|完整功能/.test(dialog().querySelector('[role="alert"]').textContent), '旧市场错误没有可读说明');
    await snapshot('legacy-capabilities');
    await capturePublicationFeedback('02-legacy-capabilities');
    result.dom_assertions.push({ name: '旧能力失败保留可读错误及当前表单', passed: true });
    await closeDialog();

    await phase('resource-error', 'resource-error');
    await openPublication(config.fixtures.first);
    await click('确认上传并发布', dialog());
    await wait(() => dialog()?.querySelector('[role="alert"]')?.textContent.includes('受控资源上传失败'), '真实资源请求失败提示');
    check(dialog().textContent.includes('重试') && button('确认上传并发布', dialog()), '上传失败后未保留重试入口');
    await snapshot('resource-error');
    await capturePublicationFeedback('03-resource-error');
    result.dom_assertions.push({ name: '资源上传失败可重试且不误报完成', passed: true });
    await closeDialog();

    await phase('cancel', 'cancel-publication');
    await openPublication(config.fixtures.first);
    await click('确认上传并发布', dialog());
    await wait(async () => (await gateway('snapshot')).requests.some((item) => item.phase === 'cancel-publication' && item.held), '受控请求暂停以验证真实AbortSignal');
    verifyPublicationSteps('受控上传等待期间第三步为当前步骤', false);
    check(button('取消当前操作', dialog()), '上传中缺少明确取消入口');
    await click('取消当前操作', dialog());
    await wait(() => dialog()?.textContent.includes('已取消当前发布等待'), '发布取消反馈');
    await wait(async () => (await gateway('snapshot')).requests.some((item) => item.phase === 'cancel-publication' && item.client_aborted), '浏览器请求实际中断');
    check(dialog().textContent.includes('不表示服务器已经回滚'), '取消反馈必须保留远端状态边界');
    await snapshot('cancel-publication');
    await capturePublicationFeedback('04-publication-cancelled');
    result.dom_assertions.push({ name: '取消实际中断请求并说明远端状态边界', passed: true });
    await closeDialog();

    await publishFixture(config.fixtures.first, 'first-publication', '05-first-published');
    await wait(() => releaseCard(config.fixtures.first.id), '刚发布完整功能市场卡片');
    check(releaseCard(config.fixtures.first.id).textContent.includes(config.fixtures.first.name), '发现卡片没有中文外显名称');
    check(button('下载发布清单', releaseCard(config.fixtures.first.id)), '完整功能发现卡片缺少明确清单下载入口');
    result.dom_assertions.push({ name: '页面发布后可发现唯一完整功能卡片', passed: true });
    await publishFixture(config.fixtures.shared, 'shared-publication', '06-shared-published');
    await wait(() => releaseCard(config.fixtures.shared.id), '共享组件发布卡片');
    await screenshot('07-published-discovery');

    await phase('normal', 'conflicting-publication');
    await openPublication(config.fixtures.conflict);
    await click('确认上传并发布', dialog());
    await wait(() => dialog()?.querySelector('[role="alert"]'), '同版本清单冲突反馈');
    check(/冲突|409|不可变|同一|相同|已存在/.test(dialog().querySelector('[role="alert"]').textContent), '清单冲突没有可读说明');
    check(button('确认上传并发布', dialog()) && !button('完成', dialog()), '冲突后不能误报发布成功');
    await snapshot('conflicting-publication');
    await capturePublicationFeedback('11-publication-conflict');
    result.dom_assertions.push({ name: '同一身份不同清单由真实市场拒绝且不误报完成', passed: true });
    await closeDialog();

    await phase('normal', 'install-published-release');
    await click('安装', releaseCard(config.fixtures.first.id));
    await wait(() => dialog() && button('安装', dialog()), '发布后的真实安装详情');
    await click('安装', dialog());
    await wait(() => globalThis.__installationBrowserSmoke?.attempts === 1, '浏览器首次激活');
    await click('关闭', dialog());
    await click(/^已安装\s+1$/);
    await wait(() => button('重试本客户端', releaseCard(config.fixtures.first.id)), '安装后客户端失败入口');
    await click('重试本客户端', releaseCard(config.fixtures.first.id));
    await wait(() => globalThis.__installationBrowserSmoke?.runs.length === 1, '公开SDK读取真实组件和工具');
    check(globalThis.__installationBrowserSmoke.runs[0].result.absolute === true, '共享工具没有绑定到真实绝对路径');
    await screenshot('08-installed-sdk');
    const installation = (await api('/api/v2/plugin-installations')).data.find((item) => item.id === config.fixtures.first.id);
    check(installation?.enabled && installation.components.length === 2, '发布后未成套安装两个组件');
    result.installation = { id: installation.id, revision: installation.revision, components: installation.components };
    result.dom_assertions.push({ name: '从网页发布条目成套安装且客户端重试实际调用SDK', passed: true });

    await click('配置', releaseCard(config.fixtures.first.id));
    await wait(dialog, '组件配置选择');
    await click(`服务器组件 · ${config.fixtures.first.serverId}`, dialog());
    await wait(() => button('保存配置', dialog()), '基础配置表单');
    input('配置内容', '网页发布配置不丢失', dialog()); await pause();
    await screenshot('09-published-configuration');
    await click('保存配置', dialog());
    await wait(() => dialog()?.textContent.includes('配置已保存并生效'), '真实配置保存反馈');
    const saved = (await api(`/api/v2/plugin-configurations/server/${config.fixtures.first.serverId}`)).data;
    check(saved.values.setting === '网页发布配置不丢失', '配置未保存到真实宿主');
    result.configuration_revision = saved.revision;
    await click('关闭', dialog()); await click('关闭', dialog());
    await click('停用', releaseCard(config.fixtures.first.id));
    await wait(() => button('启用', releaseCard(config.fixtures.first.id)) && !button('启用', releaseCard(config.fixtures.first.id)).disabled, '统一停用');
    await click('启用', releaseCard(config.fixtures.first.id));
    await wait(() => globalThis.__installationBrowserSmoke?.runs.length === 2, '重新启用后SDK读取保存值');
    check(globalThis.__installationBrowserSmoke.runs.at(-1).result.configuration === '网页发布配置不丢失', 'SDK未消费网页保存的真实配置');
    await screenshot('10-configured-sdk');
    result.dom_assertions.push({ name: '中文基础配置保存并由重新启用后的SDK调用实际读取', passed: true });
    result.runtime = globalThis.__installationBrowserSmoke;
    result.passed = true; await stage('网页完整ZIP发布验收通过');
  } catch (error) {
    result.error = { message: error.message, stack: error.stack };
    result.visible_text = document.body.innerText.slice(0, 14000);
    await screenshot('99-failure').catch(() => undefined);
  } finally { observer?.disconnect(); }
  return result;
}
