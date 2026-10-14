import { createFrontendRuntime } from '/assets/plugin-host.js';

const providerId = 'raw_browser_provider';
const browserId = 'raw_browser_probe';
const probeKey = Symbol.for('deviceforge.unified-discovery-browser.probe');
const check = (value, message) => {
  if (!value) throw new Error(message);
};
const brief = (error) => ({
  code: error?.code ?? null,
  kind: error?.kind ?? null,
  status: error?.status ?? null,
  logId: error?.logId ?? null,
  message: String(error?.message ?? error).slice(0, 500),
});
async function timely(pending, label) {
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`本地取消未及时收敛：${label}`)), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function eventually(read, predicate, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`等待超时：${label}`);
}

// 仅验收页消费生产公开入口；所有 API 成功数据来自真实 Rust 服务。
export async function verifyUnifiedDiscovery() {
  const report = {
    passed: false,
    checks: [],
    response_log_ids: [],
    boundaries: [
      '模拟提供者原文，不是真机状态',
      'HTTP 延迟只证明消费，不证明内部 attemptgate 决定点',
      '不覆盖 MCP、旧数组绑定、重启、两额度、总期限或历史成功但接受拒绝的内部竞争',
    ],
  };
  const signal = AbortSignal.timeout(55000);
  const panel = document.createElement('section');
  document.body.append(panel);
  const runtime = createFrontendRuntime({
    baseUrl: location.origin,
    transport: fetch.bind(globalThis),
    panelTarget: () => panel,
    esmImporter: async (url, current) => {
      current.throwIfAborted();
      return import(url);
    },
  });
  const devices = runtime.host.devices;
  const json = async (path, body) => {
    const response = await fetch(path, {
      signal,
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            body: JSON.stringify(body),
            headers: { 'content-type': 'application/json' },
          }),
    });
    const envelope = await response.json();
    check(response.ok, `真实接口失败：${response.status}/${envelope.error?.code}`);
    if (path.startsWith('/api/')) {
      check(
        envelope.log_id === response.headers.get('x-deviceforge-log-id') && envelope.log_id,
        '真实日志 ID 不一致',
      );
      report.response_log_ids.push(envelope.log_id);
      return envelope.data;
    }
    return envelope;
  };
  const step = async (id, work) => {
    report.stage = id;
    const entry = { id, passed: false };
    report.checks.push(entry);
    try {
      entry.evidence = await work();
      signal.throwIfAborted();
      entry.passed = true;
    } catch (error) {
      entry.error = brief(error);
      throw error;
    }
  };
  const capture = (pending) =>
    pending.then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error: brief(error) }),
    );
  const provider = async () => {
    const result = await devices.refreshProviders(signal);
    const entry = result.data.find((item) => item.id === providerId);
    check(entry, '提供者未被公开目录发现');
    return entry;
  };
  const job = async (id) => {
    const reply = await eventually(
      () => runtime.tasks.get(id, signal),
      (result) => ['succeeded', 'failed', 'cancelled'].includes(result.data.status),
      '任务终态',
    );
    check(reply.data.status === 'succeeded', '真实任务未成功');
    return reply.data;
  };
  const gate = async () => {
    await json('/__control/gate/arm', {});
    return () =>
      eventually(
        () => json('/__control/gate/state'),
        (value) => value.phase === 'held',
        '真实响应门闩',
      );
  };
  try {
    check(devices, '生产 SDK 没有 devices');
    await step('RAW-B01-安装与映射', async () => {
      for (const kind of ['server', 'browser']) {
        const archive = await fetch(`/__fixture/${kind}.tgz`, { signal });
        check(archive.ok, '本次 TGZ 不可读');
        await runtime.pluginPackages.upload(kind, await archive.blob(), 'application/gzip', signal);
      }
      await runtime.pluginPackages.enable('server', providerId, signal);
      await runtime.pluginPackages.enable('browser', browserId, signal);
      await runtime.webPlugins.mount(browserId, `${browserId}.panel`);
      const entry = await provider();
      check(runtime.host.apiVersion === 2 && entry.definition.apiVersion === 3, '独立版本映射错误');
      check(
        entry.definition.capabilities.find((item) => item.id === 'device.echo')
          ?.executionTimeoutMs === 120000,
        'API3 能力预算未映射',
      );
      check(
        !Object.hasOwn(
          entry.definition.capabilities.find((item) => item.id === 'provider.configure') ?? {},
          'executionTimeoutMs',
        ),
        '未声明预算未省略',
      );
      await runtime.extensions.executeCommand(`${browserId}.refresh`, {}, signal);
      const directory = devices
        .snapshot()
        .directories.find((item) => item.provider.id === providerId);
      check(directory?.devices.length === 8, '同次完整目录不完整');
      const expectedIds = [
        'online',
        'recovery',
        'sideload',
        'bootloader',
        'unknown',
        'offline',
        'unauthorized',
        'none',
      ];
      check(
        expectedIds.every((id) => directory.devices.some((item) => item.reference.localId === id)),
        '模拟观测身份缺失',
      );
      const raw = (id) => directory.devices.find((item) => item.reference.localId === id);
      for (const id of ['recovery', 'sideload', 'bootloader'])
        check(raw(id)?.state === 'unknown' && raw(id)?.rawState === id, '特殊原文映射丢失');
      check(raw('unknown')?.rawState === ' MixedCase 未知 ', '未知原文被 trim 或改写');
      check(!Object.hasOwn(raw('none') ?? {}, 'rawState'), 'None 必须省略 SDK 属性');
      const wire = (await json('/api/v2/devices')).find((item) => item.provider.id === providerId);
      check(wire?.provider.definition.api_version === 3, 'HTTP 设备 API 版本错误');
      check(
        wire.devices.find((item) => item.reference.local_id === 'unknown')?.raw_state ===
          ' MixedCase 未知 ',
        'HTTP 原文被改写',
      );
      check(
        !Object.hasOwn(
          wire.devices.find((item) => item.reference.local_id === 'none') ?? {},
          'raw_state',
        ),
        'HTTP None 未省略',
      );
      check(panel.textContent.includes('recovery'), '真实插件订阅没有更新 DOM');
      return {
        apiVersion: entry.definition.apiVersion,
        directoryJobId: directory.discoveryJobId,
        generation: entry.generation,
        raw_samples: directory.devices.map((item) => ({
          id: item.reference.localId,
          state: item.state,
          raw: item.rawState ?? null,
          omitted: !Object.hasOwn(item, 'rawState'),
        })),
      };
    });
    await step('RAW-B03-规范状态准入', async () => {
      const entry = await provider();
      const errors = [];
      for (const deviceId of [
        'recovery',
        'sideload',
        'bootloader',
        'unknown',
        'offline',
        'unauthorized',
      ]) {
        const result = await capture(
          devices.invoke(
            {
              providerId,
              generation: entry.generation,
              deviceId,
              capability: 'device.echo',
              version: 1,
              input: {},
            },
            signal,
          ),
        );
        check(
          !result.ok && result.error.code === 'conflict' && result.error.logId === null,
          '原文错误地放行动作或伪造日志',
        );
        errors.push({ deviceId, ...result.error });
      }
      const accepted = await devices.invoke(
        {
          providerId,
          generation: entry.generation,
          deviceId: 'online',
          capability: 'device.echo',
          version: 1,
          input: { source: 'real-browser' },
        },
        signal,
      );
      await job(accepted.data.id);
      return { refused: errors, onlineJobId: accepted.data.id };
    });
    await step('RAW-B02-None整份替换', async () => {
      const entry = await provider();
      const configure = async (mode) => {
        const submitted = await devices.invoke(
          {
            providerId,
            generation: entry.generation,
            deviceId: null,
            capability: 'provider.configure',
            version: 1,
            input: { mode },
          },
          signal,
        );
        await job(submitted.data.id);
      };
      await configure('none');
      const none = await devices.refreshProvider(providerId, entry.generation, signal);
      check(
        none.data.devices.every((item) => !Object.hasOwn(item, 'rawState')),
        '下一轮 None 残留旧原文',
      );
      const wire = (await json('/api/v2/devices')).find((item) => item.provider.id === providerId);
      check(
        wire.devices.every((item) => !Object.hasOwn(item, 'raw_state')),
        'HTTP 整份 None 残留旧原文',
      );
      check(
        globalThis[probeKey].snapshots
          .at(-1)
          .directories[0].devices.every((item) => !Object.hasOwn(item, 'rawState')),
        '插件订阅残留旧原文',
      );
      await configure('raw');
      await devices.refreshProvider(providerId, entry.generation, signal);
      return { noneJobId: none.data.discoveryJobId, restored: true };
    });
    await step('RAW-直接Job与目录关联', async () => {
      const submitted = await runtime.host.submit(`plugin.${providerId}.discover`, {}, signal);
      await job(submitted.data.id);
      const observed = await devices.refreshDirectories(signal);
      check(
        observed.data.find((item) => item.provider.id === providerId)?.discoveryJobId ===
          submitted.data.id,
        '直接发现未发布自己的目录',
      );
      return { jobId: submitted.data.id };
    });
    await step('RAW-refresh自己的回执', async () => {
      const entry = await provider();
      const waitHeld = await gate();
      const waiting = capture(
        json(`/api/v2/device-providers/${providerId}/refresh`, { generation: entry.generation }),
      );
      const held = await waitHeld();
      const next = await json(`/api/v2/device-providers/${providerId}/refresh`, {
        generation: entry.generation,
      });
      check(held.jobId !== next.discovery_job_id, 'A/B 未形成不同真实发现');
      const current = await json('/api/v2/devices');
      check(
        current.find((item) => item.provider.id === providerId)?.discovery_job_id ===
          next.discovery_job_id,
        'GET 未读取 B',
      );
      await json('/__control/gate/release', {});
      const receipt = await waiting;
      check(receipt.ok && receipt.value.discovery_job_id === held.jobId, 'A 响应冒用了 B 的目录');
      return {
        receiptA: held.jobId,
        currentB: next.discovery_job_id,
        logIdA: held.logId,
        boundary: '仅延迟已取得的真实 HTTP 响应，不等于内部等待者/存储门闩',
      };
    });
    await step('RAW-晚到A不覆盖B', async () => {
      const entry = await provider();
      const waitHeld = await gate();
      const waiting = capture(devices.refreshProvider(providerId, entry.generation, signal));
      const held = await waitHeld();
      const next = await json(`/api/v2/device-providers/${providerId}/refresh`, {
        generation: entry.generation,
      });
      await devices.refreshDirectories(signal);
      check(
        devices.snapshot().directories[0]?.discoveryJobId === next.discovery_job_id,
        '本地 B 未安装',
      );
      await json('/__control/gate/release', {});
      const late = await waiting;
      check(
        !late.ok && late.error.code === 'stale_device_result' && late.error.logId === held.logId,
        'A 没有按修订拒绝',
      );
      check(
        devices.snapshot().directories[0]?.discoveryJobId === next.discovery_job_id,
        'A 覆盖或清掉 B',
      );
      return { receiptA: held.jobId, retainedB: next.discovery_job_id, rejection: late.error };
    });
    await step('RAW-浏览器热卸载', async () => {
      const old = globalThis[probeKey];
      const waitHeld = await gate();
      const waiting = capture(
        runtime.extensions.executeCommand(`${browserId}.refresh`, {}, signal),
      );
      const held = await waitHeld();
      await runtime.pluginPackages.disable('browser', browserId, signal);
      const cancelled = await timely(waiting, '浏览器插件卸载');
      check(!cancelled.ok && cancelled.error.kind === 'cancelled', '卸载未及时结束插件等待');
      check(old.closed && panel.children.length === 0, '插件生命周期或 DOM 未撤销');
      const notifications = old.notifications;
      const writes = old.writes;
      await devices.refreshDirectories(signal);
      await json('/__control/gate/release', {});
      await runtime.pluginPackages.enable('browser', browserId, signal);
      const next = globalThis[probeKey];
      check(next !== old && next.dependencyRun !== old.dependencyRun, '新代复用相对模块或旧上下文');
      check(old.notifications === notifications && old.writes === writes, '旧订阅或旧调用复活');
      check(
        devices.snapshot().directories[0]?.discoveryJobId === held.jobId,
        '浏览器卸载错误地回滚服务端已接受目录',
      );
      let closed = false;
      try {
        old.context.devices.snapshot();
      } catch (error) {
        closed = error.kind === 'cancelled';
      }
      check(closed, '旧插件设备入口仍可使用');
      return { acceptedJob: held.jobId, cancelled: cancelled.error, relativeModuleReloaded: true };
    });
    await step('RAW-服务器热卸载与换代', async () => {
      const old = await provider();
      await devices.refreshProvider(providerId, old.generation, signal);
      devices.select({ providerId, generation: old.generation, localId: 'online' });
      const waitHeld = await gate();
      const waiting = capture(devices.refreshProvider(providerId, old.generation, signal));
      const held = await waitHeld();
      await runtime.pluginPackages.disable('server', providerId, signal);
      const cancelled = await timely(waiting, '服务器管理撤销');
      check(!cancelled.ok && cancelled.error.kind === 'cancelled', '本实例服务器管理未撤销旧等待');
      check(
        devices.snapshot().directories.length === 0 && devices.snapshot().selection === null,
        '管理后目录/选择未撤销',
      );
      check((await json('/api/v2/devices')).length === 0, '服务器卸载仍保留旧代目录');
      await runtime.pluginPackages.enable('server', providerId, signal);
      const next = await provider();
      check(next.generation !== old.generation, '提供者没有换代');
      check(devices.snapshot().directories.length === 0, '新代未发现却恢复旧观测');
      const fresh = await devices.refreshProvider(providerId, next.generation, signal);
      await json('/__control/gate/release', {});
      check(
        devices.snapshot().directories[0]?.discoveryJobId === fresh.data.discoveryJobId,
        '旧代晚响应破坏新代目录',
      );
      const stale = await capture(
        devices.invoke(
          {
            providerId,
            generation: old.generation,
            deviceId: 'online',
            capability: 'device.echo',
            version: 1,
            input: {},
          },
          signal,
        ),
      );
      check(
        !stale.ok && stale.error.code === 'conflict' && stale.error.logId === null,
        'SDK 旧引用未本地拒绝',
      );
      const response = await fetch('/api/v2/device-actions', {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider_id: providerId,
          generation: old.generation,
          device_id: 'online',
          capability: 'device.echo',
          version: 1,
          input: {},
        }),
      });
      const body = await response.json();
      check(
        response.status === 409 &&
          body.error?.code === 'conflict' &&
          body.log_id &&
          body.log_id === response.headers.get('x-deviceforge-log-id'),
        'HTTP 旧引用或真实日志错误',
      );
      report.response_log_ids.push(body.log_id);
      check((await job(held.jobId)).status === 'succeeded', '已接受历史被卸载改写');
      return {
        oldGeneration: old.generation,
        newGeneration: next.generation,
        oldAcceptedJob: held.jobId,
        newJob: fresh.data.discoveryJobId,
        httpConflictLogId: body.log_id,
      };
    });
    await step('RAW-部署删除', async () => {
      const processes = await json('/__control/process-evidence', {});
      check(processes.passed, '删除部署前未确认夹具进程退出');
      await runtime.pluginPackages.remove('browser', browserId, signal);
      await runtime.pluginPackages.remove('server', providerId, signal);
      check((await json('/api/v2/plugin-packages/server')).length === 0, '服务器部署删除失败');
      check((await json('/api/v2/plugin-packages/browser')).length === 0, '浏览器部署删除失败');
      return { currentInstanceStopped: true, esmMemoryUnloaded: false, processes };
    });
    await step('RAW-NODE-协议3原文与退出链', async () => {
      const id = 'raw_node_browser_provider';
      const archive = await fetch('/__fixture/raw-node.tgz', { signal });
      check(archive.ok, 'RAW-NODE TGZ 不可读');
      await runtime.pluginPackages.upload(
        'server',
        await archive.blob(),
        'application/gzip',
        signal,
      );
      await runtime.pluginPackages.enable('server', id, signal);
      const providers = await devices.refreshProviders(signal);
      const entry = providers.data.find((item) => item.id === id);
      check(entry?.definition.apiVersion === 3, 'RAW-NODE 设备版本映射错误');
      const clean = (label, cancelled = false) =>
        json('/__control/raw-node/cleaned', { label, cancelled });
      const samples = [];
      for (const rawCase of [
        'valid',
        'recovery',
        'sideload',
        'bootloader',
        'unknown',
        'missing',
        'null',
      ]) {
        const label = `browser-${rawCase}`;
        const state = rawCase === 'valid' ? 'online' : 'unknown';
        const configured = await json('/__control/raw-node/control', { label, rawCase, state });
        const reply = await devices.refreshProvider(id, entry.generation, signal);
        const actual = reply.data.devices[0];
        check(reply.data.devices.length === 1 && actual.state === state, 'RAW-NODE 规范观测错误');
        if (configured.rawState == null)
          check(!Object.hasOwn(actual, 'rawState'), 'RAW-NODE 缺省/null 没有省略');
        else check(actual.rawState === configured.rawState, 'RAW-NODE 原文没有透明保留');
        const exit = await clean(label);
        check(
          exit.protocol === 3 && exit.cleaned && exit.stdin_eof && exit.process_exited,
          'RAW-NODE 没有真实 EOF/退出',
        );
        samples.push({
          label,
          jobId: reply.data.discoveryJobId,
          raw: actual.rawState ?? null,
          cleanup: exit,
        });
        if (rawCase === 'valid') {
          const actionLabel = 'browser-raw-online-action';
          await json('/__control/raw-node/control', { label: actionLabel });
          const accepted = await devices.invoke(
            {
              providerId: id,
              generation: entry.generation,
              deviceId: actual.reference.localId,
              capability: 'device_read',
              version: 1,
              input: {},
            },
            signal,
          );
          await job(accepted.data.id);
          await clean(actionLabel);
          check(actual.rawState === ' Vendor.Recovery 模式 ', '实际厂商原文不符合冻结夹具');
          samples.push({
            label: actionLabel,
            jobId: accepted.data.id,
            normalizedOnlineAllowed: true,
          });
        }
      }
      const label = 'browser-cancel-held';
      const caller = new AbortController();
      await json('/__control/raw-node/control', {
        label,
        mode: 'hold',
        cancelMode: 'complete',
        state: 'unknown',
      });
      const pending = capture(
        devices.refreshProvider(id, entry.generation, AbortSignal.any([signal, caller.signal])),
      );
      const start = await json('/__control/raw-node/started', { label });
      check(start.protocol === 3, '没有观察到协议3真实执行开始');
      caller.abort();
      const cancelled = await timely(pending, 'RAW-NODE 调用方取消');
      check(
        !cancelled.ok && cancelled.error.kind === 'cancelled' && cancelled.error.logId === null,
        '本地取消错误或伪造日志',
      );
      const exit = await clean(label, true);
      check(
        exit.cancellation_received && exit.stdin_eof && exit.process_exited,
        '协议3取消/EOF/退出链不完整',
      );
      check(
        !(await json('/api/v2/devices')).some((item) => item.provider.id === id),
        '未完成候选因取消而发布',
      );
      await devices.refreshDirectories(signal);
      check(
        !devices.snapshot().directories.some((item) => item.provider.id === id),
        '取消候选恢复了本地目录',
      );
      const unloadLabel = 'browser-owner-unload';
      await json('/__control/raw-node/control', {
        label: unloadLabel,
        mode: 'hold',
        cancelMode: 'complete',
      });
      const ownerPending = capture(devices.refreshProvider(id, entry.generation, signal));
      await json('/__control/raw-node/started', { label: unloadLabel });
      await runtime.pluginPackages.disable('server', id, signal);
      const ownerCancelled = await timely(ownerPending, 'RAW-NODE 提供者卸载');
      report.ownerUnloadResult = ownerCancelled.ok ? { ok: true } : ownerCancelled;
      // 真正运行中的卸载可先返回服务器当前性拒绝，本地目录重查也可先撤销等待。
      const localRevocation = !ownerCancelled.ok && ownerCancelled.error.kind === 'cancelled';
      const ownerConflict =
        !ownerCancelled.ok &&
        ownerCancelled.error.kind === 'http' &&
        ownerCancelled.error.status === 409 &&
        ownerCancelled.error.code === 'conflict' &&
        /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(
          ownerCancelled.error.logId ?? '',
        );
      check(localRevocation || ownerConflict, '提供者卸载没有本地撤销或真实409 conflict');
      const ownerExit = await clean(unloadLabel, true);
      check(
        !devices.snapshot().providers.some((item) => item.id === id) &&
          !devices.snapshot().directories.some((item) => item.provider.id === id),
        '真实进程卸载后本地入口未收敛',
      );
      check(
        !(await json('/api/v2/devices')).some((item) => item.provider.id === id),
        '卸载后服务器残留候选',
      );
      await runtime.pluginPackages.enable('server', id, signal);
      const reloaded = (await devices.refreshProviders(signal)).data.find((item) => item.id === id);
      check(
        reloaded &&
          reloaded.generation !== entry.generation &&
          !devices.snapshot().directories.some((item) => item.provider.id === id),
        'RAW-NODE 新代错误恢复旧观测',
      );
      await json('/__control/raw-node/control', { label: 'browser-owner-new-generation' });
      const fresh = await devices.refreshProvider(id, reloaded.generation, signal);
      await clean('browser-owner-new-generation');
      await runtime.pluginPackages.remove('server', id, signal);
      check((await json('/api/v2/plugin-packages/server')).length === 0, 'RAW-NODE 部署删除失败');
      const recorded = await json('/__control/raw-node/events', {});
      return {
        samples,
        cancelled: cancelled.error,
        cancellationCleanup: exit,
        events: recorded.events.length,
        ownerUnload: {
          rejected: ownerCancelled.error,
          cleanup: ownerExit,
          newJobId: fresh.data.discoveryJobId,
          oldGeneration: entry.generation,
          newGeneration: reloaded.generation,
        },
        boundary: '真实 hold 工作未形成观测时取消；不代替 Succeeded 后 attemptgate 接受竞争',
      };
    });
    report.passed = true;
  } catch (error) {
    report.error = brief(error);
  } finally {
    try {
      await runtime.dispose();
      report.runtimeDisposed = true;
    } catch (error) {
      report.disposeError = brief(error);
      report.passed = false;
    }
    panel.remove();
    delete globalThis[probeKey];
  }
  return report;
}
