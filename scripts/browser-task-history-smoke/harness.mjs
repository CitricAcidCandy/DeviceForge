import { createFrontendRuntime } from '/assets/plugin-host.js';
import { check, brief, createTransport } from './browser-evidence.mjs';
import { runHistoryScenarios } from './history-scenarios.mjs';
import { runCancellationScenarios } from './cancellation-scenarios.mjs';

export async function verifyTaskHistory() {
  const report = { passed: false, steps: [], unhandled: [], transport: [],
    environment: { href: location.href, origin: location.origin, secureContext: globalThis.isSecureContext,
      randomUUIDAvailable: typeof globalThis.crypto?.randomUUID === 'function' },
    boundary: { productUI: false, realDevice: false, pushOrReconnect: false, serverRestartHistory: false,
      callerAbortCancelsJob: false, pluginSideEffectsForceStopped: false, esmMemoryRemoved: false } };
  let runtime; let config; const targets = {};
  const unhandled = (event) => { report.unhandled.push(brief(event.reason)); };
  window.addEventListener('unhandledrejection', unhandled);
  const transport = createTransport(report);
  const step = async (id, run) => {
    const entry = { id, passed: false }; report.steps.push(entry);
    try { entry.evidence = await run(); entry.passed = true; }
    catch (error) { entry.error = brief(error); throw error; }
  };
  try {
    const response = await fetch('/__config', { signal: AbortSignal.timeout(5000) });
    check(response.ok, '本次配置不可读'); config = await response.json();
    report.runId = config.runId;
    for (const id of ['left', 'right']) {
      const target = document.createElement('section'); target.dataset.verificationTarget = id;
      document.body.append(target); targets[id] = target;
    }
    runtime = createFrontendRuntime({ baseUrl: location.origin, transport: transport.transport,
      panelTarget: (id, panel) => id !== config.browserId ? null
        : panel === config.panelIds.left ? targets.left : panel === config.panelIds.right ? targets.right : null,
      esmImporter: async (url, current) => {
        current.throwIfAborted();
        const loaded = await import(url);
        current.throwIfAborted();
        return loaded;
      } });
    check(runtime.host.apiVersion === 2 && runtime.host.taskHistory, 'production host缺少可选历史接口');
    const env = { runtime, config, report, step, transport, targets,
      signal: new AbortController().signal, probe: () => globalThis[Symbol.for(config.probeKey)] };
    await runHistoryScenarios(env);
    await runCancellationScenarios(env);
    await transport.drain();
    check(report.unhandled.length === 0, '真实浏览器存在未处理拒绝');
    check(report.steps.length === 10 && report.steps.every((entry) => entry.passed), '验收场景不完整');
    report.passed = true;
  } catch (error) { report.error = brief(error); }
  finally {
    if (runtime) {
      try { await runtime.dispose(); report.runtimeDisposed = true; }
      catch (error) { report.disposeError = brief(error); report.passed = false; }
    }
    try { await transport.drain(); }
    catch (error) { report.transportCleanupError = brief(error); report.passed = false; }
    // 让受控晚拒绝的浏览器事件完成一个事件循环，再移除本次监听。
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (report.unhandled.length) report.passed = false;
    window.removeEventListener('unhandledrejection', unhandled);
    if (config) delete globalThis[Symbol.for(config.probeKey)];
    for (const target of Object.values(targets)) target.remove();
    report.harnessDomRemoved = Object.values(targets).every((target) => !target.isConnected);
  }
  return report;
}
