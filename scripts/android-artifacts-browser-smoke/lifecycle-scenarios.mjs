import { ok, equal, capture, receipt, raw, mcp, sha256, finished } from './evidence.mjs';

async function zeroTransfers(context, state, signal, report) {
  const before = report.transport.length; const results = [];
  for (const run of [() => context.artifacts.upload('revoked.apk', new Blob(['PK']), signal),
    () => context.artifacts.download(state.screenshotArtifact.id, signal),
    () => context.devices.invoke(state.action('screenshot'), signal),
    () => context.getJob(state.screenshot.id, signal)]) {
    const reply = await capture(run); results.push(reply);
    ok(!reply.ok && reply.error.kind === 'cancelled' && reply.error.logId === null, '旧引用/预取消未本地撤销');
  }
  ok(report.transport.length === before, '撤销引用产生真实传输');
  return { results, transfers: report.transport.length - before };
}

export async function lifecycleScenarios(env) {
  const { runtime, config, report, signal, step, state, probe, context, targets } = env;
  await step('AA-B06-预取消与面板撤销兄弟隔离', async () => {
    const preabort = await zeroTransfers(context(), state, AbortSignal.abort(), report);
    const current = probe(); const left = current.panels.left; const right = current.panels.right;
    await runtime.webPlugins.unmount(config.browserId, config.panelIds.left);
    ok(left.disposed && left.releases === 1 && left.context.signal.aborted && targets.left.childElementCount === 0, '子作用域资源未释放');
    const revoked = await zeroTransfers(left.context, state, signal, report);
    ok(!right.disposed && !right.context.signal.aborted, '撤销左侧关闭兄弟');
    const sibling = await right.context.artifacts.download(state.screenshotArtifact.id, signal);
    receipt(sibling, report, '/api/v2/artifacts/' + state.screenshotArtifact.id + '/content');
    ok(await sha256(new Uint8Array(await sibling.data.arrayBuffer())) === config.pixelSha256, '兄弟不能读取产物');
    return { preabort, revoked, leftReleases: left.releases, siblingStillLive: true };
  });
  await step('AA-B07-提供者热卸载历史与新代隔离', async () => {
    const oldProvider = state.provider; const oldAction = state.action('screenshot');
    await runtime.serverPlugins.unload(oldProvider.id, signal);
    const snapshot = context().devices.snapshot();
    ok(!snapshot.providers.some((item) => item.id === oldProvider.id)
      && !snapshot.directories.some((item) => item.provider.id === oldProvider.id), '卸载残留旧提供者缓存');
    const count = report.transport.length; const removed = await capture(() => context().devices.invoke(oldAction, signal));
    ok(!removed.ok && removed.error.code === 'not_found' && removed.error.logId === null
      && report.transport.length === count, '卸载旧设备动作未本地拒绝');
    const afterUnload = [];
    for (const original of report.history) {
      const job = await raw('/api/v2/jobs/' + original.job.id);
      const events = await raw('/api/v2/jobs/' + original.job.id + '/events');
      equal(job.data, original.job, '卸载改变历史Job'); equal(events.data, original.events, '卸载改变事件');
      equal(await mcp('deviceforge.get_job', { id: original.job.id }, report), original.job, '卸载后MCP历史不同');
      equal(await mcp('deviceforge.job_events', { id: original.job.id, after: 0 }, report), original.events, '卸载后MCP事件不同');
      afterUnload.push({ job: job.data, events: events.data });
    }
    const retained = await context().artifacts.download(state.screenshotArtifact.id, signal);
    receipt(retained, report, '/api/v2/artifacts/' + state.screenshotArtifact.id + '/content');
    ok(await sha256(new Uint8Array(await retained.data.arrayBuffer())) === config.pixelSha256, '卸载改变截图产物');
    await runtime.serverPlugins.load(oldProvider.id, signal);
    const current = (await context().devices.refreshProviders(signal)).data.find((item) => item.id === oldProvider.id);
    ok(current && current.generation !== oldProvider.generation, '重载没有新generation');
    const oldCount = report.transport.length; const old = await capture(() => context().devices.invoke(oldAction, signal));
    ok(!old.ok && old.error.code === 'conflict' && old.error.status === 409
      && old.error.logId === null && report.transport.length === oldCount, '新代复活旧代设备引用');
    const wireOld = await raw('/api/v2/device-actions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider_id: oldAction.providerId, generation: oldAction.generation,
        device_id: oldAction.deviceId, capability: oldAction.capability, version: oldAction.version, input: oldAction.input }) });
    ok(wireOld.status === 409 && wireOld.error?.code === 'conflict', '真实服务未拒绝旧generation');
    await context().devices.refreshProvider(current.id, current.generation, signal);
    const accepted = await context().devices.invoke({ ...oldAction, generation: current.generation }, signal);
    const completed = await finished(context(), accepted.data.id, signal);
    ok(completed.data.status === 'succeeded', '新代截图不能调用');
    report.generations = { first: oldProvider.generation, second: current.generation };
    await runtime.serverPlugins.unload(current.id, signal);
    return { removed, afterUnload, old, wireOld, newJob: completed.data, generations: report.generations, artifactRetained: true };
  });
  await step('AA-B08-浏览器卸载与新实例旧引用撤销', async () => {
    const previous = probe(); const right = previous.panels.right;
    await runtime.pluginPackages.disable('browser', config.browserId, signal);
    ok(previous.disposed && previous.context.signal.aborted && right.disposed && right.releases === 1
      && targets.right.childElementCount === 0, '整插件资源未释放');
    const revoked = await zeroTransfers(previous.context, state, signal, report);
    await runtime.pluginPackages.enable('browser', config.browserId, signal);
    const current = probe(); ok(current !== previous && current.moduleIdentity !== previous.moduleIdentity
      && !current.context.signal.aborted, '新浏览器代复用旧实例');
    const downloaded = await current.context.artifacts.download(state.screenshotArtifact.id, signal);
    receipt(downloaded, report, '/api/v2/artifacts/' + state.screenshotArtifact.id + '/content');
    ok(await sha256(new Uint8Array(await downloaded.data.arrayBuffer())) === config.pixelSha256, '新浏览器实例不能读取历史产物');
    const stillRevoked = await zeroTransfers(previous.context, state, signal, report);
    await runtime.pluginPackages.remove('browser', config.browserId, signal);
    return { revoked, stillRevoked, oldModule: previous.moduleIdentity, newModule: current.moduleIdentity,
      leftReleases: previous.panels.left.releases, rightReleases: right.releases, esmMemoryRemoved: false };
  });
  await step('AA-B09-runtime销毁与公开根引用零传输', async () => {
    const rootContext = runtime.host; await runtime.dispose();
    const revoked = await zeroTransfers(rootContext, state, signal, report);
    ok(!report.transport.some((entry) => entry.path.endsWith('/cancel')), '调用等待撤销不应取消后台Job');
    return { revoked, runtimeDisposed: true, callerAbortStopsTool: false };
  });
}
