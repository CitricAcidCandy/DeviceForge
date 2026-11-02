import { HostError } from '@deviceforge/plugin-sdk';
import type { HostContext, JsonValue, WebPlugin } from '@deviceforge/plugin-sdk';

/** 这是提供者公开契约的精确身份，不读取提供者工程，也不要求它先加载。 */
export const SUITE_BROWSER_ID = 'workspace_suite.browser';
const TOOLS_POINT = { id: `${SUITE_BROWSER_ID}.tools`, version: '1' };
const READ_SERVICE = { id: `${SUITE_BROWSER_ID}.message.read`, version: '1' };
const NORMALIZE_SERVICE = { id: `${SUITE_BROWSER_ID}.normalize`, version: '1' };
function emptyInput(value: JsonValue) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 0)
    throw new HostError('protocol', 'contributor_input_invalid', '此操作只接受空对象');
}

export default function createWorkspaceContributor(identity: Pick<WebPlugin, 'id' | 'version' | 'apiVersion'>): WebPlugin {
  return {
    ...identity, panels: [],
    async activate(context: HostContext) {
      const points = context.extensions?.points, extensions = context.extensions;
      const register = extensions?.register, services = context.services;
      if (!points || !register || !services)
        throw new HostError('protocol', 'contributor_capability_missing', '需要公开扩展点、服务和功能级依赖');
      const prefix = identity.id, featureId = `${prefix}.provider`, commandId = `${prefix}.read-provider`;
      let active = false, completedReads = 0;
      // 根贡献允许先于扩展点出现，提供者撤销后自然回到等待状态。
      points.contribute({
        id: `${prefix}.reader`, point: TOOLS_POINT, order: 10,
        data: { title: '读取配套示例数据', commandId },
      });
      register({
        commands: [{
          id: `${prefix}.status`, title: '查看贡献插件独立状态',
          async execute(input, _caller, signal) {
            signal.throwIfAborted(); emptyInput(input);
            return {
              data: {
                active, completedReads,
                contributions: points.list(TOOLS_POINT).filter((item) => item.provider.pluginId === prefix)
                  .map((item) => ({ id: item.id, state: item.state })),
                features: services.diagnostics().filter((item) => item.featureId === featureId)
                  .map((item) => ({ featureId: item.featureId, state: item.state,
                    missing: item.missing.map((ref) => ({ ...ref })), error: item.error })),
              },
              logId: null,
            };
          },
        }],
      });
      services.whenAvailable(featureId, [READ_SERVICE, NORMALIZE_SERVICE], (feature) => {
        const featureRegister = feature.extensions?.register, featureServices = feature.services;
        if (!featureRegister || !featureServices)
          throw new HostError('protocol', 'contributor_feature_context_missing', '功能子上下文缺少公开服务或登记入口');
        active = true;
        featureRegister({
          commands: [
            { id: commandId, title: '读取配套示例数据',
              async execute(input, caller, signal) {
                signal.throwIfAborted(); emptyInput(input);
                const call = caller.services;
                if (!call) throw new HostError('protocol', 'contributor_services_missing', '当前调用没有服务入口');
                const result = await call.call(READ_SERVICE, {}, signal);
                signal.throwIfAborted(); feature.signal.throwIfAborted();
                completedReads++;
                return result;
              } },
            { id: `${prefix}.normalize`, title: '调用配套示例规范化服务',
              async execute(input, caller, signal) {
                signal.throwIfAborted();
                if (!caller.services)
                  throw new HostError('protocol', 'contributor_services_missing', '当前调用没有服务入口');
                const result = await caller.services.call(NORMALIZE_SERVICE, input, signal);
                signal.throwIfAborted(); feature.signal.throwIfAborted();
                return result;
              } },
          ],
        });
        return () => { active = false; };
      });
    },
  };
}
