import { createFrontendRuntime } from '/__production_host__';

// 在真实浏览器执行当前生产宿主，可信回调故意不响应取消。
export async function verifyCancellation() {
  const checks = [];
  for (const kind of ['command', 'service', 'hook']) {
    const runtime = createFrontendRuntime({ baseUrl: location.origin, panelTarget: () => null });
    let begin;
    const entered = new Promise((resolve) => {
      begin = resolve;
    });
    const never = async () => {
      begin();
      return new Promise(() => {});
    };
    const id = `browser_cancel_${kind}`;
    const contributions =
      kind === 'command'
        ? { commands: [{ id: `${id}.wait`, title: '取消验收', execute: never }] }
        : kind === 'service'
          ? { services: [{ id: `${id}.wait`, version: '1', invoke: never }] }
          : { beforeTaskSubmit: [{ id: `${id}.wait`, transform: never }] };
    runtime.webPlugins.register({
      id,
      trusted: true,
      plugin: {
        id,
        version: '1',
        apiVersion: 2,
        panels: [],
        contributions,
      },
    });
    let timer;
    try {
      await runtime.webPlugins.load(id);
      const caller = new AbortController();
      const waiting =
        kind === 'command'
          ? runtime.extensions.executeCommand(`${id}.wait`, {}, caller.signal)
          : kind === 'service'
            ? runtime.extensions.callService(`${id}.wait`, '1', {}, caller.signal)
            : runtime.tasks.submit(
                { operation: 'browser.cancel_never_submit', input: {} },
                caller.signal,
              );
      const outcome = waiting.then(
        () => {
          throw new Error('取消后不能接受扩展成功');
        },
        (error) => {
          if (error.kind !== 'cancelled') throw error;
          return error.code;
        },
      );
      const watchdog = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('生产宿主未结束永不返回的扩展等待')), 2000);
      });
      await Promise.race([entered, watchdog]);
      if (kind === 'command') caller.abort();
      else if (kind === 'service') await runtime.webPlugins.unload(id);
      else await runtime.dispose();
      const code = await Promise.race([outcome, watchdog]);
      checks.push({
        entry: kind,
        cancellation:
          kind === 'command'
            ? 'caller'
            : kind === 'service'
              ? 'provider_unload'
              : 'runtime_dispose',
        code,
        callback_never_returned: true,
        passed: true,
      });
    } finally {
      clearTimeout(timer);
      await runtime.dispose();
    }
  }
  return {
    checks,
    scope: '真实生产 ESM 宿主及浏览器的取消等待；不表示可信回调副作用已终止或资源清理已确认',
  };
}
