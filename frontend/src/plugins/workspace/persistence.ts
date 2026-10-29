import type { WorkspaceSavedState } from '../../plugin-sdk/workspace.ts';
import { layoutInstanceIds, validateWorkspaceLayout } from './layout.ts';
import { invalid, record, requireId, requireJson, requireOwnedId, requirePluginId, requireRef } from './rules.ts';

/** 恢复入口接受未知内容，先整批验证再替换，失败不影响当前布局与运行实例。 */
export function validateSavedState(value: unknown): asserts value is WorkspaceSavedState {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.instances) || !Array.isArray(value.layouts) ||
      value.instances.length > 256 || value.layouts.length > 128)
    invalid('工作区保存数据版本或数量无效');
  if (Object.keys(value).some((key) => !['version', 'instances', 'layouts'].includes(key)))
    invalid('工作区保存数据包含未知字段');
  const instances = new Set<string>();
  const instanceWorkspaces = new Map<string, string>();
  for (const input of value.instances) {
    if (!record(input)) invalid('保存的视图实例无效');
    if (Object.keys(input).some((key) => !['instanceId', 'pluginId', 'workspaceId', 'provider', 'target', 'visible'].includes(key)))
      invalid('保存的视图实例包含运行时或未知字段');
    requirePluginId(input.pluginId);
    requireOwnedId(input.pluginId, input.instanceId);
    requireId(input.workspaceId);
    if (instances.has(input.instanceId)) invalid('保存的视图实例重复');
    instances.add(input.instanceId);
    instanceWorkspaces.set(input.instanceId, input.workspaceId);
    if (input.provider !== null) requireRef(input.provider);
    if (input.target !== undefined) requireJson(input.target);
    if (input.visible !== undefined && typeof input.visible !== 'boolean') invalid('保存的实例可见性无效');
  }
  const workspaces = new Set<string>();
  for (const entry of value.layouts) {
    if (!record(entry)) invalid('保存的工作区布局无效');
    if (Object.keys(entry).some((key) => !['workspaceId', 'layout'].includes(key))) invalid('保存的布局包含未知字段');
    requireId(entry.workspaceId);
    if (workspaces.has(entry.workspaceId)) invalid('保存的工作区布局重复');
    workspaces.add(entry.workspaceId);
    validateWorkspaceLayout(entry.layout);
    for (const instanceId of layoutInstanceIds(entry.layout)) {
      const workspaceId = instanceWorkspaces.get(instanceId);
      if (workspaceId !== undefined && workspaceId !== entry.workspaceId) invalid('保存的布局引用了其他工作区实例');
    }
  }
}
