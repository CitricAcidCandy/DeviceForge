import {
  ApiError,
  deletePackageEndpoint,
  installPackageEndpoint,
  updatePackageEndpoint,
  packagesEndpoint,
} from '../../../services/api/index.ts';
import type {
  ApiClient,
  ApiResult,
  PackageInfo,
  PackageKind,
  PackageMediaType,
  PluginInfo,
} from '../../../services/api/index.ts';
import { createLatestResource } from '../../../shared/lifecycle/latest.ts';
import type { WebPluginRuntimeInfo } from '../../../plugin-sdk/index.ts';

export interface PackageActions {
  readonly enableServer: (id: string, signal: AbortSignal) => Promise<ApiResult<PluginInfo>>;
  readonly disableServer: (id: string, signal: AbortSignal) => Promise<ApiResult<PluginInfo>>;
  readonly prepareServerRemoval: (id: string, signal: AbortSignal) => Promise<void>;
  readonly enableBrowser: (pkg: PackageInfo, signal: AbortSignal) => Promise<WebPluginRuntimeInfo>;
  readonly disableBrowser: (id: string) => Promise<void>;
  readonly forgetBrowser: (id: string) => Promise<void>;
}
export function createPluginPackages(client: ApiClient, actions: PackageActions) {
  const directories = {
    server: createLatestResource<PackageInfo[]>(),
    browser: createLatestResource<PackageInfo[]>(),
  };
  const lifetime = new AbortController();
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  const combined = (signal: AbortSignal) =>
    closed ? AbortSignal.abort() : AbortSignal.any([signal, lifetime.signal]);
  const refresh = (kind: PackageKind, signal: AbortSignal) =>
    directories[kind].run(
      (current) => client.call(packagesEndpoint, kind, combined(current)),
      combined(signal),
    );
  const check = (signal: AbortSignal) => {
    if (combined(signal).aborted) throw new ApiError('cancelled', 'cancelled', '插件包等待已取消');
  };
  function serial<T>(
    kind: PackageKind,
    signal: AbortSignal,
    run: (current: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const execute = async () => {
      check(signal);
      let result: T;
      try {
        result = await run(combined(signal));
      } catch (error) {
        // 安装/删除等待取消可能已生效，用独立生命周期重新读取实际部署目录。
        if (!lifetime.signal.aborted) {
          try {
            await refresh(kind, lifetime.signal);
          } catch {
            /* 原错误与目录失败快照分别保留。 */
          }
        }
        throw error;
      }
      if (!lifetime.signal.aborted) await refresh(kind, lifetime.signal);
      return result;
    };
    const pending = queue.then(execute, execute);
    queue = pending.catch(() => undefined);
    return pending;
  }
  return {
    refresh,
    snapshot: (kind: PackageKind) => directories[kind].snapshot(),
    subscribe: (
      kind: PackageKind,
      listener: Parameters<typeof directories.server.subscribe>[0],
    ) => {
      if (closed) throw new Error('插件包已关闭');
      return directories[kind].subscribe(listener);
    },
    upload: (
      kind: PackageKind,
      content: Blob,
      mediaType: PackageMediaType,
      signal: AbortSignal,
      expected?: Readonly<Pick<PackageInfo, 'id' | 'version'>>,
    ) =>
      serial(kind, signal, (current) =>
        client.call(
          installPackageEndpoint,
          { kind, content, mediaType, ...(expected === undefined ? {} : { expected }) },
          current,
        ),
      ),
    update: (
      kind: PackageKind,
      id: string,
      content: Blob,
      mediaType: PackageMediaType,
      signal: AbortSignal,
      expectedVersion?: PackageInfo['version'],
    ) =>
      serial(kind, signal, async (current) => {
        if (kind === 'server') await actions.prepareServerRemoval(id, current);
        else await actions.forgetBrowser(id);
        check(current);
        return client.call(
          updatePackageEndpoint,
          { kind, id, content, mediaType, ...(expectedVersion === undefined ? {} : { expectedVersion }) },
          current,
        );
      }),
    enable: (
      kind: PackageKind,
      id: string,
      signal: AbortSignal,
    ): Promise<ApiResult<PluginInfo | WebPluginRuntimeInfo>> =>
      serial(kind, signal, async (current) => {
        const directory = await refresh(kind, current);
        const pkg = directory.data.find((item) => item.id === id && item.kind === kind);
        if (!pkg)
          throw new ApiError(
            'protocol',
            'package_not_installed',
            '插件包尚未安装',
            null,
            directory.logId,
          );
        if (kind === 'server') return actions.enableServer(id, current);
        if (pkg.api_version !== 2)
          throw new ApiError(
            'protocol',
            'unsupported_plugin_api',
            '浏览器插件包须使用 SDK v2',
            null,
            directory.logId,
          );
        return { data: await actions.enableBrowser(pkg, current), logId: directory.logId };
      }),
    disable: (
      kind: PackageKind,
      id: string,
      signal: AbortSignal,
    ): Promise<ApiResult<PluginInfo | null>> =>
      serial(kind, signal, async (current) => {
        if (kind === 'server') return actions.disableServer(id, current);
        await actions.disableBrowser(id);
        return { data: null, logId: null };
      }),
    remove: (kind: PackageKind, id: string, signal: AbortSignal) =>
      serial(kind, signal, async (current) => {
        if (kind === 'server') await actions.prepareServerRemoval(id, current);
        else await actions.forgetBrowser(id);
        check(current);
        return client.call(deletePackageEndpoint, { kind, id }, current);
      }),
    dispose() {
      closed = true;
      directories.server.dispose();
      directories.browser.dispose();
      lifetime.abort();
    },
  };
}
