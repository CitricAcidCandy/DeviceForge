import { HostError } from '../../plugin-sdk/models.ts';
import type { Dispose, HostContext, HostResult, JsonValue, ServiceAccess, ServiceFeatureDiagnostic,
  ServiceRef, TypedService, ServerServiceAccess, ServiceDirectoryEntry } from '../../plugin-sdk/index.ts';
import { createPluginScope } from '../scope.ts';
import { awaitLifecycle } from '../lifecycle.ts';

interface Options {
  readonly context: () => HostContext;
  readonly track: (release: Dispose) => Dispose;
  readonly resolve: (ref: ServiceRef) => object | null;
  readonly subscribe: (listener: () => void) => Dispose;
  readonly invoke: (ref: ServiceRef, input: JsonValue, signal: AbortSignal) => Promise<HostResult<JsonValue>>;
  readonly catalog: () => readonly ServiceDirectoryEntry[];
  readonly server?: ServerServiceAccess;
}

export function createServiceAccess(options: Options): ServiceAccess {
  const features = new Map<string, ServiceFeatureDiagnostic>();
  const histories = new Map<string, { registration: number; revision: number; message: string }[]>();
  let registration = 0;
  const live = new Set<string>();
  const current = () => {
    if (options.context().signal.aborted) throw new HostError('cancelled', 'services_revoked', '服务作用域已撤销');
  };
  const call = (ref: ServiceRef, input: JsonValue, signal: AbortSignal) => {
    current();
    return options.invoke(ref, input, AbortSignal.any([signal, options.context().signal]));
  };
  return {
    catalog: () => { current(); return options.catalog(); },
    ...(options.server ? { server: {
      list: (signal: AbortSignal) => { current(); return options.server!.list(AbortSignal.any([signal, options.context().signal])); },
      submit: (ref: ServiceRef, input: JsonValue, signal: AbortSignal, generation?: string) => {
        current(); return options.server!.submit(ref, input, AbortSignal.any([signal, options.context().signal]), generation);
      },
    } } : {}),
    call,
    async callTyped<I extends JsonValue, O extends JsonValue>(ref: TypedService<I, O>, input: I, signal: AbortSignal) {
      if (!ref.accepts(input)) throw new HostError('protocol', 'service_input_invalid', '服务输入不符合类型契约');
      const result = await call(ref, input, signal);
      if (!ref.returns(result.data)) throw new HostError('protocol', 'service_output_invalid', '服务输出不符合类型契约', result.logId);
      return { data: result.data, logId: result.logId };
    },
    diagnostics: () => [...features.values()],
    whenAvailable(featureId, required, setup) {
      current();
      if (!/^[a-z][a-z0-9._-]{0,199}$/.test(featureId) || live.has(featureId) || live.size >= 128)
        throw new Error('功能标识无效、重复或超过 128 项上限');
      if (!required.length || required.length > 64 || required.some((ref) => !ref.id || !ref.version) ||
        new Set(required.map((ref) => JSON.stringify([ref.id, ref.version]))).size !== required.length)
        throw new Error('功能依赖必须包含 1 至 64 个不重复的精确服务引用');
      const refs = required.map((ref) => Object.freeze({ id: ref.id, version: ref.version }));
      live.add(featureId);
      const instance = ++registration;
      let stopped = false;
      let scheduled = false;
      let revision = 0;
      let bindings: readonly (object | null)[] = [];
      let scope: ReturnType<typeof createPluginScope> | null = null;
      let cleanup: Promise<unknown> = Promise.resolve();
      const cleanupErrors = histories.get(featureId) ?? [];
      histories.set(featureId, cleanupErrors);
      const publish = (state: ServiceFeatureDiagnostic['state'], missing: readonly ServiceRef[] = [], error: unknown = null) => {
        features.set(featureId, Object.freeze({ featureId, state, missing,
          error: error instanceof Error ? error.message : error === null ? null : String(error),
          cleanupErrors: Object.freeze([...cleanupErrors]) }));
        // 诊断有界保留，运行中的功能不被历史淘汰。
        if (features.size > 256) for (const key of features.keys()) {
          if (!live.has(key)) { features.delete(key); histories.delete(key); break; }
        }
      };
      const closeScope = () => {
        const previous = scope;
        scope = null;
        if (!previous) return;
        previous.close();
        const closingRevision = revision;
        cleanup = awaitLifecycle(() => previous.dispose(), undefined, Date.now() + 5000, '功能清理')
          .catch((error: unknown) => {
            const history = histories.get(featureId) ?? cleanupErrors;
            history.push({ registration: instance, revision: closingRevision, message: error instanceof Error ? error.message : String(error) });
            if (history.length > 8) history.shift();
            const snapshot = features.get(featureId);
            if (snapshot) features.set(featureId, Object.freeze({ ...snapshot, cleanupErrors: Object.freeze([...history]) }));
          });
      };
      const reconcile = () => {
        scheduled = false;
        if (stopped) return;
        const next = refs.map(options.resolve);
        if (next.length === bindings.length && next.every((entry, index) => entry === bindings[index])) return;
        bindings = next;
        const turn = ++revision;
        closeScope();
        const missing = refs.filter((_, index) => !next[index]);
        if (missing.length) { publish('waiting', missing); return; }
        publish('starting');
        void cleanup.then(async () => {
          if (stopped || turn !== revision) return;
          const child = createPluginScope(options.context());
          scope = child;
          try {
            const release = await awaitLifecycle(() => setup(child.context), child.context.signal,
              Date.now() + 30_000, '功能初始化', (late) => { if (typeof late === 'function') child.track(late); });
            if (typeof release === 'function') child.track(release);
            if (!stopped && turn === revision && !child.context.signal.aborted) publish('active');
          } catch (error) {
            if (stopped || turn !== revision) return;
            closeScope();
            publish('failed', [], error);
          }
        });
      };
      const notify = () => {
        // 依赖一撤销便关闭原作用域；重建放入微任务，避免注册通知重入。
        if (scope && refs.some((ref, index) => options.resolve(ref) !== bindings[index])) closeScope();
        if (!scheduled && !stopped) { scheduled = true; queueMicrotask(reconcile); }
      };
      const unsubscribe = options.subscribe(notify);
      publish('waiting', refs);
      notify();
      return options.track(() => {
        if (stopped) return cleanup.then(() => undefined);
        stopped = true;
        revision++;
        unsubscribe();
        closeScope();
        live.delete(featureId);
        publish('stopped');
        return cleanup.then(() => undefined);
      });
    },
  };
}
