import { createFrontendRuntime } from '/assets/plugin-host.js';
import { runScenarios } from './scenarios.mjs';

export async function verifyAndroidArtifacts() {
  const report = { passed: false, steps: [], transport: [], unhandled: [], boundary: { realDevice: false, realApkInstall: false, visualQuality: false, npx: false, lan: false, cancelStopsDeviceSideEffect: false } };
  let runtime; const targets = {}; const config = await fetch('/__config').then((reply) => reply.json());
  report.runId = config.runId;
  const unhandled = (event) => report.unhandled.push(String(event.reason?.message ?? event.reason).slice(0, 500)); window.addEventListener('unhandledrejection', unhandled);
  const transport = (input, options = {}) => { const url = new URL(input, location.href); const entry = { path: url.pathname + url.search, method: options.method ?? 'GET' }; report.transport.push(entry); return fetch(input, options).then((response) => { entry.status = response.status; entry.logId = response.headers.get('x-deviceforge-log-id'); return response; }); };
  try {
    for (const side of ['left', 'right']) { targets[side] = document.createElement('section'); document.body.append(targets[side]); }
    runtime = createFrontendRuntime({ baseUrl: location.origin, transport, panelTarget: (id, panel) => id !== config.browserId ? null : panel === config.panelIds.left ? targets.left : panel === config.panelIds.right ? targets.right : null, esmImporter: async (url, signal) => { if (signal.aborted) throw new Error('aborted'); const module = await import(url); if (signal.aborted) throw new Error('aborted'); return module; } });
    const env = { runtime, config, report, targets, signal: new AbortController().signal, transport, step: async (id, run) => { const entry = { id, passed: false }; report.steps.push(entry); try { entry.evidence = await run(); entry.passed = true; } catch (error) { entry.error = String(error.message).slice(0, 800); throw error; } } };
    await runScenarios(env); report.passed = report.steps.length === 9 && report.steps.every((step) => step.passed) && report.unhandled.length === 0;
  } catch (error) { report.error = String(error.message).slice(0, 1200); }
  finally { try { await runtime?.dispose(); report.runtimeDisposed = true; } catch (error) { report.disposeError = String(error.message).slice(0, 500); report.passed = false; } await new Promise((resolve) => setTimeout(resolve, 0)); if (report.unhandled.length) report.passed = false; window.removeEventListener('unhandledrejection', unhandled); Object.values(targets).forEach((target) => target.remove()); delete globalThis[Symbol.for('deviceforge.android-artifacts-browser.probe')]; report.harnessDomRemoved = Object.values(targets).every((target) => !target.isConnected); }
  return report;
}
