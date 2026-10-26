// 此函数在真实生产页面执行，只点击公开界面，不替换 fetch 或注入业务状态。
export async function recoveryPanelScenario(device) {
  const evidence = { passed: false, checks: [], screenshots: [] };
  const until = async (read, label, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = read();
      if (value) return value;
      await new Promise((done) => setTimeout(done, 30));
    }
    throw new Error(label);
  };
  const button = (root, text) => [...root.querySelectorAll('button,[role="menuitem"]')]
    .find((item) => item.textContent.trim() === text);
  const capture = async (name) => {
    document.querySelector('section[aria-label="投屏恢复"]')?.scrollIntoView({ behavior: 'instant', block: 'start' });
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const result = await fetch('/__recovery/capture?name=' + name, { signal: AbortSignal.timeout(12000) });
    if (!result.ok) throw new Error('真实页面截图失败');
    evidence.screenshots.push(await result.json());
  };
  try {
    if (device !== null) {
      await until(() => document.querySelector('button[aria-label="设备目录"]'), '真实产品设备目录入口未装配');
      document.querySelector('button[aria-label="设备目录"]').click();
      const discover = await until(() => button(document, '发现设备'), '设备发现菜单不存在');
      if (discover.disabled || discover.getAttribute('data-disabled') !== null) throw new Error('设备发现入口异常禁用');
      discover.click();
      const target = await until(() => [...document.querySelectorAll('button[aria-label^="选择设备 "]')]
        .find((item) => item.getAttribute('aria-label').includes(device)), '没有发现本轮合成设备');
      target.click();
      const close = await until(() => document.querySelector('button[aria-label="退出设备选择"]'), '设备目录返回入口不存在');
      close.click();
    }
    const panel = await until(() => document.querySelector('section[aria-label="投屏恢复"]'), '真实恢复面板未装配');
    await until(() => /投屏连接待恢复/.test(panel.textContent), '面板未读取真实宿主的清理风险');
    const initialDetails = button(panel, '查看详情');
    if (!initialDetails || initialDetails.getAttribute('aria-expanded') !== 'false' ||
      panel.querySelector('[aria-label="资源核对明细"]')) throw new Error('风险明细没有默认折叠');
    const label = device === null ? '核对全部投屏资源' : '核对并恢复';
    const recovery = button(panel, label);
    if (!recovery || recovery.disabled) throw new Error('核对恢复按钮不可用');
    evidence.checks.push({ name: device === null ? '无选择设备时仍读取并提供全插件恢复' : '真实页面选择合成设备并读取清理风险', passed: true });
    await capture('01-recovery-risk');
    recovery.click();
    await until(() => panel.getAttribute('aria-busy') !== 'true' && button(panel, '连接排查'),
      '恢复完成后没有回到紧凑入口', 40000);
    const completedDetails = button(panel, '连接排查');
    if (completedDetails.getAttribute('aria-expanded') !== 'false' ||
      panel.querySelector('[aria-label="资源核对明细"]')) throw new Error('成功后明细意外常驻');
    evidence.checks.push({ name: '默认折叠风险明细，成功后保持紧凑入口', passed: true });
    await capture('02-recovery-confirmed');
    completedDetails.click();
    await until(() => /资源核对已通过/.test(panel.textContent), '展开后未显示真实恢复成功报告');
    const checks = panel.querySelector('[aria-label="资源核对明细"]');
    if (!checks || checks.querySelectorAll('li').length === 0) throw new Error('恢复报告明细为空');
    if (!/覆盖整个插件/.test(panel.textContent) || !/未确认\s*0\s*项/.test(panel.textContent))
      throw new Error('页面缺少插件级覆盖及剩余为零说明');
    if (panel.getAttribute('aria-busy') === 'true') throw new Error('完成后面板仍忙碌');
    if (button(panel, label)?.disabled) throw new Error('完成后恢复按钮未复位');
    evidence.checks.push({ name: '插件级非空核对结果和按钮复位', passed: true });
    await capture('03-recovery-details');
    const refresh = button(panel, '读取状态');
    if (!refresh || refresh.disabled) throw new Error('展开后的读取状态入口不可用');
    refresh.click();
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    await until(() => panel.getAttribute('aria-busy') !== 'true' && /资源核对已通过/.test(panel.textContent), '重查后恢复报告丢失');
    evidence.checks.push({ name: '真实 GET 重查保留恢复结果', passed: true });
    evidence.passed = true;
  } catch (error) {
    evidence.failure = { name: error.name, message: error.message };
    evidence.dom = {
      title: document.title, hash: location.hash,
      labels: [...document.querySelectorAll('button[aria-label],section[aria-label]')].slice(0, 50)
        .map((item) => ({ tag: item.tagName, label: item.getAttribute('aria-label') })),
      headings: [...document.querySelectorAll('h1,h2,h3')].slice(0, 20).map((item) => item.textContent.slice(0, 100)),
    };
    try { await capture('03-recovery-failure'); } catch { /* 不覆盖首个业务失败。 */ }
  }
  return evidence;
}
