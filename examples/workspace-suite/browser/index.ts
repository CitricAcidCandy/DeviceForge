import { HostError } from '@deviceforge/plugin-sdk';
import type { HostContext, JsonValue, WebPlugin } from '@deviceforge/plugin-sdk';
import { createMessageStore, emptyInput, MESSAGE_SCHEMA } from './domain/message.ts';
import { normalizeRemote } from './remote/normalize.ts';
import { attachView } from './workspace.ts';
import { mountProxy } from './proxy-view.ts';
import { activationGeneration } from './domain/generation.ts';
import { createViewReplacement } from './replacement.ts';

function snapshotValue(value: ReturnType<ReturnType<typeof createMessageStore>['read']>): JsonValue {
  return { value: { message: value.value.message }, revision: value.revision };
}

/** 身份由单一 manifest 的发布包装注入，源码不重复维护插件版本。 */
export default function createWorkspaceSuite(identity: Pick<WebPlugin, 'id' | 'version' | 'apiVersion'>): WebPlugin {
  return {
    ...identity, panels: [],
    async activate(context: HostContext) {
      const ui = context.ui, points = context.extensions?.points, extensions = context.extensions;
      const register = extensions?.register, data = context.data;
      if (!ui?.mount || !points || !register || !data || !context.services)
        throw new HostError('protocol', 'example_composition_missing',
          '示例需要公开工作区渲染、扩展点、服务和数据能力，不会降级为宿主私有调用');
      const prefix = identity.id, point = { id: `${prefix}.tools`, version: '1' };
      const replacement = createViewReplacement(context, prefix);
      const store = createMessageStore(activationGeneration(), context.signal);
      const read = { id: `${prefix}.message.read`, version: '1' };
      const write = { id: `${prefix}.message.write`, version: '1' };
      const source = { id: `${prefix}.message`, version: '1' };
      const workspaceId = `${prefix}.workspace`, instanceId = `${prefix}.main.default`;
      points.define({
        ...point, title: '示例插件工具', modes: ['append', 'replace'],
        inputSchema: { type: 'object', properties: {
          title: { type: 'string', minLength: 1 }, commandId: { type: 'string', minLength: 1 },
        }, required: ['title', 'commandId'], additionalProperties: false },
      });
      register({
        services: [
          { ...read, inputSchema: { type: 'object', additionalProperties: false },
            async invoke(input, _caller, signal) {
              signal.throwIfAborted(); emptyInput(input);
              return { data: snapshotValue(store.read()), logId: null };
            } },
          { ...write, async invoke(input, _caller, signal) {
            signal.throwIfAborted();
            const saved = store.write(input);
            extensions.emitEvent(`${prefix}.message.changed`, { revision: saved.revision });
            return { data: snapshotValue(saved), logId: null };
          } },
          { id: `${prefix}.normalize`, version: '1', inputSchema: MESSAGE_SCHEMA, outputSchema: MESSAGE_SCHEMA,
            async invoke(input, caller, signal) {
              const result = await normalizeRemote(caller, input, signal);
              return { data: { ...result.data }, logId: result.logId };
            } },
        ],
        commands: [
          { id: `${prefix}.attach`, title: '将示例视图追加到所选工作区',
            async execute(input, caller, signal) {
              signal.throwIfAborted();
              return { data: attachView(caller, prefix, input), logId: null };
            } },
          { id: `${prefix}.tools`, title: '读取示例扩展点贡献',
            async execute(input, _caller, signal) {
              signal.throwIfAborted(); emptyInput(input);
              return { data: points.list(point).map((entry) => ({
                id: entry.id, state: entry.state, selected: entry.selected, data: entry.data,
              })), logId: null };
            } },
          { id: `${prefix}.replace-view`, title: '显式替换所选实例的视图提供者',
            async execute(input, _caller, signal) {
              return { data: replacement.replace(input, signal), logId: null };
            } },
          { id: `${prefix}.restore-view`, title: '核对原替换结果后恢复视图提供者',
            async execute(input, _caller, signal) {
              return { data: replacement.restore(input, signal), logId: null };
            } },
        ],
      });
      data.register({
        ...source, title: '示例内存消息', readOnly: false, persistence: 'memory',
        applyPolicy: 'immediate', schema: MESSAGE_SCHEMA, read, write,
      });
      ui.register({
        workspaces: [{ id: workspaceId, title: '独立组合示例',
          defaultLayout: { version: 1, root: { kind: 'view', instanceId }, floating: [], overlays: [] } }],
        pages: [{ id: `${prefix}.page`, title: '独立组合示例', route: '/workspace-suite', workspaceId,
          navigation: { group: '插件', order: 90, description: '复用公开文件视图的独立配套插件' } }],
        views: [{ id: `${prefix}.main`, title: '组合示例文件视图', provides: ['example.workspace.proxy'],
          mount: (target, caller, instance) => mountProxy(target, caller, instance, prefix) }],
      });
      const layout = ui.readLayout(workspaceId);
      if (layout?.root?.kind === 'view' && layout.root.instanceId === instanceId)
        ui.open({ instanceId, workspaceId, provider: { pluginId: prefix, viewId: `${prefix}.main` }, target: null },
          context.signal);
      // 页面消费者拥有临时组合实例；本贡献卸载时由它们恢复原区域，无需用户搭建。
      for (const pointId of ['deviceforge_devices.tools', 'deviceforge_files.tools']) points.contribute({
        id: `${prefix}.auto.${pointId}`, point: { id: pointId, version: '1' }, mode: 'append', order: 50,
        data: { title: '组合示例文件视图', pluginId: prefix, viewId: `${prefix}.main` },
      });
    },
  };
}
