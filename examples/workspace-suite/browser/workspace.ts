import { HostError } from '@deviceforge/plugin-sdk';
import { isJsonValue } from '@deviceforge/plugin-sdk/json';
import type { HostContext, JsonValue, WorkspaceLayout } from '@deviceforge/plugin-sdk';
import { record } from './domain/message.ts';
import { appendViewLayout } from './domain/layout.ts';

/** 显式命令只追加自有实例；不改选目标、不复用第一项，也不在激活时改他人布局。 */
export function attachView(context: HostContext, pluginId: string, input: JsonValue) {
  const ui = context.ui;
  if (!ui) throw new HostError('protocol', 'example_ui_missing', '宿主未提供公开工作区');
  context.signal.throwIfAborted();
  if (!record(input) || Object.keys(input).length !== 3 ||
      typeof input.workspaceId !== 'string' || typeof input.instanceId !== 'string' ||
      !input.instanceId.startsWith(`${pluginId}.`) || !isJsonValue(input.target))
    throw new HostError('protocol', 'example_attach_input',
      '请显式填写 workspaceId、插件命名空间下的 instanceId 和 target');
  const explicitTarget = input.target;
  if (!isJsonValue(explicitTarget))
    throw new HostError('protocol', 'example_attach_target', 'target 必须是完整 JSON 值');
  const catalog = ui.catalog(), workspaceId = input.workspaceId, instanceId = input.instanceId;
  const pages = catalog.pages.filter((page) => page.workspaceId === workspaceId &&
    (page.route === '/devices' || page.route === '/files'));
  if (!catalog.workspaces.some((workspace) => workspace.id === workspaceId) || pages.length === 0)
    throw new HostError('protocol', 'example_workspace_missing', '所选设备或文件工作区不存在，请先从公开目录确认');
  if (pages.some((page) => page.route === '/devices')) {
    const target = explicitTarget;
    const reference = record(target) && record(target.reference) ? target.reference : null;
    if (!record(target) || target.kind !== 'device' || !reference ||
        typeof reference.providerId !== 'string' || !reference.providerId ||
        typeof reference.generation !== 'string' || !reference.generation ||
        typeof reference.localId !== 'string' || !reference.localId)
      throw new HostError('protocol', 'example_device_target', '设备工作区需要显式提供完整设备引用');
  }
  if (ui.snapshot().instances.some((instance) => instance.instanceId === instanceId))
    throw new HostError('protocol', 'example_instance_exists', '此实例已存在，不会覆盖原实例或其他插件');
  const original = ui.readLayout(workspaceId);
  if (!original) throw new HostError('protocol', 'example_layout_missing', '所选工作区没有可追加的现有布局');
  const next = appendViewLayout(original, instanceId);
  ui.open({ workspaceId, instanceId, provider: { pluginId, viewId: `${pluginId}.main` }, target: explicitTarget },
    context.signal);
  try {
    const current: WorkspaceLayout | null = ui.readLayout(workspaceId);
    if (JSON.stringify(current) !== JSON.stringify(original))
      throw new HostError('http', 'example_layout_conflict', '工作区布局已变化，请保留原布局并重新读取', null, 409);
    ui.writeLayout(workspaceId, next);
  } catch (error) {
    ui.close(instanceId);
    throw error;
  }
  return { workspaceId, instanceId };
}
