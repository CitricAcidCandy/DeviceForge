import { ok, equal, uuid, sha256, receipt, finished, jobShape, raw, mcp, names, operation, capture } from './evidence.mjs';
import { lifecycleScenarios } from './lifecycle-scenarios.mjs';

export async function runScenarios(env) {
  const { runtime, config, report, signal, step } = env;
  const probe = () => globalThis[Symbol.for('deviceforge.android-artifacts-browser.probe')];
  const context = () => probe().context;
  const state = {};
  await step('AA-B01-在线浏览器插件与API3能力预算', async () => {
    const archive = await fetch('/__fixture/browser.tgz', { signal: AbortSignal.timeout(5000) }).then((reply) => { ok(reply.ok, '本次浏览器归档不可读'); return reply.blob(); });
    const installed = await runtime.pluginPackages.upload('browser', archive, 'application/gzip', signal);
    receipt(installed, report, '/api/v2/plugin-packages/browser?format=tgz', 201);
    ok(installed.data.id === config.browserId, '浏览器包身份不符');
    await runtime.pluginPackages.enable('browser', config.browserId, signal);
    ok(context().apiVersion === 2 && context().devices && context().artifacts && context().taskHistory, '公开上下文缺设备、产物或历史端口');
    await runtime.webPlugins.mount(config.browserId, config.panelIds.left);
    await runtime.webPlugins.mount(config.browserId, config.panelIds.right);
    const providers = await context().devices.refreshProviders(signal); receipt(providers, report, '/api/v2/device-providers');
    state.provider = providers.data.find((item) => item.id === 'android-device'); ok(state.provider, '缺真实安卓提供者');
    const definition = state.provider.definition;
    ok(definition.apiVersion === 3 && definition.platform === 'android', '设备定义版本或平台不符');
    equal(definition.capabilities.map((item) => item.id), names, '九能力集合或顺序不符');
    for (const name of names) {
      const item = definition.capabilities.find((entry) => entry.id === name);
      ok(item.operation === operation(name) && item.version === 1, '能力operation或版本不符');
      if (['app.install', 'screenshot'].includes(name)) ok(item.scope === 'device' && item.access === 'write'
        && item.executionTimeoutMs === (name === 'app.install' ? 120000 : 30000), '安装/截图准入或预算不符');
    }
    const directory = await context().devices.refreshProvider(state.provider.id, state.provider.generation, signal);
    receipt(directory, report, '/api/v2/device-providers/android-device/refresh');
    equal(directory.data.devices.map((item) => item.reference.localId).sort(), ['input-error', 'input-ok', 'ok', 'stderr-failure'], '受控设备目录不符');
    ok(directory.data.devices.every((item) => item.state === 'online'
      && ['app.install', 'screenshot'].every((name) => item.capabilities.some((capability) => capability.id === name && capability.version === 1 && capability.available))), '受控设备不在线或缺能力');
    const operations = await context().listOperations(signal); receipt(operations, report, '/api/v2/operations');
    equal(operations.data.filter((item) => item.id.startsWith('plugin.android-device.')).map((item) => item.id).sort(), ['discover', ...names].map(operation).sort(), '十贡献集合不符');
    state.action = (capability, input = {}, deviceId = 'ok') => ({ providerId: state.provider.id,
      generation: state.provider.generation, deviceId, capability, version: 1, input });
    report.provider = state.provider;
    return { installed: installed.data, provider: state.provider, directory: directory.data, moduleIdentity: probe().moduleIdentity };
  });
  await step('AA-B02-公开上传APK与安装五字段Job', async () => {
    const content = await fetch('/__fixture/apk', { signal: AbortSignal.timeout(5000) }).then((reply) => reply.blob());
    const uploaded = await context().artifacts.upload('fixture.apk', content, signal);
    receipt(uploaded, report, '/api/v2/artifacts?filename=fixture.apk', 201);
    ok(uuid(uploaded.data.id) && uploaded.data.filename === 'fixture.apk' && uploaded.data.size === content.size
      && uploaded.data.sha256 === config.apkSha256, '上传产物元数据不符');
    state.artifact = uploaded.data;
    const accepted = await context().devices.invoke(state.action('app.install', { artifact_id: uploaded.data.id }), signal);
    receipt(accepted, report, '/api/v2/device-actions', 202); jobShape(accepted.data);
    const completed = await finished(context(), accepted.data.id, signal);
    receipt(completed, report, '/api/v2/jobs/' + accepted.data.id); jobShape(completed.data);
    ok(completed.data.status === 'succeeded', '安装任务失败：' + completed.data.error);
    const wrapped = completed.data.result;
    ok(wrapped && wrapped.result?.artifact_id === uploaded.data.id && typeof wrapped.result.output === 'string'
      && wrapped.result.output.includes('Success'), '安装runtime值不符');
    equal(wrapped.artifacts, [], '安装不能额外生成产物');
    ok(!/[A-Za-z]:[\\/]|\\\\|deviceforge-android-artifacts-|deviceforge-android-device-/.test(wrapped.result.output), '安装output泄漏本次私有路径');
    state.install = completed.data;
    report.jobs = [{ kind: 'install', job: completed.data, input: { device_id: 'ok', input: { artifact_id: uploaded.data.id } } }];
    return { uploaded, accepted, completed };
  });
  await step('AA-B03-截图唯一实体与PNG逐字节下载', async () => {
    const accepted = await context().devices.invoke(state.action('screenshot'), signal);
    receipt(accepted, report, '/api/v2/device-actions', 202);
    const completed = await finished(context(), accepted.data.id, signal); jobShape(completed.data);
    receipt(completed, report, '/api/v2/jobs/' + accepted.data.id);
    ok(completed.data.status === 'succeeded' && completed.data.result?.result === null, '截图任务状态或runtime值不符');
    const artifacts = completed.data.result?.artifacts; ok(Array.isArray(artifacts) && artifacts.length === 1, '截图不是唯一宿主产物');
    state.screenshotArtifact = artifacts[0]; state.screenshot = completed.data;
    ok(uuid(state.screenshotArtifact.id) && state.screenshotArtifact.filename === 'screenshot.png'
      && state.screenshotArtifact.sha256 === config.pixelSha256, '宿主截图实体身份或摘要不符');
    const downloaded = await context().artifacts.download(state.screenshotArtifact.id, signal);
    receipt(downloaded, report, '/api/v2/artifacts/' + state.screenshotArtifact.id + '/content');
    const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
    equal([...bytes], config.pixelBytes, '截图原字节改变'); ok(await sha256(bytes) === config.pixelSha256, 'PNG SHA256不符');
    report.jobs.push({ kind: 'screenshot', job: completed.data, input: { device_id: 'ok', input: {} } });
    report.screenshot = { artifact: state.screenshotArtifact, bytes: bytes.length, sha256: await sha256(bytes), logId: downloaded.logId };
    return { accepted, completed, download: report.screenshot };
  });
  await step('AA-B04-HTTP与MCP同任务历史及事件', async () => {
    report.history = [];
    for (const entry of report.jobs) {
      const path = '/api/v2/jobs/' + entry.job.id;
      const http = await raw(path); ok(http.status === 200, 'HTTP历史查询失败');
      const sdkHistory = await context().taskHistory.get(entry.job.id, signal);
      receipt(sdkHistory, report, path);
      equal(sdkHistory.data, { id: http.data.id, operation: http.data.operation, status: http.data.status,
        result: http.data.result, error: http.data.error, input: http.data.input, createdAt: http.data.created_at }, '公开SDK历史映射不符');
      equal(await mcp('deviceforge.get_job', { id: entry.job.id }, report), http.data, 'HTTP/MCP历史Job不同');
      equal(http.data.input, entry.input, '嵌套设备输入历史不符');
      equal(http.data.result, entry.job.result, 'SDK与历史结果包装不符');
      const events = await raw(path + '/events');
      equal(await mcp('deviceforge.job_events', { id: entry.job.id, after: 0 }, report), events.data, 'HTTP/MCP事件不同');
      ok(events.data.every((event) => event.job_id === entry.job.id), '事件关联错误');
      ok(events.data.filter((event) => ['succeeded', 'failed', 'cancelled'].includes(event.status)).length === 1, '终态事件不唯一');
      report.history.push({ job: http.data, sdkJob: sdkHistory.data, events: events.data, httpLogId: http.logId, eventLogId: events.logId });
    }
    return report.history;
  });
  await step('AA-B05-真实输入拒绝与业务失败分离', async () => {
    const invalid = [];
    for (const action of [state.action('app.install', { artifact_id: 'bad-uuid' }), state.action('screenshot', { extra: true })]) {
      const rejected = await capture(() => context().devices.invoke(action, signal));
      ok(!rejected.ok && rejected.error.kind === 'http' && rejected.error.status === 400
        && rejected.error.code === 'invalid_input', '业务schema未保留真实400 invalid_input');
      receipt(rejected.error, report, '/api/v2/device-actions', 400); invalid.push(rejected);
    }
    const missingId = crypto.randomUUID();
    const missingInstall = await capture(() => context().devices.invoke(state.action('app.install', { artifact_id: missingId }), signal));
    let missingInstallation;
    if (missingInstall.ok) {
      receipt(missingInstall.result, report, '/api/v2/device-actions', 202);
      const result = await finished(context(), missingInstall.result.data.id, signal);
      ok(result.data.status === 'failed' && typeof result.data.error === 'string' && result.data.error, '缺失安装产物未形成失败Job');
      missingInstallation = { accepted: missingInstall.result, failed: result };
    } else {
      ok(missingInstall.error.kind === 'http' && missingInstall.error.status === 404
        && missingInstall.error.code === 'not_found', '缺失安装产物既非失败Job也非真实404');
      receipt(missingInstall.error, report, '/api/v2/device-actions', 404); missingInstallation = missingInstall;
    }
    const missing = await capture(() => context().artifacts.download(missingId, signal));
    ok(!missing.ok && missing.error.kind === 'http' && missing.error.status === 404
      && missing.error.code === 'not_found', '缺失产物未保留真实404');
    receipt(missing.error, report, '/api/v2/artifacts/' + missingId + '/content', 404);
    const accepted = await context().devices.invoke(state.action('app.install', { artifact_id: state.artifact.id }, 'stderr-failure'), signal);
    receipt(accepted, report, '/api/v2/device-actions', 202);
    const failed = await finished(context(), accepted.data.id, signal); jobShape(failed.data);
    ok(failed.data.status === 'failed' && failed.data.result === null && typeof failed.data.error === 'string'
      && failed.data.error, '工具stderr未形成字符串错误失败Job');
    const http = await raw('/api/v2/jobs/' + failed.data.id);
    equal(await mcp('deviceforge.get_job', { id: failed.data.id }, report), http.data, '失败Job双端历史不同');
    report.failedJob = { job: failed.data, history: http.data };
    return { invalid, missingInstallation, missing, accepted, failed };
  });
  await lifecycleScenarios({ ...env, probe, context, state });
}
