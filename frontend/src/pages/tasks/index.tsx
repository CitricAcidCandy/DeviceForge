import type { HostContext } from '../../plugin-sdk/index.ts';
import { TasksPluginPage } from '@deviceforge/tasks/view';

/** 旧宿主调用入口只传公开上下文；业务实现属于独立任务插件。 */
export function TasksPage({ services }: {
  services: { readonly runtime: { readonly host: HostContext } };
}) {
  return <TasksPluginPage context={services.runtime.host} />;
}
