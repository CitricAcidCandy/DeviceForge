// 复用有界协议与原始子进程观察器；完整发布流程不受旧入口固定六十秒截断。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { themeProtocol } from '../browser-theme-smoke/cdp.mjs';
import { observeChild, normalExit } from '../unified-discovery-browser/lifecycle.mjs';
import { listenerReleased } from './verification.mjs';

export const browserTimeout = 180000;

export function publicationBrowserResult(evaluation, report) {
  if (evaluation.exceptionDetails) throw new Error(evaluation.exceptionDetails.exception?.description ?? '浏览器发布验收失败');
  const result = evaluation.result?.value;
  // 先保存页面结果，退出清理失败也不能覆盖原始 DOM 断言与错误。
  report.browser = result;
  report.checks.dom = result?.passed === true;
  assert.equal(result?.passed, true, result?.error?.message ?? '网页发布DOM验收未通过');
  return result;
}

export async function runPublicationBrowser(pageUrl, expression, profile, report) {
  let executable;
  for (const candidate of [process.env.DEVICEFORGE_TEST_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean)) {
    try { await access(candidate); executable = candidate; break; } catch { /* 尝试下一已安装浏览器。 */ }
  }
  assert.ok(executable, '未找到测试浏览器，请配置 DEVICEFORGE_TEST_BROWSER');
  const evidence = report.browser_process = { executable, socket_events: [], timeout_ms: browserTimeout,
    arguments: ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-networking', '--disable-background-mode',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'] };
  const child = spawn(executable, evidence.arguments, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const observed = observeChild(child, evidence);
  let browser, page, failure;
  try {
    const deadline = Date.now() + 15000;
    let endpoint;
    while (!endpoint && Date.now() < deadline) {
      assert.ok(!evidence.spawn_error && !evidence.close, '浏览器在调试端口就绪前退出');
      try {
        const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
        if (/^\d+$/.test(port) && path?.startsWith('/devtools/browser/')) endpoint = `ws://127.0.0.1:${port}${path}`;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!endpoint) await delay(30);
    }
    assert.ok(endpoint, '浏览器调试端口未在十五秒内就绪');
    evidence.listener = { port: Number(new URL(endpoint).port), released: false };
    browser = await themeProtocol(endpoint, evidence);
    const version = await browser.call('Browser.getVersion');
    report.browser_runtime = { executable_path: executable, version: version.product,
      revision: version.revision, protocol_version: version.protocolVersion };
    const target = await fetch(`http://127.0.0.1:${evidence.listener.port}/json/new?${encodeURIComponent(pageUrl)}`,
      { method: 'PUT', signal: AbortSignal.timeout(10000) });
    assert.equal(target.ok, true, '浏览器产品页面创建失败');
    page = await themeProtocol((await target.json()).webSocketDebuggerUrl, evidence);
    await page.call('Runtime.enable');
    const navigationDeadline = Date.now() + 10000;
    let ready = false;
    while (!ready && Date.now() < navigationDeadline) {
      try {
        ready = (await page.call('Runtime.evaluate', { expression:
          `location.href === ${JSON.stringify(pageUrl)} && document.readyState !== 'loading'`, returnByValue: true }, 2000)).result.value === true;
      } catch (error) {
        evidence.navigation_error = error.message;
        if (evidence.close) throw error;
      }
      if (!ready) await delay(30);
    }
    assert.ok(ready, '浏览器产品页面导航未就绪');
    const evaluation = await page.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, browserTimeout);
    return publicationBrowserResult(evaluation, report);
  } catch (error) {
    failure = error; evidence.error = error.message; throw error;
  } finally {
    page?.close();
    if (browser) {
      try { await browser.call('Browser.close', {}, 5000); } catch (error) { evidence.close_command_error = error.message; }
      browser.close();
    }
    try { await observed.wait(15000); }
    catch { try { await observed.force(); } catch (error) { evidence.cleanup_error = error.message; } }
    if (evidence.listener) evidence.listener.released = await listenerReleased(evidence.listener.port);
    evidence.normal_exit = normalExit(evidence);
    if (!failure) {
      assert.equal(evidence.normal_exit, true, '浏览器原始child必须正常退出并完成close');
      assert.equal(evidence.listener?.released, true, '浏览器调试端口必须释放');
    }
  }
}
