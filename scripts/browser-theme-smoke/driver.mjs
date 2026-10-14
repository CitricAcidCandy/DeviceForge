import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { bounded, normalExit, observeChild } from '../unified-discovery-browser/lifecycle.mjs';
import { assertListenerReleased } from '../unified-discovery-smoke/host.mjs';
import { themeProtocol } from './cdp.mjs';

async function executable() {
  const candidates = [
    process.env.DEVICEFORGE_TEST_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error('未找到主题测试浏览器，请配置 DEVICEFORGE_TEST_BROWSER');
}

function endpoint(child, evidence) {
  return bounded(
    new Promise((resolve, reject) => {
      const cleanup = () => {
        child.stderr.off('data', data);
        child.off('exit', exit);
        child.off('error', error);
      };
      const data = () => {
        const found = evidence.diagnostic.match(
          /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/,
        );
        if (found) {
          cleanup();
          resolve(found[1]);
        }
      };
      const exit = () => {
        cleanup();
        reject(new Error('主题浏览器在调试端口就绪前退出'));
      };
      const error = () => {
        cleanup();
        reject(new Error('主题浏览器启动失败'));
      };
      child.stderr.on('data', data);
      child.once('exit', exit);
      child.once('error', error);
    }),
    15000,
    '主题浏览器调试端口未就绪',
  );
}

// 只持有本次隐藏浏览器原句柄；主题副作用仍由原生产harness验证。
export async function runBrowser(
  pageUrl,
  expression,
  profileDirectory,
  observeRuntime,
  options = {},
) {
  const evidence = options.evidence ?? {},
    binary = await executable();
  evidence.driver_pid = process.pid;
  evidence.executable_path = binary;
  evidence.stages = [];
  evidence.socket_events = [];
  evidence.arguments = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profileDirectory,
    'about:blank',
  ];
  if (options.inProcessGpu) evidence.arguments.splice(2, 0, '--in-process-gpu');
  const stage = (name) => {
    evidence.stage = name;
    evidence.stages.push({ name, at: new Date().toISOString() });
  };
  stage('启动浏览器');
  const child = spawn(binary, evidence.arguments, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const observed = observeChild(child, evidence);
  let browser, page, failure;
  try {
    stage('等待调试端口');
    const browserUrl = await endpoint(child, evidence);
    evidence.listener = {
      host: '127.0.0.1',
      port: Number(new URL(browserUrl).port),
      released: false,
    };
    stage('连接浏览器');
    browser = await themeProtocol(browserUrl, evidence);
    stage('取得版本');
    const version = await browser.call('Browser.getVersion');
    observeRuntime?.({
      executable_path: binary,
      version: version.product,
      revision: version.revision,
      protocol_version: version.protocolVersion,
      status: '已记录',
    });
    stage('创建验收页面');
    const origin = new URL(browserUrl);
    origin.protocol = 'http:';
    origin.pathname = '/json/new';
    origin.search = '?' + encodeURIComponent(pageUrl);
    const target = await fetch(origin, { method: 'PUT', signal: AbortSignal.timeout(10000) });
    assert.equal(target.ok, true, '主题测试页面创建失败');
    const info = await target.json();
    page = await themeProtocol(info.webSocketDebuggerUrl, evidence);
    stage('启用页面运行时');
    await page.call('Runtime.enable');
    stage('等待页面导航');
    const deadline = Date.now() + 10000;
    while (true) {
      try {
        const ready = await page.call('Runtime.evaluate', {
          expression:
            'location.href === ' +
            JSON.stringify(pageUrl) +
            ' && document.readyState !== "loading"',
          returnByValue: true,
        });
        if (ready.result.value === true) break;
      } catch (error) {
        evidence.navigation_error = String(error.message).slice(0, 300);
        if (child.exitCode !== null || child.signalCode !== null) throw error;
      }
      assert.ok(Date.now() < deadline, '主题验收页面导航未就绪');
      await delay(50);
    }
    stage('执行原主题业务检查');
    const evaluation = await page.call(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      60000,
    );
    if (evaluation.exceptionDetails)
      throw new Error(
        evaluation.exceptionDetails.exception?.description || '主题浏览器业务执行失败',
      );
    return evaluation.result.value;
  } catch (error) {
    failure = error;
    evidence.failure_stage = evidence.stage;
    evidence.error = String(error.message).slice(0, 600);
    throw error;
  } finally {
    stage('关闭本次浏览器');
    page?.close();
    if (browser) {
      try {
        await browser.call('Browser.close', {}, 5000);
      } catch (error) {
        evidence.close_command_error = String(error.message).slice(0, 300);
      }
      browser.close();
    }
    try {
      await observed.wait(5000);
    } catch {
      try {
        await observed.force();
      } catch (error) {
        evidence.cleanup_error = String(error.message);
      }
    }
    if (evidence.listener) {
      try {
        await assertListenerReleased(evidence.listener.port);
        evidence.listener.released = true;
      } catch (error) {
        evidence.port_cleanup_error = String(error.message).slice(0, 300);
      }
    }
    evidence.normal_exit = normalExit(evidence);
    evidence.completed_at = new Date().toISOString();
    if (!failure) {
      assert.equal(evidence.normal_exit, true, '主题浏览器须原child正常退出');
      assert.equal(evidence.listener?.released, true, '主题浏览器调试端口须释放');
    }
  }
}
