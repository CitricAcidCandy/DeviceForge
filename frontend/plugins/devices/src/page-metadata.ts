import type { DeviceSnapshot, HostContext } from '@deviceforge/plugin-sdk';
import { DEVICE_TASKS_POINT, DEVICES_WORKSPACE_ID } from './contracts.ts';

function operations(snapshot: DeviceSnapshot | undefined): readonly string[] {
  return [...new Set(snapshot?.providers.flatMap(({ definition }) =>
    [definition.discoverOperation, ...definition.capabilities.map((entry) => entry.operation)]) ?? [])].sort();
}

/** 领域归属由设备插件发布；平台只校验和更新通用页面目录。 */
export function registerDevicePage(context: HostContext) {
  const ui = context.ui;
  if (!ui) throw new Error('设备页面需要公开工作区能力');
  const id = 'deviceforge_devices.page';
  const points = context.extensions?.points;
  const releasePoint = points?.define({ ...DEVICE_TASKS_POINT, title: '设备页面任务归属', modes: ['append'],
    inputSchema: { type: 'object', required: ['operations'], additionalProperties: false, properties: {
      operations: { type: 'array', maxItems: 256, uniqueItems: true,
        items: { type: 'string', pattern: '^[a-zA-Z0-9._:-]{1,256}$' } },
    } },
  });
  const collect = (snapshot: DeviceSnapshot | undefined) => {
    const additional = points?.list(DEVICE_TASKS_POINT).flatMap((entry) => {
      const value = entry.data;
      if (entry.state !== 'active' || entry.mode !== 'append' || value === null || typeof value !== 'object' || Array.isArray(value)) return [];
      return Array.isArray(value.operations) ? value.operations.filter((operation): operation is string => typeof operation === 'string') : [];
    }) ?? [];
    return [...new Set([...operations(snapshot), ...additional])].sort();
  };
  let previous = collect(context.devices?.snapshot());
  ui.register({ pages: [{
    id, title: '设备', route: '/devices', workspaceId: DEVICES_WORKSPACE_ID,
    navigation: { group: '工作台', order: 10, icon: 'smartphone', description: '设备画面、应用与设备操作' },
    operations: previous, taskPolicy: 'listed',
  }] });
  const update = ui.updatePage;
  if (!update) return () => releasePoint?.();
  const refresh = (snapshot: DeviceSnapshot | undefined) => {
    if (context.signal.aborted) return;
    const next = collect(snapshot);
    if (next.length === previous.length && next.every((value, index) => value === previous[index])) return;
    update.call(ui, id, { operations: next });
    previous = next;
  };
  const devices = context.devices?.subscribe(refresh);
  const contributions = points?.subscribe(() => refresh(context.devices?.snapshot()));
  return () => { devices?.(); contributions?.(); return releasePoint?.(); };
}
