import { ApiError } from '../../../services/api/index.ts';
import { abortable } from '../../../services/api/abort.ts';
import { createLatestResource } from '../../../shared/lifecycle/latest.ts';
import { createJobRunner } from '../../../shared/jobs/index.ts';
import type { ApiResult } from '../../../services/api/index.ts';
import type { JobOptions, TaskRecord } from '../../../shared/jobs/index.ts';
import type {
  InstallationBrowserLifecycle, InstallationClientState, InstallationComponent, InstallationGateway,
  InstallationPlan, InstallationProgress, InstallationSource, PluginInstallation,
} from '../types/index.ts';
import { installationCanRun, installationRequiresRecovery } from '../utils/recovery.ts';

export function createPluginInstallations(gateway: InstallationGateway, browser: InstallationBrowserLifecycle, options: JobOptions = {}) {
  const resource = createLatestResource<readonly PluginInstallation[]>();
  const lifetime = new AbortController();
  let progress: InstallationProgress | null = null;
  let eventSequence = 0;
  const progressListeners = new Set<() => void>();
  function publishProgress(value: InstallationProgress) {
    if (lifetime.signal.aborted) return;
    progress = Object.freeze(value);
    for (const listener of [...progressListeners]) {
      if (lifetime.signal.aborted) break;
      try { listener(); } catch { /* 进度展示失败不改变安装任务。 */ }
    }
  }
  const runner = createJobRunner({
    submit: async () => { throw new Error('安装任务必须从公开安装端点提交'); },
    async getJob(id, signal) {
      const result = await gateway.getJob(id, signal);
      if (gateway.getEvents) {
        const updates = await gateway.getEvents(id, { after: eventSequence }, signal);
        signal.throwIfAborted();
        for (const event of updates.data) {
          if (event.job_id !== id || !Number.isSafeInteger(event.sequence) || event.sequence <= eventSequence)
            throw new ApiError('protocol', 'invalid_installation_event', '安装任务事件身份或顺序无效', null, updates.logId);
          eventSequence = event.sequence;
          if (event.progress) publishProgress({ jobId: id, operation: result.data.operation, status: event.status,
            progress: Object.freeze({ ...event.progress }), logId: updates.logId });
        }
      }
      signal.throwIfAborted();
      publishProgress({ jobId: id, operation: result.data.operation, status: result.data.status,
        progress: progress?.jobId === id ? progress.progress : null, logId: result.logId });
      return result;
    },
    cancelJob: async () => { throw new Error('取消安装等待不自动撤销服务器任务'); },
  }, options);
  const clients = new Map<string, InstallationClientState>();
  const listeners = new Set<() => void>();
  let clientSnapshot: readonly InstallationClientState[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  const combined = (signal: AbortSignal) => AbortSignal.any([signal, lifetime.signal]);
  const failureLog = (reason: unknown) => reason !== null && typeof reason === 'object' && 'logId' in reason && typeof reason.logId === 'string' ? reason.logId : null;
  function notifyClients() {
    if (lifetime.signal.aborted) return;
    clientSnapshot = Object.freeze([...clients.values()]);
    for (const listener of [...listeners]) {
      if (lifetime.signal.aborted) break;
      try { listener(); } catch { /* 一个界面订阅失败不阻断安装状态。 */ }
    }
  }
  function publishClient(value: InstallationClientState) {
    if (lifetime.signal.aborted) return;
    clients.set(value.id, Object.freeze(value));
    notifyClients();
  }
  const refresh = (signal: AbortSignal) => resource.run((active) => {
    const requestSignal = combined(active);
    return abortable(gateway.list(requestSignal), requestSignal);
  }, combined(signal));
  async function plan(source: InstallationSource, signal: AbortSignal) {
    signal.throwIfAborted();
    const result = await abortable(gateway.plan(source, signal), signal);
    const issue = result.data.issues.find((item) => item.required && item.code !== 'user_configuration');
    if (issue) throw new ApiError('protocol', issue.code, issue.message, null, result.logId);
    return result;
  }
  function matches(value: PluginInstallation | undefined, expected: InstallationPlan): value is PluginInstallation {
    return !!value && value.id === expected.id && value.version === expected.version && value.revision === expected.revision;
  }
  function installed(id: string): PluginInstallation {
    const value = resource.snapshot().result?.data.find((item) => item.id === id);
    if (!value) throw new Error('功能插件尚未安装，请刷新目录');
    return value;
  }
  async function deactivate(value: PluginInstallation, signal: AbortSignal) {
    for (const component of [...value.components].reverse()) {
      signal.throwIfAborted();
      if (component.kind === 'browser') await abortable(browser.disable(component, signal), signal);
    }
    publishClient({ id: value.id, revision: value.revision, phase: 'disabled', message: null, logId: null });
  }
  async function activate(value: PluginInstallation, signal: AbortSignal) {
    publishClient({ id: value.id, revision: value.revision, phase: 'activating', message: null, logId: null });
    const started: InstallationComponent[] = [];
    try {
      if (!installationCanRun(value)) throw new Error('功能插件仍未启用或需要配置，请完成配置后重试');
      for (const component of value.components) {
        signal.throwIfAborted();
        if (component.kind === 'browser') {
          await abortable(browser.enable(value, component, signal), signal);
          started.push(component);
        }
      }
      signal.throwIfAborted();
      publishClient({ id: value.id, revision: value.revision, phase: 'enabled', message: null, logId: null });
    } catch (reason) {
      // 后续组件失败时收回本次已启动组件，保留原始失败供界面排查。
      for (const component of started.reverse()) {
        try { await abortable(browser.disable(component, lifetime.signal), lifetime.signal); }
        catch { /* 清理失败不覆盖原始错误。 */ }
      }
      if (!signal.aborted) publishClient({ id: value.id, revision: value.revision, phase: 'failed',
        message: reason instanceof Error ? reason.message : '浏览器组件启用失败',
        logId: failureLog(reason) });
      throw reason;
    }
  }
  async function wait(submitted: ApiResult<TaskRecord>, signal: AbortSignal) {
    signal.throwIfAborted();
    eventSequence = 0;
    publishProgress({ jobId: submitted.data.id, operation: submitted.data.operation, status: submitted.data.status,
      progress: null, logId: submitted.logId });
    const outcome = await runner.resume({ id: submitted.data.id, operation: submitted.data.operation, submitLogId: submitted.logId }, signal, (value) => value);
    signal.throwIfAborted();
    return outcome;
  }
  async function enableInstalled(value: PluginInstallation, signal: AbortSignal): Promise<PluginInstallation> {
    const revision = value.revision;
    if (installationRequiresRecovery(value)) throw new Error('功能插件安装恢复受阻，请先检查服务器恢复日志');
    if (value.status === 'configuration_required' || value.status === 'dependencies_required') {
      publishClient({ id: value.id, revision, phase: 'disabled', message: value.status === 'dependencies_required' ? '功能插件已安装，缺失依赖未准备完成，请在依赖面板重试' : '功能插件已安装，请完成配置后启用', logId: null });
      return value;
    }
    if (!installationCanRun(value)) {
      await wait(await gateway.setEnabled(value.id, value.revision, true, signal), signal);
      await refresh(signal);
      value = installed(value.id);
    }
    if (value.revision !== revision) throw new Error('启用期间功能插件已更新，请刷新后重试');
    if (value.status === 'configuration_required' || value.status === 'dependencies_required') {
      publishClient({ id: value.id, revision, phase: 'disabled', message: value.status === 'dependencies_required' ? '功能插件已安装，缺失依赖未准备完成，请在依赖面板重试' : '功能插件已安装，请完成配置后启用', logId: null });
      return value;
    }
    await activate(value, signal);
    return value;
  }
  async function stopInstalled(value: PluginInstallation, signal: AbortSignal) {
    await deactivate(value, signal);
    if (value.enabled) {
      signal.throwIfAborted();
      await wait(await gateway.setEnabled(value.id, value.revision, false, signal), signal);
      await refresh(signal);
      const stopped = installed(value.id);
      if (stopped.enabled || stopped.revision !== value.revision) throw new Error('停用后的安装状态已变化，请刷新目录');
    }
  }
  function serial<T>(signal: AbortSignal, run: (active: AbortSignal) => Promise<T>): Promise<T> {
    const active = combined(signal);
    const pending = queue.catch(() => undefined).then(async () => {
      active.throwIfAborted();
      try { return await abortable(run(active), active); }
      catch (reason) {
        // 等待失败可能已有服务器提交，用独立生命周期重读，不重放安装。
        if (!lifetime.signal.aborted) {
          try { await refresh(lifetime.signal); } catch { /* 目录错误保留在快照，原错误继续交付。 */ }
        }
        throw reason;
      }
    });
    queue = pending;
    return abortable(pending, active);
  }
  return {
    refresh,
    snapshot: resource.snapshot,
    subscribe: resource.subscribe,
    clientSnapshot: () => clientSnapshot,
    progressSnapshot: () => progress,
    subscribeProgress(listener: () => void) {
      lifetime.signal.throwIfAborted(); progressListeners.add(listener);
      return () => { progressListeners.delete(listener); };
    },
    subscribeClient(listener: () => void) {
      lifetime.signal.throwIfAborted(); listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    plan: (source: InstallationSource, signal: AbortSignal) => {
      const active = combined(signal);
      active.throwIfAborted();
      return plan(source, active);
    },
    restore(signal: AbortSignal) {
      return serial(signal, async (active) => {
        const result = await refresh(active);
        const failures: unknown[] = [];
        for (const value of result.data) {
          active.throwIfAborted();
          if (!installationCanRun(value)) continue;
          try { await activate(value, active); }
          catch (reason) { active.throwIfAborted(); failures.push(reason); }
        }
        if (failures.length) throw new AggregateError(failures, '部分功能的浏览器组件恢复失败，请在已安装目录重试');
      });
    },
    retryBrowser(id: string, revision: string, signal: AbortSignal) {
      return serial(signal, async (active) => {
        await refresh(active);
        const value = installed(id);
        if (value.revision !== revision) throw new Error('功能插件已更新，请刷新后重试');
        await activate(value, active);
        return value;
      });
    },
    install(source: InstallationSource, signal: AbortSignal) {
      return serial(signal, async (active) => {
        const planned = await plan(source, active);
        active.throwIfAborted();
        await wait(await gateway.install(source, active), active);
        const result = await refresh(active);
        const value = result.data.find((item) => item.id === planned.data.id);
        if (!matches(value, planned.data)) throw new ApiError('protocol', 'installation_mismatch', '安装后的功能插件与计划不一致，请刷新目录', null, result.logId);
        return enableInstalled(value, active);
      });
    },
    update(id: string, revision: string, source: InstallationSource, signal: AbortSignal) {
      return serial(signal, async (active) => {
        await refresh(active);
        const previous = installed(id);
        if (previous.revision !== revision) throw new Error('功能插件已更新，请刷新后重试');
        if (installationRequiresRecovery(previous)) throw new Error('功能插件安装恢复受阻，请先检查服务器恢复日志');
        const planned = await plan(source, active);
        active.throwIfAborted();
        if (planned.data.id !== id) throw new Error('更新包功能标识与当前插件不一致');
        // 宿主更新负责保留服务器启停意图，本地只撤销旧浏览器组件。
        await deactivate(previous, active);
        await wait(await gateway.update(id, revision, source, active), active);
        await refresh(active);
        const value = installed(id);
        if (!matches(value, planned.data)) throw new Error('更新后版本或修订与计划不一致，请刷新目录');
        if (previous.enabled && installationCanRun(value)) await activate(value, active);
        else publishClient({ id: value.id, revision: value.revision, phase: 'disabled',
          message: value.status === 'dependencies_required' ? '功能插件已更新，缺失依赖未准备完成，请在依赖面板重试' : value.status === 'configuration_required' ? '功能插件已更新，请完成配置后启用' : null, logId: null });
        return value;
      });
    },
    setEnabled(id: string, revision: string, enabled: boolean, signal: AbortSignal) {
      return serial(signal, async (active) => {
        await refresh(active);
        const previous = installed(id);
        if (previous.revision !== revision) throw new Error('功能插件已更新，请刷新后重试');
        if (enabled && installationRequiresRecovery(previous)) throw new Error('功能插件安装恢复受阻，请先检查服务器恢复日志');
        if (!enabled) await deactivate(previous, active);
        await wait(await gateway.setEnabled(id, revision, enabled, active), active);
        await refresh(active);
        const value = installed(id);
        if (enabled && (value.status === 'configuration_required' || value.status === 'dependencies_required')) {
          publishClient({ id: value.id, revision: value.revision, phase: 'disabled', message: value.status === 'dependencies_required' ? '功能插件已安装，缺失依赖未准备完成，请在依赖面板重试' : '功能插件已安装，请完成配置后启用', logId: null });
          throw new Error(value.status === 'dependencies_required' ? '插件依赖尚未就绪，请在依赖面板重试' : '功能插件已安装，请完成配置后启用');
        }
        if (value.enabled !== enabled || value.revision !== revision) throw new Error('服务器启停状态或修订与请求不一致，请刷新目录');
        if (enabled) await activate(value, active);
        return value;
      });
    },
    uninstall(id: string, revision: string, signal: AbortSignal) {
      return serial(signal, async (active) => {
        await refresh(active);
        const value = installed(id);
        if (value.revision !== revision) throw new Error('功能插件已更新，请刷新后重试');
        await stopInstalled(value, active);
        await wait(await gateway.uninstall(id, revision, active), active);
        const result = await refresh(active);
        if (result.data.some((item) => item.id === id)) throw new Error('服务器仍保留功能插件，请刷新目录');
        clients.delete(id);
        notifyClients();
      });
    },
    cleanup(dryRun: boolean, signal: AbortSignal) {
      return serial(signal, async (active) => {
        if (!gateway.cleanup) throw new Error('当前服务器未提供托管资源清理接口');
        const outcome = await wait(await gateway.cleanup(dryRun, active), active);
        await refresh(active);
        return { data: outcome.data, logId: outcome.logId };
      });
    },
    dispose() { lifetime.abort(); resource.dispose(); runner.dispose(); clients.clear(); clientSnapshot = []; listeners.clear(); progressListeners.clear(); },
  };
}
export type PluginInstallations = ReturnType<typeof createPluginInstallations>;
