import { fail } from './input.mjs';

// 只保存本插件代次的公开观测；内部修订不作为服务器注册或设备 generation。
export function createSession(context, id, runId) {
  const lifetime = new AbortController();
  const releases = [];
  const providerWaits = new Set();
  const jobs = new Set();
  let operations = [];
  let devices = context.devices?.snapshot() ?? null;
  let operationRevision = 0;
  let deviceRevision = 0;
  let closed = false;
  let closing;

  function signal(caller) {
    const combined = AbortSignal.any([caller, context.signal, lifetime.signal]);
    combined.throwIfAborted();
    return combined;
  }
  function snapshot() {
    signal(context.signal);
    // 返回独立 JSON，调用者不能修改本插件保存的公开观测。
    return JSON.parse(JSON.stringify({ runId, operations, devices,
      revisions: { operations: operationRevision, devices: deviceRevision }, acceptedJobIds: [...jobs] }));
  }
  function publish() {
    if (closed || context.signal.aborted) return;
    const data = snapshot();
    context.extensions.setState(id + '.catalog', data);
    if (!closed && !context.signal.aborted) context.extensions.emitEvent(id + '.changed', data);
  }
  function observeOperations(next) {
    if (closed || context.signal.aborted) return;
    operations = next; ++operationRevision; publish();
  }
  function observeDevices(next) {
    if (closed || context.signal.aborted) return;
    devices = next; ++deviceRevision;
    for (const wait of providerWaits) {
      if (!next.providers.some((provider) => provider.id === wait.id && provider.generation === wait.generation)) {
        wait.controller.abort();
      }
    }
    publish();
  }
  async function withProvider(callContext, id, generation, caller, run, accept = (result) => result) {
    const current = signal(AbortSignal.any([caller, callContext.signal]));
    if (!devices?.providers.some((provider) => provider.id === id && provider.generation === generation)) {
      fail('example_provider_unavailable', '提供者引用不属于当前观测，请显式刷新并取得新引用');
    }
    const wait = { id, generation, controller: new AbortController() };
    providerWaits.add(wait);
    const combined = AbortSignal.any([current, wait.controller.signal]);
    try {
      combined.throwIfAborted();
      const result = await run(combined);
      combined.throwIfAborted();
      // 接受回调必须同步执行：最终代次检查到 Job 登记之间不能再次让出执行权。
      return accept(result, combined);
    } finally { providerWaits.delete(wait); }
  }
  function remember(job, caller) {
    signal(caller);
    jobs.add(job.id);
    if (jobs.size > 32) jobs.delete(jobs.values().next().value);
    publish();
  }
  function track(release) {
    signal(context.signal);
    releases.push(release);
  }
  function close() {
    if (closing) return closing;
    let finish; let reject;
    closing = new Promise((resolve, failed) => { finish = resolve; reject = failed; });
    closed = true;
    lifetime.abort();
    for (const wait of providerWaits) wait.controller.abort();
    providerWaits.clear();
    const owned = releases.splice(0).reverse();
    void (async () => {
      const errors = [];
      for (const release of owned) { try { await release(); } catch (error) { errors.push(error); } }
      jobs.clear(); operations = []; devices = null;
      if (errors.length) throw new AggregateError(errors, '示例登记资源释放失败');
    })().then(finish, reject);
    return closing;
  }
  return { signal, snapshot, observeOperations, observeDevices, withProvider, remember, track, close,
    operationRevision: () => operationRevision,
    seedOperations(next, expected) {
      signal(context.signal);
      if (expected === operationRevision) observeOperations(next);
    },
  };
}
