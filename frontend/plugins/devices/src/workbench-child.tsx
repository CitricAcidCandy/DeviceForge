import { hostUi } from '@deviceforge/plugin-sdk';
import type { Dispose, HostContext, UiAccess } from '@deviceforge/plugin-sdk';

interface ChildMountAttempt {
  readonly signal: AbortSignal;
  readonly loadedEpoch: number;
  state: 'mounting' | 'ready' | 'failed';
  errorCode: string | null;
  retryRequested: boolean;
}

export function WorkbenchChild({ instanceId, context, ui }: {
  readonly instanceId: string;
  readonly context: HostContext;
  readonly ui: UiAccess;
}) {
  const { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } = hostUi().React;
  const target = useRef<HTMLDivElement>(null);
  const last = useRef(ui.snapshot());
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const active = useRef<ChildMountAttempt | null>(null);
  const loadedEpoch = useRef(0);
  const recoverEarly = (attempt: ChildMountAttempt) => {
    if (active.current !== attempt || attempt.signal.aborted || context.signal.aborted ||
        attempt.state !== 'failed' || attempt.errorCode !== 'workspace_provider_revoked' ||
        attempt.retryRequested || loadedEpoch.current <= attempt.loadedEpoch) return;
    attempt.retryRequested = true;
    setRetry((value) => value + 1);
  };
  const revision = () => {
    if (!context.signal.aborted) last.current = ui.snapshot();
    return last.current.revision;
  };
  useSyncExternalStore(ui.subscribe, revision, revision);
  const instance = last.current.instances.find((entry) => entry.instanceId === instanceId);
  useEffect(() => {
    const release = context.extensions?.subscribeEvent('host.plugins.changed', (event) => {
      const data = event.data;
      if (!data || typeof data !== 'object' || Array.isArray(data) ||
          data.stage !== 'loaded' || data.pluginId !== instance?.provider?.pluginId) return;
      loadedEpoch.current++;
      if (active.current) recoverEarly(active.current);
    });
    return () => { void release?.(); };
  }, [context, instance?.provider?.pluginId]);
  useLayoutEffect(() => {
    const element = target.current, mount = ui.mount;
    if (!element || !mount || context.signal.aborted || instance?.state !== 'ready') return;
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    const attempt: ChildMountAttempt = { signal, loadedEpoch: loadedEpoch.current,
      state: 'mounting', errorCode: null, retryRequested: false };
    active.current = attempt;
    let release: Dispose | null = null;
    setError(null); setReady(false);
    void Promise.resolve().then(() => {
      signal.throwIfAborted();
      return mount(instanceId, element, signal);
    }).then((dispose) => {
      if (signal.aborted) { void Promise.resolve().then(dispose).catch(() => {}); return; }
      release = dispose;
      attempt.state = 'ready';
      setReady(true);
    }, (failure: unknown) => {
      if (signal.aborted || active.current !== attempt) return;
      attempt.state = 'failed';
      attempt.errorCode = failure !== null && typeof failure === 'object' &&
        'code' in failure && typeof failure.code === 'string' ? failure.code : null;
      setError(failure instanceof Error ? failure.message : '插件视图暂时无法显示');
      // 仅兼容旧宿主激活前的明确拒绝；正常等待和业务失败不随通知重放。
      recoverEarly(attempt);
    });
    return () => {
      controller.abort();
      if (active.current === attempt) active.current = null;
      // 原挂载管线保留清理诊断，旧释放句柄不会拆除后来的新代。
      if (release) void Promise.resolve().then(release).catch(() => {});
    };
  }, [context, ui, instanceId, instance?.generation, instance?.state, retry]);
  return <div className="relative h-full min-h-0 min-w-0">
    <div ref={target} className="h-full min-h-0 min-w-0" />
    {(!ready || instance?.state !== 'ready') && <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 overflow-auto bg-[#F5F6FB] p-6 text-center text-xs leading-6 text-[#596479]">
      <p role={error ? 'alert' : 'status'}>{error ?? (instance?.state === 'ready' ? '正在打开插件视图' : '相应插件暂不可用，其他功能仍可使用')}</p>
      {error && <button type="button" className="rounded-md border border-[#E6EAF3] bg-white px-3 py-1.5 text-[#6C4CF5]" onClick={() => setRetry((value) => value + 1)}>重新打开</button>}
    </div>}
  </div>;
}
