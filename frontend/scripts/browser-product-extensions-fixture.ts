import type { CommandContribution, JsonValue, WebPlugin } from '../src/plugin-sdk/index.ts';
import type { JobDto, OperationDto, PackageInfo } from '../src/services/api/index.ts';
import { createSettingsBrowserFixture } from './browser-product-extensions-settings-fixture.ts';

export const extensionPluginId = 'fixture.product';
export const extensionThemeId = `${extensionPluginId}.theme`;
export const extensionVariable = '--product-extensions-probe';
export const extensionThemeValue = '受控主题值';
export const extensionObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const extensionReply = (data: unknown, status = 200) => Response.json({log_id: 'product-extensions-log', data}, {status, headers: {'x-deviceforge-log-id': 'product-extensions-log'}});

export function createExtensionBrowserFixture() {
  const requests: {method: string; path: string; input: unknown}[] = [];
  const settings = createSettingsBrowserFixture(); const jobs = new Map<string, JobDto>();
  const imports: string[] = []; const calls: {kind: string; input: JsonValue; aborted: boolean}[] = [];
  const lifecycle = {activated: 0, deactivated: 0, mounted: 0, released: 0, aborted: 0};
  const packages = new Map<string, PackageInfo>();
  const packageInfo: PackageInfo = {id: extensionPluginId, kind: 'browser', version: '1.0.0', runtime: 'browser', entry_path: 'dist/index.js', api_version: 2, installed_at: 1};
  const mount = (label: string): WebPlugin['panels'][number]['mount'] => async (target, context) => {
    const node = document.createElement('p'); node.dataset.extensionFixture = label; node.textContent = `${label}内容`; target.append(node); lifecycle.mounted++;
    return () => {node.remove(); lifecycle.released++; if (context.signal.aborted) lifecycle.aborted++;};
  };
  const invoke = (kind: string): CommandContribution['execute'] => async (input, context, signal) => {
    calls.push({kind, input, aborted: signal.aborted || context.signal.aborted});
    return {data: {kind, input, result: `${kind}公开结果`}, logId: 'extension-call-log'};
  };
  const plugin: WebPlugin = {id: extensionPluginId, version: packageInfo.version, apiVersion: 2, panels: [],
    async activate() {lifecycle.activated++;}, deactivate() {lifecycle.deactivated++;},
    contributions: {
      themes: [{id: extensionThemeId, title: '受控公开主题', variables: {[extensionVariable]: extensionThemeValue}, colorScheme: 'dark'}],
      modules: [{id: `${extensionPluginId}.module`, title: '受控模块', route: '/fixture-module', mount: mount('受控模块')}],
      components: [
        {id: `${extensionPluginId}.append`, title: '追加组件', slot: 'workshop.extensions', mode: 'append', mount: mount('追加组件')},
        {id: `${extensionPluginId}.replace`, title: '替换组件', slot: 'workshop.extensions', mode: 'replace', mount: mount('替换组件')},
        {id: `${extensionPluginId}.unsupported`, title: '未提供槽位组件', slot: 'fixture.absent', mount: mount('未提供槽位组件')},
      ],
      commands: [{id: `${extensionPluginId}.command`, title: '受控命令', execute: invoke('命令')}],
      services: [{id: `${extensionPluginId}.service`, version: '1', invoke: invoke('服务')}],
    }};
  const operations: OperationDto[] = ['list', 'get', 'set', 'delete', 'import', 'remote.load', 'remote.save'].map(action => ({id: `plugin.settings.${action}`, title: action, input_schema: {type: 'object'}}));
  const transport: typeof fetch = async (resource, options) => {
    const url = resource instanceof Request ? new URL(resource.url) : new URL(String(resource)); const method = options?.method ?? 'GET';
    const input: unknown = typeof options?.body === 'string' ? JSON.parse(options.body) : null; requests.push({method, path: url.pathname + url.search, input});
    if (options?.signal?.aborted) throw new DOMException('受控请求已取消', 'AbortError');
    if (url.pathname === '/api/v2/operations') return extensionReply(operations);
    if (['/api/v2/device-providers', '/api/v2/devices', '/api/v2/plugins'].includes(url.pathname)) return extensionReply([]);
    if (url.pathname === '/api/v2/plugin-packages/server') return extensionReply([]);
    if (url.pathname === '/api/v2/plugin-packages/browser') {
      if (method === 'POST') {if (!(options?.body instanceof Blob) || url.searchParams.get('format') !== 'zip') throw new Error('浏览器包未使用公开ZIP原字节上传'); packages.set(packageInfo.id, packageInfo); return extensionReply(packageInfo, 201);}
      return extensionReply([...packages.values()]);
    }
    if (url.pathname === `/api/v2/plugin-packages/browser/${extensionPluginId}` && method === 'DELETE') {packages.delete(extensionPluginId); return extensionReply(packageInfo);}
    if (url.pathname === '/api/v2/jobs') {
      if (method !== 'POST') return extensionReply([...jobs.values()]);
      if (!extensionObject(input) || typeof input['operation'] !== 'string' || !extensionObject(input['input'])) throw new Error('受控配置任务形状无效');
      const outcome = settings.execute(input['operation'], input['input']);
      const job: JobDto = {id: crypto.randomUUID(), operation: input['operation'], input: input['input'], created_at: 1,
        status: outcome.error ? 'failed' : 'succeeded', result: outcome.result ?? null, error: outcome.error ?? null};
      jobs.set(job.id, job); return extensionReply(job, 201);
    }
    const match = /^\/api\/v2\/jobs\/([^/]+)(?:\/(events))?$/.exec(url.pathname);
    if (match?.[1]) {if (match[2]) return extensionReply([]); const job = jobs.get(match[1]); if (!job) throw new Error('受控任务不存在'); return extensionReply(job);}
    throw new Error(`未列出的扩展配置请求：${method} ${url.pathname}`);
  };
  return {transport, requests, imports, calls, lifecycle, settings,
    importer: async (url: string, signal: AbortSignal) => {if (signal.aborted) throw new DOMException('受控模块已取消', 'AbortError'); imports.push(url); return {default: plugin};},
    packageCount: () => packages.size,
  };
}
