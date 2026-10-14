import {
  check,
  equal,
  capture,
  bounded,
  control,
  waitGate,
  matchReceipt,
  zeroTransport,
} from './browser-evidence.mjs';
import { assertHistory } from './history-scenarios.mjs';

async function cancelAtReceipt(env, path, request, revoke, lateReject = false) {
  const gate = await env.transport.arm(path, lateReject);
  const settlement = { fulfilled: 0, rejected: 0 };
  const pending = Promise.resolve().then(request);
  void pending.then(
    () => {
      settlement.fulfilled += 1;
    },
    () => {
      settlement.rejected += 1;
    },
  );
  const captured = capture(() => pending);
  const ready = await waitGate(gate.id);
  let beforeRelease;
  let action;
  try {
    const began = performance.now();
    action = capture(revoke);
    beforeRelease = await bounded(captured, 1500, '作用域撤销后仍等待被门闩扣留的真实回执');
    check(
      !beforeRelease.ok && beforeRelease.error.kind === 'cancelled',
      '取消或撤销未及时拒绝宿主等待',
    );
    const elapsed = performance.now() - began;
    const finished = await bounded(action, 5000, '作用域释放未及时收敛');
    check(finished.ok, '撤销操作失败：' + JSON.stringify(finished.error));
    equal(settlement, { fulfilled: 0, rejected: 1 }, '撤销等待结算次数错误');
    return {
      gate: ready,
      beforeRelease,
      elapsedCancelMs: elapsed,
      lateReject,
      deliveredServerLogId: ready.logId,
      transportIgnoresSignal: true,
      settlement,
    };
  } finally {
    // 不论断言成败都释放本次门闩；释放后仍不能改写已结算的拒绝。
    await control('/' + gate.id + '/release', {});
    await env.transport.drain();
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (beforeRelease) {
      equal(await captured, beforeRelease, '晚到回执修改原来的调用结果');
      equal(settlement, { fulfilled: 0, rejected: 1 }, '晚resolve/reject导致重复结算');
    }
  }
}

export async function runCancellationScenarios(env) {
  const { runtime, config, signal, report, step } = env;
  const id = report.jobs[0].id;
  const getPath = '/api/v2/jobs/' + encodeURIComponent(id);
  const eventsPath = getPath + '/events';
  await step('TH-B05-caller取消及预取消零传输', async () => {
    const access = env.probe().context.taskHistory;
    const already = await zeroTransport(access, id, AbortSignal.abort(), report);
    const cancelled = [];
    for (const [path, query] of [
      ['/api/v2/jobs', (caller) => access.list({}, caller)],
      [getPath, (caller) => access.get(id, caller)],
      [eventsPath, (caller) => access.events(id, {}, caller)],
    ]) {
      const caller = new AbortController();
      cancelled.push(
        await cancelAtReceipt(
          env,
          path,
          () => query(caller.signal),
          () => caller.abort(),
        ),
      );
    }
    const live = await access.get(id, signal);
    matchReceipt(live, report, getPath);
    equal(live.data, report.history[0], '查询取消删除或改变了持久化任务');
    return { already, cancelled, live, cancelJobCalled: false };
  });
  await step('TH-B06-晚拒绝被安全消费', async () => {
    const access = env.probe().context.taskHistory;
    const caller = new AbortController();
    const reply = await cancelAtReceipt(
      env,
      eventsPath,
      () => access.events(id, {}, caller.signal),
      () => caller.abort(),
      true,
    );
    const evidence = report.transport.find((entry) => entry.gate === reply.gate.id);
    check(
      evidence?.controlledLateReject === true && evidence.completed,
      '受控晚传输拒绝未被执行和收敛',
    );
    check(report.unhandled.length === 0, '晚传输拒绝变成未处理Promise');
    return {
      ...reply,
      controlledTransportFailureAfterRealReceipt: true,
      serverFailureInjected: false,
    };
  });
  await step('TH-B07-挂载子作用域撤销与兄弟隔离', async () => {
    const probe = env.probe();
    const left = probe.panels.left;
    const right = probe.panels.right;
    const cancelled = await cancelAtReceipt(
      env,
      getPath,
      () => left.context.taskHistory.get(id, signal),
      () => runtime.webPlugins.unmount(config.browserId, config.panelIds.left),
    );
    check(
      left.disposed && left.releases === 1 && left.context.signal.aborted,
      '退出挂载未释放子作用域',
    );
    check(env.targets.left.childElementCount === 0, '退出挂载残留DOM');
    const old = await zeroTransport(left.context.taskHistory, id, signal, report);
    check(!right.disposed && !right.context.signal.aborted, '撤销一个挂载关闭了兄弟');
    const sibling = await right.context.taskHistory.get(id, signal);
    matchReceipt(sibling, report, getPath);
    equal(sibling.data, report.history[0], '兄弟上下文不能查询真实历史');
    return { cancelled, old, sibling, releases: left.releases, siblingStillMounted: true };
  });
  await step('TH-B08-插件卸载旧引用及新代', async () => {
    const previous = env.probe();
    const right = previous.panels.right;
    const cancelled = await cancelAtReceipt(
      env,
      eventsPath,
      () => previous.context.taskHistory.events(id, {}, signal),
      () => runtime.pluginPackages.disable('browser', config.browserId, signal),
    );
    check(
      previous.disposed &&
        previous.context.signal.aborted &&
        right.disposed &&
        right.releases === 1,
      '整插件卸载未撤销实例或剩余挂载',
    );
    check(env.targets.right.childElementCount === 0, '卸载残留兄弟DOM');
    const revoked = [];
    for (const access of [
      previous.context.taskHistory,
      previous.panels.left.context.taskHistory,
      right.context.taskHistory,
    ]) {
      revoked.push(await zeroTransport(access, id, signal, report));
    }
    await runtime.pluginPackages.enable('browser', config.browserId, signal);
    const current = env.probe();
    check(
      current !== previous &&
        current.moduleIdentity !== previous.moduleIdentity &&
        !current.context.signal.aborted,
      '新代复用旧上下文或旧ESM入口',
    );
    const newCall = await current.context.taskHistory.get(id, signal);
    matchReceipt(newCall, report, getPath);
    equal(newCall.data, report.history[0], '新代不能读取原任务历史');
    const stillRevoked = await zeroTransport(previous.context.taskHistory, id, signal, report);
    return {
      cancelled,
      revoked,
      stillRevoked,
      newCall,
      oldModule: previous.moduleIdentity,
      newModule: current.moduleIdentity,
      esmRemovedFromMemory: false,
    };
  });
  await step('TH-B09-两端部署删除后历史仍独立', async () => {
    const previous = env.probe();
    await runtime.pluginPackages.remove('browser', config.browserId, signal);
    const old = await zeroTransport(previous.context.taskHistory, id, signal, report);
    await runtime.pluginPackages.remove('server', config.serverId, signal);
    const operations = await runtime.host.listOperations(signal);
    check(
      !operations.data.some((entry) => entry.id === config.operation),
      '服务器包删除后目录残留',
    );
    const directories = {};
    for (const kind of ['server', 'browser']) {
      const current = await runtime.pluginPackages.refresh(kind, signal);
      directories[kind] = current;
      check(current.data.length === 0, '本次部署删除后目录非空');
    }
    const history = [];
    for (const item of report.history) {
      const reply = await runtime.host.taskHistory.get(item.id, signal);
      matchReceipt(reply, report, '/api/v2/jobs/' + encodeURIComponent(item.id));
      equal(reply.data, item, '卸载后历史被当前目录补写或删除');
      assertHistory(reply.data);
      history.push(reply);
      const events = await runtime.host.taskHistory.events(item.id, {}, signal);
      matchReceipt(events, report, '/api/v2/jobs/' + encodeURIComponent(item.id) + '/events');
      const original = report.events.find((row) => row.jobId === item.id);
      check(original, '缺少TH-B03原始事件证据');
      equal(events.data, original.events, '卸载或删除部署改变了原事件序号、关联、状态或时间');
    }
    check(
      !report.transport.some((entry) => entry.path.endsWith('/cancel')),
      '查询撤销误调用服务器取消Job',
    );
    return {
      old,
      directories,
      history,
      currentBrowserInstanceOnly: true,
      remoteInstancesForceStopped: false,
    };
  });
  await step('TH-B10-runtime销毁撤销公开根引用', async () => {
    const rootAccess = runtime.host.taskHistory;
    const cancelled = await cancelAtReceipt(
      env,
      '/api/v2/jobs',
      () => rootAccess.list({}, signal),
      () => runtime.dispose(),
    );
    report.runtimeDisposed = true;
    const old = await zeroTransport(rootAccess, id, signal, report);
    return { cancelled, old, serverJobsDeleted: false };
  });
}
