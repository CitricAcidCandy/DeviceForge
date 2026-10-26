import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBrowserEvidence } from '../plugin-installations-browser-smoke/evidence.mjs';
import { runPublicationBrowser } from '../plugin-publications-browser-smoke/browser.mjs';
import { ownedBrowserProcesses, reclaimOwnedBrowserProcesses } from '../plugin-publications-browser-smoke/verification.mjs';
import { assertListenerReleased } from '../unified-discovery-smoke/host.mjs';
import { assertNoOwnedResources } from './fixtures.mjs';
import { driverIdentities } from './freeze.mjs';
import { failureSummary, fileIdentity } from './evidence.mjs';
import { ledgerSnapshot } from './ledger.mjs';
import { recoveredWebrtcScenario } from './webrtc-scenario.mjs';

// 生产面板静态字节与生产工厂源码两层分别留证，不把源码探针叫作生产构建播放。
export async function runRecoveredWebrtc(context, directory) {
  const { host, fixture } = context;
  assert.ok(context.report.browsers?.[0]?.passed, '必须先通过同一非空故障的真实面板恢复');
  const frontend = fileURLToPath(new URL('../../frontend/', import.meta.url));
  const report = { passed: false, checks: { dom: false, visual_review: '等待视觉子代理' },
    scope: '同一真实隔离插件/设备恢复后，生产公开工厂源码在真实浏览器执行 WebRTC；非真机、非静态构建播放',
    product_proxy: [], cleanup_errors: [] };
  const profile = join(directory, 'browser-profile'); await mkdir(profile, { recursive: true });
  const vitePath = join(frontend, 'node_modules/vite/dist/node/index.js');
  let server, images, port, failure;
  try {
    report.source_inputs = [];
    for (const entry of [join(frontend, 'src/services/api/index.ts'), join(frontend, 'src/features/mirroring-streaming/index.ts')])
      report.source_inputs.push(...await driverIdentities(entry));
    report.vite_input = await fileIdentity(vitePath);
    const { createServer } = await import(pathToFileURL(vitePath).href);
    server = await createServer({ root: frontend, cacheDir: join(directory, 'vite-cache'), configFile: false, appType: 'custom', logLevel: 'error',
      optimizeDeps: { include: ['ajv', 'ajv-formats'] },
      server: { host: '127.0.0.1', port: 0, hmr: false, proxy: { '/api': {
        target: host.client.base, changeOrigin: false,
        configure(proxy) {
          proxy.on('proxyRes', (response, request) => {
            const item = { method: request.method, path: new URL(request.url, host.client.base).pathname,
              status: response.statusCode, log_id: response.headers['x-deviceforge-log-id'] ?? null };
            report.product_proxy.push(item);
            if (item.log_id) host.client.logIds.add(item.log_id);
          });
        },
      } } } });
    server.middlewares.use('/__recovery/capture', async (request, response) => {
      try {
        const name = new URL(request.url, 'http://127.0.0.1').searchParams.get('name');
        assert.equal(name, '04-webrtc-decoded');
        const result = await images.screenshot(name);
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
      } catch { response.statusCode = 500; response.end('本轮视频截图未保存'); }
    });
    server.middlewares.use('/__recovered_webrtc__', (_request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>恢复后真实 WebRTC</title><body><h1>同一合成设备恢复后的真实 WebRTC 播放</h1></body></html>');
    });
    await server.listen();
    port = server.httpServer.address().port;
    assert.ok(![7031, 5173].includes(port));
    const origin = `http://127.0.0.1:${port}`;
    images = createBrowserEvidence({ profile, directory, report, origin: () => origin });
    await runPublicationBrowser(origin + '/__recovered_webrtc__',
      `(${recoveredWebrtcScenario.toString()})(${JSON.stringify(fixture.device)})`, profile, report);
    assert.equal(report.browser.session.generation, context.generation);
    assert.ok(report.browser.answer_observed && report.browser.streaming_observed);
    assert.ok(report.browser.video.frames_decoded >= 15 && report.browser.video.total_frames >= 30);
    assert.equal(report.browser.user_input_messages, 0);
    const device = await assertNoOwnedResources(fixture, fixture.device);
    report.resources_after = device;
    assert.equal((await ledgerSnapshot(context)).records.length, 0);
    report.passed = true;
    for (const before of report.source_inputs) assert.deepEqual(await fileIdentity(before.path), before);
  } catch (error) { failure = error; report.failure = failureSummary(error, '恢复后真实浏览器 WebRTC'); }
  finally {
    images?.close();
    try {
      if (server) {
        server.httpServer?.closeAllConnections(); await server.close();
        if (port) { await assertListenerReleased(port); report.listener = { port, released: true }; }
        try { createRequire(vitePath)('esbuild').stop(); report.own_transform_service_stopped = true; }
        catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
      }
    } catch (error) { report.cleanup_errors.push(failureSummary(error, '本轮 Vite 源码探针收尾')); }
    try {
      let remaining = await ownedBrowserProcesses(profile);
      if (remaining.processes.length) { report.passed = false; remaining = await reclaimOwnedBrowserProcesses(profile, report); }
      report.browser_process_tree_after = remaining;
      assert.equal(remaining.processes.length, 0);
    } catch (error) { report.cleanup_errors.push(failureSummary(error, '本轮 WebRTC 浏览器收尾')); }
    if (report.cleanup_errors.length) report.passed = false;
    report.completed_at = new Date().toISOString();
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  if (failure) throw failure;
  assert.equal(report.passed, true, 'WebRTC 原始失败报告已保留');
  return report;
}
