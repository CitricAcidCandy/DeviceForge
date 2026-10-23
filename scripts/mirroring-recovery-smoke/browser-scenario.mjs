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
    const result = await fetch('/__recovery/capture?name=' + name, { signal: AbortSignal.timeout(12000) });
    if (!result.ok) throw new Error('真实页面截图失败');
    evidence.screenshots.push(await result.json());
  };
  try {
    if (device !== null) {
      await until(() => document.querySelector('[aria-label="选择当前设备"]'), '真实产品设备入口未装配');
      document.querySelector('[aria-label="选择当前设备"]').click();
      const discover = await until(() => button(document, '发现设备'), '设备发现菜单不存在');
      if (discover.disabled || discover.getAttribute('data-disabled') !== null) throw new Error('设备发现入口异常禁用');
      discover.click();
      const target = await until(() => [...document.querySelectorAll('[role="menuitemradio"]')]
        .find((item) => item.textContent.includes(device)), '没有发现本轮合成设备');
      target.click();
    }
    const link = await until(() => [...document.querySelectorAll('a[href^="#"]')]
      .find((item) => /投屏|屏幕共享/.test(item.textContent)), '真实产品投屏导航未装配');
    link.click();
    const panel = await until(() => document.querySelector('section[aria-label="投屏恢复"]'), '真实恢复面板未装配');
    await until(() => /发现待核对资源/.test(panel.textContent), '面板未读取真实宿主的清理风险');
    const label = device === null ? '核对全部投屏资源' : '核对并恢复';
    const recovery = button(panel, label);
    if (!recovery || recovery.disabled) throw new Error('核对恢复按钮不可用');
    evidence.checks.push({ name: device === null ? '无选择设备时仍读取并提供全插件恢复' : '真实页面选择合成设备并读取清理风险', passed: true });
    await capture('01-recovery-risk');
    recovery.click();
    await until(() => /资源核对已通过/.test(panel.textContent), '页面未显示真实恢复成功报告', 40000);
    const checks = panel.querySelector('[aria-label="资源核对明细"]');
    if (!checks || checks.querySelectorAll('li').length === 0) throw new Error('恢复报告明细为空');
    if (!/覆盖整个插件/.test(panel.textContent) || !/未确认\s*0\s*项/.test(panel.textContent))
      throw new Error('页面缺少插件级覆盖及剩余为零说明');
    if (panel.getAttribute('aria-busy') === 'true') throw new Error('完成后面板仍忙碌');
    if (button(panel, label)?.disabled) throw new Error('完成后恢复按钮未复位');
    evidence.checks.push({ name: '插件级非空核对结果和按钮复位', passed: true });
    await capture('02-recovery-confirmed');
    button(panel, '读取状态')?.click();
    await until(() => panel.getAttribute('aria-busy') !== 'true' && /资源核对已通过/.test(panel.textContent), '重查后恢复报告丢失');
    evidence.checks.push({ name: '真实 GET 重查保留恢复结果', passed: true });
    evidence.passed = true;
  } catch (error) {
    evidence.failure = { name: error.name, message: error.message };
    try { await capture('03-recovery-failure'); } catch { /* 不覆盖首个业务失败。 */ }
  }
  return evidence;
}
