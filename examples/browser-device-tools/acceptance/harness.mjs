import { createFrontendRuntime } from '/assets/plugin-host.js';
import { createObservedImporter, observationBrief } from './probe-context.mjs';
import { check, brief, attempt, capture, timely, eventually, expectFailure, stepRecorder } from './browser-checks.mjs';

// 只从生产 ESM 入口装配，示例与消费者均经过真实在线包 API 加载。
export async function verifyExample() {
  const report = { passed: false, checks: [], response_log_ids: [], cleanup_errors: [],
    environment: { origin: location.origin, isSecureContext: window.isSecureContext,
      randomUUIDAvailable: typeof globalThis.crypto?.randomUUID === 'function' },
    boundaries: ['本机非 loopback LAN HTTP，不证明另一台同事机器', '设备提供者为真实进程模拟包，不是真机',
      'devices 缺省由公开上下文兼容适配显式省略，其他方法仍是生产宿主',
      '释放观测仅对应公开登记与本夹具，不证明任意可信代码副作用停止'] };
  const signal = AbortSignal.timeout(75000);
  const step = stepRecorder(report, signal);
  const observations = []; const optionalObservations = [];
  let runtime; let optionalRuntime; let configuration; let originalRun; let originalGeneration;
  let originalReference; let originalProvider; let historical;
  const json = async (path, input) => {
    const response = await fetch(path, { signal, ...(input === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    }) });
    const value = await response.json(); check(response.ok, '验收控制请求失败：' + path + '/' + response.status); return value;
  };
  const logged = (reply) => {
    check(typeof reply.logId === 'string' && reply.logId.length > 0, '真实 SDK 响应缺少日志 ID');
    report.response_log_ids.push(reply.logId); return reply;
  };
  const countSubmits = async () => (await json('/__control/stats')).filter((entry) => entry.path === '/api/v2/jobs' && entry.method === 'POST').length;
  const control = (action, label, extra = {}) => json('/__control/provider/' + action, { label, ...extra });
  const command = (name, input) => runtime.extensions.executeCommand(configuration.browserId + '.' + name, input, signal);
  const consumer = (method, jobId) => runtime.extensions.executeCommand(configuration.consumerId + '.call',
    { method, ...(jobId ? { jobId } : {}) }, signal);
  const finish = async (id, current = runtime) => {
    const reply = await eventually(() => current.host.getJob(id, signal),
      (value) => ['succeeded', 'failed', 'cancelled'].includes(value.data.status), 'Job 未在有限时间收敛', signal);
    logged(reply); check(reply.data.status === 'succeeded', '实际 Job 未成功：' + JSON.stringify(reply.data)); return reply.data;
  };
  const provider = async () => {
    logged(await command('refresh-devices', {}));
    const entry = runtime.host.devices.snapshot().providers.find((item) => item.id === configuration.providerId);
    check(entry, '生产目录没有本次提供者'); return entry;
  };
  const action = (reference) => ({ providerId: reference.providerId, generation: reference.generation,
    deviceId: reference.localId, capability: configuration.capability, version: configuration.version, input: {} });
  const ownCatalog = () => runtime.extensions.catalog();
  const ownCommands = () => ownCatalog().commands.filter((entry) => entry.pluginId === configuration.browserId);
  const ownServices = () => ownCatalog().services.filter((entry) => entry.pluginId === configuration.browserId);
  const newRuntime = (omitDevices, records) => createFrontendRuntime({ baseUrl: location.origin,
    transport: fetch.bind(globalThis), panelTarget: () => null,
    esmImporter: createObservedImporter({ browserId: configuration.browserId, observations: records, omitDevices }) });
  try {
    await step('EXB-01-LAN与正式在线包', async () => {
      check(window.isSecureContext === false, '必须实际使用非安全 LAN HTTP，不能用 loopback 替代');
      check(typeof globalThis.crypto?.randomUUID !== 'function', '本场景要求浏览器实际缺少 randomUUID');
      configuration = await json('/__configuration');
      check(new URL(location.href).hostname === configuration.lanHost, '浏览器未使用本次实际 LAN 地址');
      runtime = newRuntime(false, observations);
      for (const [kind, name] of [['server', 'provider'], ['browser', 'example'], ['browser', 'consumer']]) {
        const response = await fetch('/__fixture/' + name + '.tgz', { signal }); check(response.ok, '本次原包不可读');
        logged(await runtime.pluginPackages.upload(kind, await response.blob(), 'application/gzip', signal));
      }
      await runtime.pluginPackages.enable('server', configuration.providerId, signal);
      await runtime.pluginPackages.enable('browser', configuration.browserId, signal);
      await runtime.pluginPackages.enable('browser', configuration.consumerId, signal);
      check(ownCommands().length === 8 && ownServices().length === 2, '实际贡献数量不符');
      check(observations.length === 1, '示例没有经公开 ESM loader 激活');
      const current = logged(await command('catalog', {})).data;
      originalRun = current.runId; originalGeneration = ownCommands()[0].generation;
      check(typeof originalRun === 'string' && originalRun, '不安全上下文下激活标记缺失');
      return { runId: originalRun, generation: originalGeneration, commandIds: ownCommands().map((entry) => entry.id),
        serviceIds: ownServices().map((entry) => entry.id), loader: observationBrief(observations[0]) };
    });
    await step('EXB-02-能力目录与设备命令', async () => {
      originalProvider = await provider();
      await control('set', 'initial_discovery');
      const discovered = logged(await command('discover', { providerId: originalProvider.id, generation: originalProvider.generation }));
      await control('cleaned', 'initial_discovery');
      const directory = runtime.host.devices.snapshot().directories.find((entry) => entry.provider.id === originalProvider.id);
      check(directory?.discoveryJobId === discovered.data.discoveryJobId, '发现回执与当前接受观测不符');
      const device = directory.devices.find((entry) => entry.reference.localId === configuration.localId);
      check(device?.state === 'online', '没有当前可用模拟设备');
      originalReference = device.reference;
      const selected = await command('select', originalReference); check(selected.logId === null, '本地选择不能伪造日志');
      await control('set', 'read_call');
      const submitted = logged(await command('invoke-read', action(originalReference)));
      historical = await finish(submitted.data.id);
      await control('cleaned', 'read_call');
      check(historical.result?.result?.synthetic_device === true && Array.isArray(historical.result.artifacts), '协议3结果包装未原样消费');
      const mismatch = expectFailure(await attempt(() => command('invoke-read', { ...action(originalReference), version: 2 })),
        { code: 'example_capability_unavailable' });
      const write = expectFailure(await attempt(() => command('invoke-read', { ...action(originalReference), capability: 'device_write' })),
        { code: 'example_read_only' });
      return { reference: originalReference, discoveryJobId: directory.discoveryJobId,
        job: historical, rejectedVersion: mismatch, rejectedWrite: write };
    });
    await step('EXB-03-普通任务与跨插件服务', async () => {
      await control('set', 'ordinary_discovery');
      const submitted = logged(await command('submit', { operation: configuration.discoverOperation, input: {} }));
      const job = await finish(submitted.data.id); await control('cleaned', 'ordinary_discovery');
      const catalog = logged(await consumer('catalog'));
      check(catalog.data.runId === originalRun, '第三方消费者没有调用实际示例服务');
      const history = logged(await consumer('history', historical.id));
      check(JSON.stringify(history.data) === JSON.stringify(historical), '历史服务改写了公开 Job');
      await control('set', 'cancel_read', { hold: true });
      const cancellable = logged(await command('invoke-read', action(originalReference)));
      await control('started', 'cancel_read');
      const cancelled = logged(await command('cancel-job', { jobId: cancellable.data.id }));
      check(cancelled.data.id === cancellable.data.id, '显式取消未返回对应 Job');
      const terminal = logged(await eventually(() => runtime.host.getJob(cancellable.data.id, signal),
        (value) => ['succeeded', 'failed', 'cancelled'].includes(value.data.status), '显式取消的Job未结束', signal));
      check(terminal.data.status === 'cancelled', '显式取消没有收敛为cancelled');
      const cleanup = await control('cleaned', 'cancel_read', { cancelled: true });
      return { ordinaryJobId: job.id, historyJobId: history.data.id,
        cancellationJobId: terminal.data.id, cancellationStatus: terminal.data.status, cleanup };
    });
    await step('EXB-04-可选devices缺省兼容', async () => {
      optionalRuntime = newRuntime(true, optionalObservations);
      await optionalRuntime.pluginPackages.enable('browser', configuration.browserId, signal);
      const execute = (name, input) => optionalRuntime.extensions.executeCommand(configuration.browserId + '.' + name, input, signal);
      const catalog = logged(await execute('catalog', {}));
      check(catalog.data.devices === null, '兼容适配没有真正省略可选 devices');
      const unsupported = expectFailure(await attempt(() => execute('refresh-devices', {})), { code: 'example_devices_unsupported' });
      const history = logged(await optionalRuntime.extensions.callService(configuration.browserId + '.history-service',
        '1.0.0', { jobId: historical.id }, signal));
      check(JSON.stringify(history.data) === JSON.stringify(historical), '缺省 devices 影响了历史查询');
      await control('set', 'optional_discovery');
      const submitted = logged(await execute('submit', { operation: configuration.discoverOperation, input: {} }));
      const job = await finish(submitted.data.id, optionalRuntime); await control('cleaned', 'optional_discovery');
      check(optionalObservations.length === 1 && optionalObservations[0].subscriptions.devices === 0, '缺省路径仍登记设备订阅');
      await optionalRuntime.pluginPackages.disable('browser', configuration.browserId, signal);
      await optionalRuntime.dispose(); optionalRuntime = undefined;
      const observed = observationBrief(optionalObservations[0]);
      check(observed.aborted && observed.disposed && Object.values(observed.subscriptions).every((count) => count === 0), '缺省实例没有释放登记');
      return { adapter: '仅省略真实公开上下文的可选 devices；回调上下文同样省略',
        unsupported, historyJobId: history.data.id, ordinaryJobId: job.id, observed };
    });
    await step('EXB-05-提供者在途撤销换代与独立历史', async () => {
      await command('select', originalReference);
      await control('set', 'held_discovery', { hold: true });
      const pending = capture(command('discover', { providerId: originalProvider.id, generation: originalProvider.generation }));
      const started = await control('started', 'held_discovery');
      const stopping = capture(runtime.pluginPackages.disable('server', configuration.providerId, signal));
      const cancelled = expectFailure(await timely(pending, '提供者撤销没有及时结束浏览器等待'), { kind: 'cancelled' });
      const stop = await stopping; check(stop.ok, '真实提供者停用失败：' + JSON.stringify(stop));
      const cleanup = await control('cleaned', 'held_discovery', { cancelled: true });
      const snapshot = runtime.host.devices.snapshot();
      check(!snapshot.providers.some((entry) => entry.id === configuration.providerId)
        && !snapshot.directories.some((entry) => entry.provider.id === configuration.providerId)
        && snapshot.selection === null && snapshot.selected === null, '本地停用没有撤销目录与选择');
      const oldAction = expectFailure(await attempt(() => command('invoke-read', action(originalReference))),
        { code: 'example_capability_unavailable' });
      const history = logged(await consumer('history', historical.id));
      check(JSON.stringify(history.data) === JSON.stringify(historical), '提供者停用改变了历史 Job');
      await runtime.pluginPackages.enable('server', configuration.providerId, signal);
      const next = await provider(); check(next.generation !== originalProvider.generation, '提供者重载未换代');
      await control('set', 'reload_discovery');
      logged(await command('discover', { providerId: next.id, generation: next.generation }));
      await control('cleaned', 'reload_discovery');
      const oldAfterReload = expectFailure(await attempt(() => command('invoke-read', action(originalReference))),
        { code: 'example_capability_unavailable' });
      const current = runtime.host.devices.snapshot().directories.find((entry) => entry.provider.id === next.id).devices[0].reference;
      await control('set', 'reload_read');
      const submitted = logged(await command('invoke-read', action(current)));
      await finish(submitted.data.id); await control('cleaned', 'reload_read');
      return { started, cleanup, cancelled, oldAction, oldAfterReload,
        oldGeneration: originalProvider.generation, newGeneration: next.generation, historyUnchanged: true };
    });
    const missingOperation = 'plugin.browser_example_missing.unavailable';
    await step('EXB-06-实际任务钩子停止提交', async () => {
      const before = await countSubmits();
      const failure = expectFailure(await attempt(() => runtime.host.submit(missingOperation, {}, signal)),
        { code: 'example_operation_unavailable' });
      const after = await countSubmits(); check(after === before, '目录检查失败后仍向服务器提交了 Job');
      return { error: failure, postJobsBefore: before, postJobsAfter: after };
    });
    await step('EXB-07-浏览器卸载撤销在途服务与贡献', async () => {
      await json('/__control/gate/arm', { jobId: historical.id });
      const pending = capture(consumer('history', historical.id));
      const held = await eventually(() => json('/__control/gate/state'), (entry) => entry.phase === 'held',
        '没有取得真实历史响应门闩', signal);
      const unloading = capture(runtime.pluginPackages.disable('browser', configuration.browserId, signal));
      const cancelled = expectFailure(await timely(pending, '浏览器卸载未及时结束跨插件服务等待'), { kind: 'cancelled' });
      const unload = await unloading; check(unload.ok, '示例插件停用失败：' + JSON.stringify(unload));
      check(ownCommands().length === 0 && ownServices().length === 0, '卸载后仍存在示例贡献');
      const observed = observationBrief(observations[0]);
      check(observed.aborted && observed.disposed && Object.values(observed.subscriptions).every((count) => count === 0), '卸载后示例登记未释放');
      const oldContext = expectFailure(await attempt(() => observations[0].context.listOperations(signal)), { kind: 'cancelled' });
      const eventsBefore = (await runtime.extensions.executeCommand(configuration.consumerId + '.events', {}, signal)).data;
      await runtime.operations.refresh(signal);
      const eventsAfter = (await runtime.extensions.executeCommand(configuration.consumerId + '.events', {}, signal)).data;
      check(eventsBefore.eventCount > 0 && eventsAfter.eventCount === eventsBefore.eventCount, '卸载后仍收到旧实例事件或此前从未收到事件');
      check(JSON.stringify(observationBrief(observations[0]).notifications) === JSON.stringify(observed.notifications), '旧实例订阅仍收到通知');
      const release = await json('/__control/gate/release', {});
      const unavailable = expectFailure(await attempt(() => consumer('history', historical.id)), { code: 'service_unavailable' });
      return { held, cancelled, release, unavailable, oldContext, observed, eventsBefore, eventsAfter };
    });
    await step('EXB-08-钩子恢复与新浏览器代次', async () => {
      const before = await countSubmits();
      const missing = expectFailure(await attempt(() => runtime.host.submit(missingOperation, {}, signal)), { kind: 'http' });
      check(typeof missing.logId === 'string' && missing.logId.length > 0, '钩子撤销后的服务端拒绝没有实际日志 ID');
      const after = await countSubmits(); check(after === before + 1, '钩子撤销后没有恢复真实提交链');
      await runtime.pluginPackages.enable('browser', configuration.browserId, signal);
      check(observations.length === 2, '重载没有创建新的插件上下文');
      const current = logged(await consumer('catalog')).data;
      const generation = ownCommands()[0]?.generation;
      check(current.runId !== originalRun && generation > originalGeneration, '浏览器重载复用了旧生命周期');
      check(observations[0].url !== observations[1].url, '重载没有使用新的 ESM 运行路径');
      const oldContext = expectFailure(await attempt(() => observations[0].context.extensions.callService(
        configuration.browserId + '.catalog-service', '1.0.0', {}, signal)), { kind: 'cancelled' });
      const state = observations[1].context.extensions.getState(configuration.browserId + '.catalog');
      check(state?.runId === current.runId, '新实例状态没有按公开所有权重新建立');
      return { errorAfterHookRemoved: missing, postJobsBefore: before, postJobsAfter: after,
        oldRunId: originalRun, newRunId: current.runId, oldGeneration: originalGeneration, newGeneration: generation, oldContext };
    });
    await step('EXB-09-删除当前实例与历史保留', async () => {
      await runtime.pluginPackages.remove('browser', configuration.browserId, signal);
      await runtime.pluginPackages.remove('browser', configuration.consumerId, signal);
      await runtime.pluginPackages.remove('server', configuration.providerId, signal);
      const browser = logged(await runtime.pluginPackages.refresh('browser', signal));
      const server = logged(await runtime.pluginPackages.refresh('server', signal));
      check(browser.data.length === 0 && server.data.length === 0, '本次独占部署根还有包残留');
      check(ownCatalog().commands.length === 0 && ownCatalog().services.length === 0, '删除后仍存在本次贡献');
      const history = logged(await runtime.host.getJob(historical.id, signal));
      check(JSON.stringify(history.data) === JSON.stringify(historical), '删除部署改变了旧 Job');
      check(!Object.hasOwn(history.data, 'execution') && !Object.hasOwn(history.data, 'rawState')
        && !Object.hasOwn(history.data, 'generation'), '历史 Job 被补写当前目录元数据');
      for (const record of observations) {
        const observed = observationBrief(record);
        check(observed.aborted && observed.disposed && Object.values(observed.subscriptions).every((count) => count === 0), '某代插件的公开登记未清理');
      }
      return { remainingBrowserPackages: browser.data.length, remainingServerPackages: server.data.length,
        remainingCommands: ownCatalog().commands.length, historyJobId: history.data.id };
    });
    report.passed = true;
  } catch (error) { report.error = brief(error); }
  finally {
    for (const [name, current] of [['optional', optionalRuntime], ['default', runtime]]) {
      if (!current) continue;
      try { await timely(current.dispose(), 'runtime 退出超时', 5000); }
      catch (error) { report.cleanup_errors.push({ runtime: name, error: brief(error) }); report.passed = false; }
    }
    report.observations = observations.map(observationBrief);
    report.optional_observations = optionalObservations.map(observationBrief);
  }
  return report;
}
