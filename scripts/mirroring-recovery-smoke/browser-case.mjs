import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runPublicationBrowser } from '../plugin-publications-browser-smoke/browser.mjs';
import { ownedBrowserProcesses, reclaimOwnedBrowserProcesses } from '../plugin-publications-browser-smoke/verification.mjs';
import { recoveryPanelScenario } from './browser-scenario.mjs';
import { launchRecoveryBridge } from './product-bridge.mjs';
import { failureSummary, fileIdentity } from './evidence.mjs';
import { assertRecoveryView } from './http.mjs';

// 主代理在隔离 HTTP 验收通过后传入同一宿主和合成设备提供者；不创建手机连接。
export async function runRecoveryPanelBrowser({ host, dist, device, directory, generation }) {
  if (device !== null) assert.match(device, /^(cleanup-|retry-after-)/, '只接受本轮合成设备');
  const view = assertRecoveryView(await host.client.recovery(), { generation, supported: true });
  assert.equal(view.cleanup_failed, true, '须先由真实隔离插件故障产生风险，禁止前端伪造');
  const report = { scope: '真实生产恢复面板及真实隔离 HTTP；不验证完整投屏或真机',
    target_mode: device === null ? 'all-resources-without-device' : 'selected-synthetic-device',
    passed: false, checks: { dom: false, network: false, visual_review: '等待视觉子代理' } };
  const profile = join(directory, 'browser-profile');
  await mkdir(profile, { recursive: true });
  let bridge;
  let failure;
  try {
    bridge = await launchRecoveryBridge({ dist, host, profile, directory, report });
    const expression = `(${recoveryPanelScenario.toString()})(${JSON.stringify(device)})`;
    await runPublicationBrowser(bridge.origin + '/#devices', expression, profile, report);
    const posts = report.product_proxy.filter((item) => item.method === 'POST' && item.path === '/api/v2/plugins/mirroring/recovery');
    assert.equal(posts.length, 1, '真实页面只允许一次显式恢复 POST');
    assert.equal(posts[0].status, 200);
    assert.ok(posts[0].log_id);
    assert.equal(report.product_proxy.some((item) => item.method === 'POST' &&
      ['/api/v2/sessions', '/api/v2/device-actions'].includes(item.path)), false,
    '恢复不能自动重放投屏或设备业务');
    for (const item of report.product_proxy) if (item.log_id) host.client.logIds.add(item.log_id);
    const final = assertRecoveryView(await host.client.recovery(), { generation, supported: true });
    assert.equal(final.cleanup_failed, false); assert.equal(final.last_report?.status, 'recovered');
    assert.ok(report.screenshots.length >= 2, '原始截图必须留给视觉子代理');
    for (const source of report.production_inputs) assert.deepEqual(await fileIdentity(source.path), source,
      '浏览器受检生产字节不得在验收中变化');
    report.checks.network = true; report.passed = true;
  } catch (error) {
    failure = error;
    report.failure = failureSummary(error, '真实生产恢复面板');
  } finally {
    report.cleanup_errors = [];
    try { if (bridge) await bridge.finish(); }
    catch (error) { report.cleanup_errors.push(failureSummary(error, '本轮产品代理收尾')); }
    try {
      let processes = await ownedBrowserProcesses(profile);
      if (processes.processes.length) {
        report.passed = false;
        processes = await reclaimOwnedBrowserProcesses(profile, report);
      }
      report.browser_process_tree_after = processes;
      assert.equal(processes.processes.length, 0, '本轮浏览器派生树须全部退出');
    } catch (error) {
      report.cleanup_errors.push(failureSummary(error, '本轮浏览器派生树收尾'));
    }
    if (report.cleanup_errors.length) report.passed = false;
    report.completed_at = new Date().toISOString();
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  if (failure) throw failure;
  assert.equal(report.cleanup_errors.length, 0, '浏览器回收失败原件已保留');
  return report;
}
