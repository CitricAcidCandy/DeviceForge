import { HostError, readHostError } from '../../plugin-sdk/index.ts';
import type { Dispose, HostContext, HostResult, JsonValue } from '../../plugin-sdk/index.ts';
import { abortable } from '../../services/api/abort.ts';
import { awaitLifecycle } from '../../plugins/lifecycle.ts';
import type { ExtensionRegistry } from '../../plugins/extensions/registry.ts';
import type { ResourceSnapshot } from '../../shared/lifecycle/latest.ts';
import { isJsonData } from '../../shared/jobs/values.ts';
import type { InstallationSource } from '../../features/plugin-installations/index.ts';
import type { PlatformRuntime } from '../platform-runtime.ts';
import { publicCall } from '../public-api.ts';

export interface BundledBrowserEntry {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly phase: 'idle' | 'loading' | 'loaded' | 'disabled' | 'external' | 'unavailable' | 'failed';
  readonly error: string | null;
}
export interface BundledBrowserManagement {
  snapshot(): readonly BundledBrowserEntry[];
  setEnabled(id: string, enabled: boolean, signal: AbortSignal): Promise<void>;
  subscribe(listener: () => void): Dispose;
}
export interface BrowserManagementOptions {
  readonly runtime: Pick<PlatformRuntime,
    'webPlugins' | 'pluginPackages' | 'pluginInstallations' | 'pluginConfigurations' | 'bundledPlugins' | 'artifacts'>;
  readonly bundled?: BundledBrowserManagement;
}
export interface BrowserManagementHost {
  readonly host: HostContext;
  readonly extensions: Pick<ExtensionRegistry, 'register'>;
}
function invalid(): HostError {
  return new HostError('protocol', 'invalid_browser_management_input', '浏览器管理动作或参数不符合公开契约');
}
function object(value: JsonValue): { [key: string]: JsonValue } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value;
}
function fields(value: { [key: string]: JsonValue }, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw invalid();
}
function text(value: JsonValue | undefined, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid();
  return value;
}
function identity(value: JsonValue | undefined): string {
  const id = text(value, 128);
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/u.test(id)) throw invalid();
  return id;
}
function revision(value: JsonValue | undefined): string {
  const current = text(value, 64);
  if (!/^[a-f0-9]{64}$/u.test(current)) throw invalid();
  return current;
}
function source(value: JsonValue | undefined): InstallationSource {
  if (value === undefined) throw invalid();
  const input = object(value);
  if (input.kind === 'offline') {
    fields(input, ['kind', 'artifactId']);
    return { kind: 'offline', artifactId: text(input.artifactId, 128) };
  }
  fields(input, ['kind', 'sourceUrl', 'releaseId', 'version', 'releaseDigest']);
  if (input.kind !== 'market') throw invalid();
  const sourceUrl = text(input.sourceUrl, 2048);
  let url: URL;
  try { url = new URL(sourceUrl); } catch { throw invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalid();
  return { kind: 'market', sourceUrl, releaseId: identity(input.releaseId),
    version: text(input.version, 128), releaseDigest: revision(input.releaseDigest) };
}
function json(value: unknown): JsonValue {
  if (!isJsonData(value))
    throw new HostError('protocol', 'invalid_browser_management_result', '浏览器管理结果不是有限 JSON 数据');
  return structuredClone(value);
}
function error(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  const details = readHostError(value);
  if (details) return { ...details };
  let message = '管理操作失败，详情未确认';
  try { if (value instanceof Error && typeof value.message === 'string') message = value.message; }
  catch { /* 撤销的代理或异常字段访问不应破坏其他管理诊断。 */ }
  return { message };
}
function directory<T>(state: ResourceSnapshot<readonly T[]>): JsonValue {
  return json({ known: !state.pending && state.result !== null && state.error === null,
    pending: state.pending, entries: state.result?.data ?? [], logId: state.result?.logId ?? null, error: error(state.error) });
}
async function readDirectory<T>(
  snapshot: () => ResourceSnapshot<T>,
  subscribe: (listener: (value: ResourceSnapshot<T>) => void) => Dispose,
  refresh: (signal: AbortSignal) => Promise<HostResult<T>>,
  signal: AbortSignal,
): Promise<HostResult<T>> {
  signal.throwIfAborted();
  if (!snapshot().pending) return refresh(signal);
  let release: Dispose = () => undefined;
  try {
    return await awaitLifecycle(() => new Promise<HostResult<T>>((resolve, reject) => {
      const update = (state: ResourceSnapshot<T>) => {
        if (state.pending) return;
        if (state.error) reject(state.error);
        else if (state.result) resolve(state.result);
        else reject(new HostError('protocol', 'browser_directory_unknown', '浏览器安装目录尚未确认'));
      };
      release = subscribe(update);
      update(snapshot());
    }), signal, Date.now() + 15_000, '浏览器管理目录核对');
  } finally { await release(); }
}

/** 仅装配已有浏览器管理能力；不创建管理器、安装执行器或业务页面。 */
export function registerBrowserManagementServices(root: BrowserManagementHost, options: BrowserManagementOptions): Dispose {
  const { host } = root;
  const extensions = host.extensions;
  if (!extensions) throw new Error('宿主未提供动态服务注册');
  host.signal.throwIfAborted();
  const { runtime } = options;
  const lifetime = new AbortController(), releases: Dispose[] = [];
  let change = 0;
  const active = (signal: AbortSignal) => {
    if (signal.aborted) throw new HostError('cancelled', 'browser_management_revoked', '浏览器管理等待已撤销');
  };
  const notify = () => {
    if (!lifetime.signal.aborted && !host.signal.aborted)
      extensions.emitEvent('host.browser-plugins.changed', { revision: ++change });
  };
  const catalog = (): JsonValue => {
    const packages = runtime.pluginPackages.snapshot('browser');
    const installations = runtime.pluginInstallations.snapshot();
    const bundled = options.bundled?.snapshot() ?? [];
    const origin = (id: string) => installations.result?.data.some((entry) =>
      entry.components.some((component) => component.kind === 'browser' && component.id === id)) ? 'installation'
      : packages.result?.data.some((entry) => entry.id === id) ? 'package'
        : runtime.bundledPlugins.has(id) || bundled.some((entry) => entry.id === id && entry.phase !== 'external')
          ? 'bundled' : bundled.some((entry) => entry.id === id) ? 'unknown' : 'registered';
    return json({
      snapshotVersion: 1, packages: directory(packages), installations: directory(installations),
      runtime: runtime.webPlugins.diagnosticSnapshot().map((entry) => ({
        ...entry, source: runtime.bundledPlugins.has(entry.id) ? 'bundled' : origin(entry.id), installedSource: origin(entry.id),
      })),
      bundled: bundled.map((entry) => ({ ...entry, source: origin(entry.id) })),
      clients: runtime.pluginInstallations.clientSnapshot(), progress: runtime.pluginInstallations.progressSnapshot(),
      cleanup: runtime.webPlugins.cleanupSnapshot().map((entry) => ({ id: entry.id, generation: entry.generation, error: error(entry.error) })),
      workspaceCleanup: runtime.webPlugins.workspaceCleanupSnapshot().map((entry) => ({
        pluginId: entry.pluginId, instanceId: entry.instanceId, generation: entry.generation, at: entry.at, error: error(entry.error),
      })),
    });
  };
  const readPackages = (signal: AbortSignal) => readDirectory(
    () => runtime.pluginPackages.snapshot('browser'), (listener) => runtime.pluginPackages.subscribe('browser', listener),
    (current) => runtime.pluginPackages.refresh('browser', current), signal);
  const readInstallations = (signal: AbortSignal) => readDirectory(
    runtime.pluginInstallations.snapshot, runtime.pluginInstallations.subscribe, runtime.pluginInstallations.refresh, signal);
  const completed = (result: unknown, logId: string | null = null): HostResult<JsonValue> =>
    ({ data: { completed: true, result: result === undefined ? null : json(result) }, logId });
  async function independent(id: string, signal: AbortSignal, required = true) {
    const [packages, installations] = await Promise.all([readPackages(signal), readInstallations(signal)]);
    active(signal);
    if (installations.data.some((entry) => entry.components.some((component) =>
      component.kind === 'browser' && component.id === id)))
      throw new HostError('protocol', 'installation_component_managed', '此组件属于完整安装，请按安装身份和修订管理');
    if (required && !packages.data.some((entry) => entry.id === id))
      throw new HostError('protocol', 'browser_package_not_installed', '浏览器插件包不在当前安装目录中', packages.logId);
  }
  async function dispatch(value: JsonValue, signal: AbortSignal): Promise<HostResult<JsonValue>> {
    active(signal);
    const input = object(value);
    if (input.action === 'snapshot' || input.action === 'refresh') {
      fields(input, ['action']);
      if (input.action === 'refresh') await Promise.all([readPackages(signal), readInstallations(signal)]);
      active(signal);
      return { data: catalog(), logId: null };
    }
    if (input.action === 'setEnabled') {
      fields(input, ['action', 'source', 'id', 'enabled']);
      const id = identity(input.id);
      if (typeof input.enabled !== 'boolean' || !['package', 'bundled'].includes(String(input.source))) throw invalid();
      if (input.source === 'bundled') {
        const source = options.bundled;
        if (!source || !source.snapshot().some((entry) => entry.id === id))
          throw new HostError('protocol', 'bundled_browser_unavailable', '当前随附目录没有此浏览器插件');
        await source.setEnabled(id, input.enabled, signal);
        active(signal);
        return completed(null);
      }
      await independent(id, signal);
      const result = input.enabled ? await runtime.pluginPackages.enable('browser', id, signal)
        : await runtime.pluginPackages.disable('browser', id, signal);
      active(signal);
      return completed(result.data, result.logId);
    }
    if (input.action === 'package') {
      const id = identity(input.id);
      if (input.operation === 'remove') {
        fields(input, ['action', 'operation', 'id']);
        await independent(id, signal);
        const result = await runtime.pluginPackages.remove('browser', id, signal);
        return completed(result.data, result.logId);
      }
      fields(input, ['action', 'operation', 'id', 'artifactId', 'mediaType', 'version']);
      if (input.operation !== 'upload' && input.operation !== 'update' ||
          input.mediaType !== 'application/zip' && input.mediaType !== 'application/gzip') throw invalid();
      const artifactId = text(input.artifactId, 256), version = text(input.version, 128);
      await independent(id, signal, input.operation === 'update');
      const artifact = await runtime.artifacts.download(artifactId, signal);
      active(signal);
      const result = input.operation === 'upload'
        ? await runtime.pluginPackages.upload('browser', artifact.data, input.mediaType, signal, { id, version })
        : await runtime.pluginPackages.update('browser', id, artifact.data, input.mediaType, signal, version);
      return completed(result.data, result.logId);
    }
    if (input.action === 'configuration') {
      const id = identity(input.id), target = { kind: 'browser', id } as const;
      if (input.operation === 'get') {
        fields(input, ['action', 'operation', 'id']);
        return completed(await runtime.pluginConfigurations.get(target, signal));
      }
      const expected = text(input.revision);
      if (input.operation === 'save') {
        fields(input, ['action', 'operation', 'id', 'revision', 'values']);
        if (input.values === undefined) throw invalid();
        return completed(await runtime.pluginConfigurations.save(target, expected, input.values, signal));
      }
      fields(input, ['action', 'operation', 'id', 'revision']);
      if (input.operation === 'reset') return completed(await runtime.pluginConfigurations.reset(target, expected, signal));
      if (input.operation === 'apply') return completed(await runtime.pluginConfigurations.apply(target, expected, signal));
      throw invalid();
    }
    if (input.action === 'installation') {
      if (input.operation === 'install') {
        fields(input, ['action', 'operation', 'source']);
        return completed(await runtime.pluginInstallations.install(source(input.source), signal));
      }
      const id = identity(input.id), expected = revision(input.revision);
      if (input.operation === 'update') {
        fields(input, ['action', 'operation', 'id', 'revision', 'source']);
        return completed(await runtime.pluginInstallations.update(id, expected, source(input.source), signal));
      }
      fields(input, ['action', 'operation', 'id', 'revision']);
      if (input.operation === 'enable' || input.operation === 'disable')
        return completed(await runtime.pluginInstallations.setEnabled(id, expected, input.operation === 'enable', signal));
      if (input.operation === 'remove') return completed(await runtime.pluginInstallations.uninstall(id, expected, signal));
      if (input.operation === 'retryBrowser') return completed(await runtime.pluginInstallations.retryBrowser(id, expected, signal));
    }
    throw invalid();
  }
  let disposal: Promise<void> | null = null;
  const dispose = () => {
    if (disposal) return disposal;
    lifetime.abort();
    const tasks = releases.splice(0).reverse().map((release) => {
      try { return Promise.resolve(release()); }
      catch (error) { return Promise.reject(error); }
    });
    disposal = Promise.allSettled(tasks).then((results) => {
      const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, '浏览器管理服务释放未全部确认');
    });
    return disposal;
  };
  try {
    releases.push(root.extensions.register({ pluginId: 'host', generation: 0, context: host }, { services: [{
    id: 'host.browser-plugins', version: '1',
    inputSchema: { type: 'object', required: ['action'], properties: { action: {
      enum: ['snapshot', 'refresh', 'setEnabled', 'package', 'configuration', 'installation'],
    } } },
    async invoke(input, _context, caller) {
      const signal = AbortSignal.any([caller, host.signal, lifetime.signal]);
      active(signal);
      return publicCall(abortable(Promise.resolve().then(async () => {
        active(signal);
        const result = await dispatch(input, signal);
        active(signal);
        return result;
      }), signal), (value) => value);
    },
    }] }));
    for (const subscribe of [
      () => runtime.pluginPackages.subscribe('browser', notify),
      () => runtime.pluginInstallations.subscribe(notify), () => runtime.pluginInstallations.subscribeClient(notify),
      () => runtime.pluginInstallations.subscribeProgress(notify), () => extensions.subscribeEvent('host.plugins.changed', notify),
      ...(options.bundled ? [() => options.bundled?.subscribe(notify)] : []),
    ]) {
      const release = subscribe();
      if (release) releases.push(release);
    }
  } catch (error) {
    void dispose().catch(() => undefined);
    throw error;
  }

  return host.onDispose(dispose);
}
