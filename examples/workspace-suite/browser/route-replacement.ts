import { HostError } from '@deviceforge/plugin-sdk';
import type { Dispose, HostContext, JsonValue } from '@deviceforge/plugin-sdk';
import { record } from './domain/message.ts';
import { activationGeneration } from './domain/generation.ts';

export interface RouteReplacementSnapshot {
  readonly replacementId: string;
  readonly slot: 'route.files';
  readonly behavior: 'files' | 'fail';
  readonly registration: 'active' | 'withdrawing' | 'withdrawn' | 'unknown';
  readonly mount: 'not_observed' | 'mounting' | 'ready' | 'failed' | 'released';
  readonly mountCount: number;
  readonly releaseCount: number;
  readonly error: string | null;
}
interface Entry {
  value: RouteReplacementSnapshot;
  readonly cancellation: AbortController;
  release: Dispose | null;
  withdrawal: Promise<void> | null;
}
function fields(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === names.length && names.every((key) => Object.hasOwn(value, key));
}
function invalid(message: string): never {
  throw new HostError('protocol', 'example_route_replacement_input', message);
}
function conflict(message: string): never {
  throw new HostError('http', 'example_route_replacement_conflict', message, null, 409);
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : '示例替换操作未确认';
}
function bounded(task: Promise<void>, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => finish({ error: new HostError('cancelled', 'example_route_restore_cancelled', '撤回等待已取消，请查询原票据') });
    const timer = setTimeout(() => finish({ error: new HostError('protocol', 'example_route_restore_timeout', '撤回结果尚未确认，请查询原票据') }), 5000);
    let done = false;
    function finish(failure: { readonly error: unknown } | null) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (failure === null) resolve(); else reject(failure.error);
    }
    signal?.addEventListener('abort', stop, { once: true });
    void task.then(() => finish(null), (error: unknown) => finish({ error }));
    if (signal?.aborted) stop();
  });
}

/** 通过已有路由槽位演示准备、失败回落与撤回；不把登记回执冒充实际挂载。 */
export function createRouteReplacement(context: HostContext, pluginId: string) {
  const entries = new Map<string, Entry>();
  const epoch = activationGeneration();
  let sequence = 0, closed = false;
  let active: Entry | null = null;
  function current() {
    context.signal.throwIfAborted();
    if (closed) throw new HostError('cancelled', 'example_route_replacement_revoked', '示例替换作用域已撤销');
  }
  const snapshot = (entry: Entry): RouteReplacementSnapshot => ({ ...entry.value });
  function find(input: JsonValue): Entry {
    current();
    if (!fields(input, ['replacementId']) || typeof input.replacementId !== 'string')
      return invalid('请显式提供本代 replacementId');
    const entry = entries.get(input.replacementId);
    return entry ?? conflict('本代替换票据不存在，不会猜测或撤回其他贡献');
  }
  function withdraw(entry: Entry): Promise<void> {
    if (entry.withdrawal) return entry.withdrawal;
    entry.value = { ...entry.value, registration: 'withdrawing' };
    entry.cancellation.abort();
    if (active === entry) active = null;
    const release = entry.release;
    entry.release = null;
    entry.withdrawal = Promise.resolve().then(() => release?.()).then(() => {
      entry.value = { ...entry.value, registration: 'withdrawn' };
    }, (error: unknown) => {
      entry.value = { ...entry.value, registration: 'unknown', error: message(error) };
      throw error;
    });
    void entry.withdrawal.catch(() => undefined);
    return entry.withdrawal;
  }
  context.onDispose(async () => {
    closed = true;
    const results = await Promise.allSettled([...entries.values()].map((entry) => bounded(withdraw(entry))));
    entries.clear();
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, '示例替换贡献回收未确认');
  });
  return {
    start(input: JsonValue): RouteReplacementSnapshot {
      current();
      if (!fields(input, ['slot', 'expectedReplacement', 'behavior']) || input.slot !== 'route.files' ||
          input.expectedReplacement !== null || input.behavior !== 'files' && input.behavior !== 'fail')
        return invalid('请显式提供 slot:route.files、expectedReplacement:null 和 behavior:files或fail');
      const extensions = context.extensions, register = extensions?.register, ui = context.ui;
      if (!extensions || !register || !ui?.mount)
        throw new HostError('protocol', 'example_route_replacement_missing', '宿主缺少公开贡献登记或工作区渲染能力');
      if (active || extensions.catalog().components.some((entry) => entry.slot === input.slot && entry.mode === 'replace'))
        return conflict('此槽位已有替换贡献，请先保留现状并核对，不覆盖其他插件');
      const pages = ui.catalog().pages.filter((page) => page.route === '/files');
      const page = pages.length === 1 ? pages[0] : null;
      if (!page?.workspaceId)
        return conflict('公开文件页面缺失、身份不唯一或没有工作区');
      const workspaceId = page.workspaceId;
      const replacementId = `${pluginId}.route.${epoch}.${++sequence}`;
      const entry: Entry = {
        value: { replacementId, slot: 'route.files', behavior: input.behavior, registration: 'active',
          mount: 'not_observed', mountCount: 0, releaseCount: 0, error: null },
        cancellation: new AbortController(), release: null, withdrawal: null,
      };
      active = entry;
      entries.set(replacementId, entry);
      while (entries.size > 16) {
        const oldest = [...entries].find(([, value]) => value !== active);
        if (!oldest) break;
        entries.delete(oldest[0]);
      }
      try {
        entry.release = register({ components: [{ id: replacementId, title: '示例文件页替换', slot: 'route.files', mode: 'replace',
          async mount(target, caller) {
            const signal = AbortSignal.any([caller.signal, entry.cancellation.signal]);
            signal.throwIfAborted();
            entry.value = { ...entry.value, mount: 'mounting', mountCount: entry.value.mountCount + 1 };
            try {
              if (entry.value.behavior === 'fail')
                throw new HostError('protocol', 'example_route_candidate_failed', '示例候选视图按要求失败');
              const access = caller.ui;
              if (!access?.mount) throw new Error('当前挂载作用域缺少公开工作区渲染能力');
              const instanceId = `${replacementId}.view`;
              access.open({ instanceId, workspaceId, provider: { pluginId, viewId: `${pluginId}.main` }, target: null }, signal);
              const release = await access.mount(instanceId, target, signal);
              let released = false;
              const dispose: Dispose = () => {
                if (released) return;
                released = true;
                entry.value = { ...entry.value, mount: 'released', releaseCount: entry.value.releaseCount + 1 };
                return release();
              };
              if (signal.aborted || entry.value.registration !== 'active') {
                await dispose();
                throw new HostError('cancelled', 'example_route_candidate_revoked', '示例候选已撤回，不提交晚到挂载');
              }
              entry.value = { ...entry.value, mount: 'ready' };
              return dispose;
            } catch (error) {
              if (entry.value.mount !== 'released') entry.value = { ...entry.value, mount: 'failed', error: message(error) };
              throw error;
            }
          },
        }] });
      } catch (error) {
        if (active === entry) active = null;
        entry.cancellation.abort();
        entry.value = { ...entry.value, registration: 'unknown', error: message(error) };
        throw error;
      }
      return snapshot(entry);
    },
    status(input: JsonValue): RouteReplacementSnapshot { return snapshot(find(input)); },
    async restore(input: JsonValue, signal: AbortSignal): Promise<RouteReplacementSnapshot> {
      signal.throwIfAborted();
      const entry = find(input);
      if (entry.value.registration !== 'active') return conflict('此票据已请求撤回，请查询状态，不自动重放');
      try { await bounded(withdraw(entry), signal); }
      catch (error) {
        if (snapshot(entry).registration === 'withdrawing')
          entry.value = { ...entry.value, registration: 'unknown', error: message(error) };
        throw error;
      }
      return snapshot(entry);
    },
  };
}
