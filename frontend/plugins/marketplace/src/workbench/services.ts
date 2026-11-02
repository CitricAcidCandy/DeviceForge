import { ApiError } from '@deviceforge/plugin-sdk';
import type { HostContext, HostResult, JsonValue } from '@deviceforge/plugin-sdk';
import { createJobRunner, decodeEmptyArtifactResult, jsonObject, onlyKeys, requireJson } from '@deviceforge/business-kit/jobs';
import { createSettings } from '@deviceforge/settings/model';
import { createBrowserManagementClient } from '../browser-management.ts';
import type { InstallationSource } from '../browser-management.ts';
import type { MarketplaceController } from '../model/index.ts';
import { createMarketplaceApi } from './api/client.ts';
import { createMarketplacePackages, managementResult } from './packages.ts';
import { createMarketplaceConfigurations } from './configuration.ts';
import { createInstalledCatalog } from './installed.ts';
import { isInstallation } from './catalog-validation.ts';
import {
  cleanupInstallationResourcesEndpoint, eventsEndpoint, jobEndpoint, unloadPluginEndpoint, uploadInstallationArtifactEndpoint,
} from './api/index.ts';
import { publicJob } from './api/jobs.ts';
import { isLegacyCleanupWarning } from './installations.ts';
import type { PluginInstallation } from './installations.ts';
import type { DependencyTarget } from './dependencies/index.ts';

export function createMarketplaceServices(context: HostContext, marketplace: MarketplaceController) {
  const client = createMarketplaceApi(context), management = createBrowserManagementClient(context);
  const packages = createMarketplacePackages(context, client), installed = createInstalledCatalog(context, client);
  const configurations = createMarketplaceConfigurations(context, client);
  const settings = createSettings(context, { signal: context.signal });
  const jobs = createJobRunner(context);
  const downloads = new Map<string, ReturnType<typeof setTimeout>>();
  let cleanupProgress: import('./installations.ts').InstallationProgress | null = null;
  let cleanupSequence = 0;
  const progressListeners = new Set<() => void>();
  function notify() { for (const listener of progressListeners) { try { listener(); } catch { /* 进度订阅不改变任务。 */ } } }
  const cleanupRunner = createJobRunner({
    submit: async () => { throw new Error('托管资源使用公开安装端点提交'); },
    async getJob(id, signal) {
      const result = await client.call(jobEndpoint, id, signal);
      const updates = await client.call(eventsEndpoint, { id, query: { after: cleanupSequence } }, signal);
      signal.throwIfAborted();
      for (const event of updates.data) {
        if (event.job_id !== id || !Number.isSafeInteger(event.sequence) || event.sequence <= cleanupSequence)
          throw new ApiError('protocol', 'marketplace_event_identity_mismatch', '资源任务事件身份或顺序不一致', null, updates.logId);
        cleanupSequence = event.sequence;
      }
      const progress = updates.data.filter((event) => event.progress).at(-1)?.progress ?? null;
      cleanupProgress = { jobId: id, operation: result.data.operation, status: result.data.status, progress, logId: result.logId };
      notify();
      return { ...result, data: publicJob(result.data, result.logId) };
    },
    cancelJob: async () => { throw new Error('停止页面等待不自动取消资源清理'); },
  });
  async function installation(input: Parameters<typeof management.request>[0], signal: AbortSignal): Promise<PluginInstallation> {
    const result = await management.request(input, signal), value = managementResult(result.data, result.logId);
    if (!isInstallation(value)) throw new ApiError('protocol', 'marketplace_installation_mismatch', '安装回执不兼容，请查询原安装目录', null, result.logId);
    return value;
  }
  async function installationRefresh(signal: AbortSignal): Promise<HostResult<readonly PluginInstallation[]>> {
    const value = await installed.refreshBrowser(signal);
    return { data: value.installations, logId: null };
  }
  const installations = {
    install: (source: InstallationSource, signal: AbortSignal) => installation({ action: 'installation', operation: 'install', source }, signal),
    update: (id: string, revision: string, source: InstallationSource, signal: AbortSignal) =>
      installation({ action: 'installation', operation: 'update', id, revision, source }, signal),
    setEnabled: (id: string, revision: string, enabled: boolean, signal: AbortSignal) =>
      installation({ action: 'installation', operation: enabled ? 'enable' : 'disable', id, revision }, signal),
    retryBrowser: (id: string, revision: string, signal: AbortSignal) =>
      installation({ action: 'installation', operation: 'retryBrowser', id, revision }, signal),
    async uninstall(id: string, revision: string, signal: AbortSignal) {
      const result = await management.request({ action: 'installation', operation: 'remove', id, revision }, signal);
      managementResult(result.data, result.logId);
    },
    refresh: installationRefresh,
    async cleanup(dryRun: boolean, signal: AbortSignal) {
      const current = AbortSignal.any([signal, context.signal, AbortSignal.timeout(120_000)]);
      cleanupSequence = 0; cleanupProgress = null; notify();
      const submitted = await client.call(cleanupInstallationResourcesEndpoint, { dry_run: dryRun }, current);
      const outcome = await cleanupRunner.resume({
        id: submitted.data.id, operation: submitted.data.operation, submitLogId: submitted.logId,
      }, current, (value) => value);
      await installationRefresh(current);
      return { data: outcome.data, logId: outcome.logId };
    },
    progressSnapshot: () => cleanupProgress ?? installed.snapshot().browser?.progress ?? null,
    subscribeProgress(listener: () => void) {
      progressListeners.add(listener);
      const release = installed.subscribe(listener);
      return () => { progressListeners.delete(listener); release(); };
    },
  };
  const artifacts = {
    async upload(filename: string, content: Blob, signal: AbortSignal) {
      if (!context.artifacts) throw new Error('宿主未提供产物上传');
      return context.artifacts.upload(filename, content, signal);
    },
  };
  const toolSupply = {
    importLocal(input: { archive_artifact_id: string; module_id: string; manifest: JsonValue }, signal: AbortSignal) {
      if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(input.module_id) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u.test(input.module_id) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.archive_artifact_id) || !jsonObject(input.manifest))
        throw new ApiError('protocol', 'invalid_local_tool_import', '工具导入身份、产物或清单无效');
      return jobs.execute('plugin.tool-supply.import', requireJson(input),
        AbortSignal.any([signal, context.signal, AbortSignal.timeout(120_000)]), (raw, logId) => {
        const value = decodeEmptyArtifactResult(raw, '本地工具导入', logId);
        if (!jsonObject(value) || !onlyKeys(value, ['module_id', 'version', 'changed', 'sha256']) ||
            value.module_id !== input.module_id || typeof value.version !== 'string' ||
            !/^\d+(?:\.\d+){0,7}$/u.test(value.version) || typeof value.changed !== 'boolean' ||
            typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(value.sha256))
          throw new ApiError('protocol', 'invalid_local_tool_result', '工具导入回执与预览不一致', null, logId);
        return { module_id: value.module_id, version: value.version, changed: value.changed, sha256: value.sha256 };
      });
    },
  };
  const services = {
    context, client, marketplace, management, packages, installed, installations,
    pluginConfigurations: configurations, settings, toolSupply, artifacts,
    installationArtifacts: {
      upload: (filename: string, content: Blob, signal: AbortSignal) =>
        client.call(uploadInstallationArtifactEndpoint, { filename, content }, signal),
    },
    serverPlugins: {
      refresh: installed.refreshServer,
      unload: (id: string, signal: AbortSignal) => client.call(unloadPluginEndpoint, id, signal),
    },
    async afterDependencies(target: DependencyTarget, signal: AbortSignal) {
      const directory = await installationRefresh(signal);
      const current = directory.data.find((entry) => target.kind === 'release' ? entry.id === target.id :
        entry.components.some((component) => component.id === target.id && component.kind === target.kind));
      if (current?.enabled && (current.status === 'enabled' || isLegacyCleanupWarning(current)) &&
          current.components.some((component) => component.kind === 'browser'))
        await installations.retryBrowser(current.id, current.revision, signal);
      await installed.refresh(signal);
    },
    download(blob: Blob, filename: string) {
      context.signal.throwIfAborted();
      const url = URL.createObjectURL(blob), anchor = document.createElement('a');
      const release = () => { URL.revokeObjectURL(url); downloads.delete(url); };
      try {
        anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click();
        downloads.set(url, setTimeout(release, 30_000));
      } catch (error) { release(); throw error; }
      finally { anchor.remove(); }
    },
    async dispose() {
      settings.dispose(); jobs.dispose(); cleanupRunner.dispose(); progressListeners.clear();
      for (const [url, timer] of downloads) { clearTimeout(timer); URL.revokeObjectURL(url); }
      downloads.clear();
      await installed.dispose();
    },
  };
  context.onDispose(services.dispose);
  return services;
}
export type MarketplaceServices = ReturnType<typeof createMarketplaceServices>;
