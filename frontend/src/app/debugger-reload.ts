import { HostError } from '../plugin-sdk/index.ts';
import type { JsonValue } from '../plugin-sdk/index.ts';
import type { createPluginManager, createInstalledPackageController } from '../plugins/index.ts';
import type { createPluginPackages } from '../features/plugin-packages/index.ts';
import type { PluginInstallations } from '../features/plugin-installations/index.ts';
import { createInstallationGateway } from '../features/plugin-installations/index.ts';
import type { ApiClient } from '../services/api/index.ts';

interface ReloadOptions {
  readonly client: ApiClient;
  readonly manager: () => Pick<ReturnType<typeof createPluginManager>, 'diagnosticSnapshot' | 'unload' | 'load'>;
  readonly packages: () => Pick<ReturnType<typeof createPluginPackages>, 'refresh' | 'enable'>;
  readonly browser: () => Pick<ReturnType<typeof createInstalledPackageController>, 'forget'>;
  readonly installations: () => Pick<PluginInstallations, 'retryBrowser'>;
  readonly forgetReleaseSource: (id: string) => void;
}

/** 重载从共同安装目录选择真实入口，不能把旧模块再加载一次当作升级成功。 */
export function createDebuggerReload(options: ReloadOptions) {
  const gateway = createInstallationGateway(options.client);
  return async (target: { readonly plugin_id: string; readonly generation: string }, signal: AbortSignal): Promise<JsonValue> => {
    const manager = options.manager();
    const current = () => manager.diagnosticSnapshot().find(item => item.id === target.plugin_id);
    const before = current();
    if (String(before?.generation) !== target.generation)
      throw new HostError('protocol', 'debugger_stale_generation', '重载前插件代次已变化，请重新选择当前目标');
    const installed = await gateway.list(signal);
    signal.throwIfAborted();
    const feature = installed.data.find(item => item.components.some(component => component.kind === 'browser' && component.id === target.plugin_id));
    if (feature && (!feature.enabled || feature.status !== 'enabled'))
      throw new HostError('protocol', 'debugger_target_disabled', '该完整功能目前未启用，请在原市场安装入口完成配置和启用后再调试', installed.logId);
    // 查询期间仍须核对代次，避免把另一个管理请求刚加载的新实例卸载掉。
    if (String(current()?.generation) !== target.generation)
      throw new HostError('protocol', 'debugger_stale_generation', '查询安装构建期间插件已换代，未继续重载');
    let scope = 'browser-runtime-only';
    let revision: string | null = null;
    if (feature) {
      await manager.unload(target.plugin_id);
      signal.throwIfAborted();
      // 完整功能仍由原协调器管理，不将组件拆成新的安装身份。
      await options.installations().retryBrowser(feature.id, feature.revision, signal);
      scope = 'installed-feature-browser-components'; revision = feature.revision;
    } else {
      const packages = await options.packages().refresh('browser', signal);
      signal.throwIfAborted();
      const pkg = packages.data.find(item => item.id === target.plugin_id);
      if (String(current()?.generation) !== target.generation)
        throw new HostError('protocol', 'debugger_stale_generation', '查询独立包期间插件已换代，未继续重载');
      if (pkg) {
        await options.browser().forget(target.plugin_id);
        options.forgetReleaseSource(target.plugin_id);
        signal.throwIfAborted();
        await options.packages().enable('browser', target.plugin_id, signal);
        scope = 'installed-standalone-browser-package';
      } else {
        await manager.unload(target.plugin_id);
        signal.throwIfAborted();
        await manager.load(target.plugin_id);
      }
    }
    signal.throwIfAborted();
    const after = current();
    if (!after || after.state !== 'loaded' || String(after.generation) === target.generation)
      throw new HostError('protocol', 'debugger_result_unconfirmed', '重载后的当前实例尚未确认，未自动重试，请重新查询运行目录');
    return { status: 'loaded', plugin_id: after.id, generation: String(after.generation), version: after.version,
      scope, installation_id: feature?.id ?? null, revision, installation_changed: false,
      note: '使用当前已安装代码；重载不回滚业务数据或设备副作用。新代次须在真实目录出现后重新选择。' };
  };
}
