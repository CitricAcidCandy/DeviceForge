import { HostError } from '@deviceforge/plugin-sdk';
import type { Dispose, HostContext, JsonValue, LocalPointContribution, WorkspaceViewRef } from '@deviceforge/plugin-sdk';
import { record } from './domain/message.ts';
import { activationGeneration } from './domain/generation.ts';
import { mountShellDelegate, type ShellMountObservation } from './shell-delegate.ts';

const POINT = { id: 'host.shell', version: '1' };
type Selection = { readonly id: string; readonly pluginId: string; readonly generation: number };
export interface ShellReplacementSnapshot extends ShellMountObservation {
  readonly replacementId: string;
  readonly contributionId: string;
  readonly original: Selection;
  readonly behavior: 'delegate' | 'fail';
  readonly registration: 'active' | 'withdrawing' | 'withdrawn' | 'unknown';
  readonly selected: boolean;
}
interface Entry {
  value: Omit<ShellReplacementSnapshot, 'selected'>;
  readonly cancellation: AbortController;
  releaseView: Dispose | null;
  releasePoint: Dispose | null;
  withdrawal: Promise<void> | null;
}
function fields(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === names.length && names.every((key) => Object.hasOwn(value, key));
}
function selection(value: unknown): value is Selection {
  return fields(value, ['id', 'pluginId', 'generation']) && typeof value.id === 'string' && value.id.length > 0 &&
    value.id.length <= 512 && typeof value.pluginId === 'string' && value.pluginId.length > 0 &&
    value.pluginId.length <= 128 && typeof value.generation === 'number' &&
    Number.isSafeInteger(value.generation) && value.generation > 0;
}
function matches(value: LocalPointContribution | null, expected: Selection): value is LocalPointContribution {
  return value?.id === expected.id && value.provider.pluginId === expected.pluginId &&
    value.provider.generation === expected.generation && value.state === 'active' && value.mode === 'replace';
}
function conflict(message: string): never {
  throw new HostError('http', 'example_shell_replacement_conflict', message, null, 409);
}
function invalid(message: string): never {
  throw new HostError('protocol', 'example_shell_replacement_input', message);
}
function bounded(task: Promise<void>, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const stop = () => finish({ error: new HostError('cancelled', 'example_shell_restore_cancelled', '外壳撤回等待已取消，请查询原票据') });
    const timer = setTimeout(() => finish({ error: new HostError('protocol', 'example_shell_restore_timeout', '外壳撤回未确认，请查询原票据') }), 5000);
    function finish(failure: { readonly error: unknown } | null) {
      if (done) return;
      done = true;
      clearTimeout(timer); signal?.removeEventListener('abort', stop);
      if (failure) reject(failure.error); else resolve();
    }
    signal?.addEventListener('abort', stop, { once: true });
    void task.then(() => finish(null), (error: unknown) => finish({ error }));
    if (signal?.aborted) stop();
  });
}

/** 外壳候选由显式命令选择；登记、委托挂载及当前选择分别观测。 */
export function createShellReplacement(context: HostContext, pluginId: string) {
  const entries = new Map<string, Entry>(), epoch = activationGeneration();
  let sequence = 0, closed = false, active: Entry | null = null;
  const current = () => {
    context.signal.throwIfAborted();
    if (closed) throw new HostError('cancelled', 'example_shell_replacement_revoked', '示例外壳作用域已撤销');
  };
  const access = () => {
    const ui = context.ui, points = context.extensions?.points;
    if (!ui?.mount || !points) throw new HostError('protocol', 'example_shell_capability_missing', '宿主缺少公开工作区挂载或扩展点能力');
    return { ui, points };
  };
  const snapshot = (entry: Entry): ShellReplacementSnapshot => ({ ...entry.value,
    original: { ...entry.value.original }, selected: access().points.selected(POINT)?.id === entry.value.contributionId });
  const find = (input: JsonValue) => {
    current();
    if (!fields(input, ['replacementId']) || typeof input.replacementId !== 'string')
      return invalid('请明确提供本代 replacementId');
    return entries.get(input.replacementId) ?? conflict('本代外壳票据不存在，不会猜测或撤回其他贡献');
  };
  function originalView(entry: LocalPointContribution): WorkspaceViewRef {
    const data = entry.data;
    if (!record(data) || typeof data.pluginId !== 'string' || typeof data.viewId !== 'string')
      return conflict('原外壳未提供可委托的公开视图引用');
    const views = access().ui.catalog().views.filter((view) => view.pluginId === data.pluginId && view.id === data.viewId && view.provides.includes('host.shell'));
    if (views.length !== 1 || data.pluginId === pluginId)
      return conflict('原外壳视图缺失、身份不唯一或会形成自委托');
    return { pluginId: data.pluginId, viewId: data.viewId };
  }
  function withdraw(entry: Entry): Promise<void> {
    if (entry.withdrawal) return entry.withdrawal;
    entry.value = { ...entry.value, registration: 'withdrawing' };
    entry.cancellation.abort();
    if (active === entry) active = null;
    const point = entry.releasePoint, view = entry.releaseView;
    entry.releasePoint = null; entry.releaseView = null;
    entry.withdrawal = Promise.allSettled([Promise.resolve().then(() => point?.()), Promise.resolve().then(() => view?.())]).then((results) => {
      const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) {
        entry.value = { ...entry.value, registration: 'unknown', error: '示例外壳贡献回收未确认' };
        throw new AggregateError(failures, entry.value.error ?? '回收未确认');
      }
      entry.value = { ...entry.value, registration: 'withdrawn' };
    });
    void entry.withdrawal.catch(() => undefined);
    return entry.withdrawal;
  }
  context.onDispose(async () => {
    closed = true;
    const results = await Promise.allSettled([...entries.values()].map((entry) => bounded(withdraw(entry))));
    entries.clear();
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, '示例外壳释放未确认');
  });
  return {
    start(input: JsonValue): ShellReplacementSnapshot {
      current();
      if (!fields(input, ['expected', 'behavior']) || !selection(input.expected) ||
          input.behavior !== 'delegate' && input.behavior !== 'fail')
        return invalid('请提供明确的 expected:{id,pluginId,generation} 和 behavior:delegate或fail');
      const expected: Selection = { id: input.expected.id, pluginId: input.expected.pluginId, generation: input.expected.generation };
      const { ui, points } = access(), selected = points.selected(POINT);
      if (active || !matches(selected, expected)) return conflict('外壳选择或代次已变化，请保留当前界面并重新读取');
      const original = originalView(selected);
      const replacementId = `${pluginId}.shell.${epoch}.${++sequence}`, contributionId = `${replacementId}.choice`;
      const entry: Entry = {
        value: { replacementId, contributionId, original: expected, behavior: input.behavior,
          registration: 'active', mount: 'not_observed', mountCount: 0, releaseCount: 0, error: null },
        cancellation: new AbortController(), releaseView: null, releasePoint: null, withdrawal: null,
      };
      entries.set(replacementId, entry); active = entry;
      while (entries.size > 16) {
        const oldest = [...entries].find(([, value]) => value !== active);
        if (!oldest) break;
        entries.delete(oldest[0]);
      }
      try {
        entry.releaseView = ui.register({ views: [{ id: `${replacementId}.root`, title: '独立外壳委托示例', provides: ['host.shell'],
          mount: (target, caller, parent) => mountShellDelegate(target, caller, parent, {
            instanceId: `${replacementId}.delegate`, original, behavior: entry.value.behavior,
            signal: entry.cancellation.signal, update: (change) => { entry.value = { ...entry.value, ...change(entry.value) }; },
          }),
        }] });
        entry.releasePoint = points.contribute({ id: contributionId, point: POINT, mode: 'replace',
          data: { pluginId, viewId: `${replacementId}.root` } }).dispose;
        if (!matches(points.selected(POINT), entry.value.original))
          return conflict('准备期间外壳选择已变化，不覆盖新的选择');
        points.select(POINT, contributionId);
      } catch (error) {
        // 仅撤本次资格，不猜测或回写另一选择；原票据继续可查。
        void bounded(withdraw(entry)).catch(() => undefined);
        entry.value = { ...entry.value, error: error instanceof Error ? error.message : '示例外壳选择未确认' };
        throw error;
      }
      return snapshot(entry);
    },
    status(input: JsonValue): ShellReplacementSnapshot { return snapshot(find(input)); },
    async restore(input: JsonValue, signal: AbortSignal): Promise<ShellReplacementSnapshot> {
      signal.throwIfAborted();
      const entry = find(input), { points } = access();
      if (entry.value.registration !== 'active') return conflict('此票据已请求撤回，请查询原结果，不自动重放');
      const selected = points.selected(POINT);
      if (selected?.id !== entry.value.contributionId) return conflict('当前选择已改变，不覆盖后来选择');
      const original = points.list(POINT).find((value) => matches(value, entry.value.original));
      if (!original) return conflict('原外壳贡献缺失或代次已变化，请使用独立恢复入口');
      originalView(original);
      current(); signal.throwIfAborted();
      points.select(POINT, original.id);
      await bounded(withdraw(entry), signal);
      return snapshot(entry);
    },
  };
}
