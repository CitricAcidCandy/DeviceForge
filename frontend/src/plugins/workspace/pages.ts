import type { WorkspacePageDefinition, WorkspacePageUpdate } from '../../plugin-sdk/workspace.ts';
import { clone, invalid, record, requireTitle } from './rules.ts';

export function updatedPageMetadata(page: WorkspacePageDefinition, changes: WorkspacePageUpdate): WorkspacePageDefinition {
  if (!record(changes) || Object.keys(changes).some((key) =>
    !['title', 'navigation', 'operations', 'taskPolicy'].includes(key)))
    invalid('仅允许更新页面展示与任务归属元数据');
  const next = { ...page, ...changes };
  requireTitle(next.title);
  validatePageMetadata(next);
  return Object.freeze({ ...next,
    ...(next.navigation ? { navigation: clone(next.navigation) } : {}),
    ...(next.operations ? { operations: clone(next.operations) } : {}),
  });
}

/** 页面元数据只表达导航与任务归属，不解释任何业务操作。 */
export function validatePageMetadata(page: WorkspacePageDefinition): void {
  const navigation = page.navigation;
  if (navigation !== undefined) {
    if (!record(navigation) || Object.keys(navigation).some((key) =>
      !['group', 'order', 'icon', 'hidden', 'description'].includes(key)))
      invalid('页面导航元数据无效');
    if (navigation.order !== undefined && !Number.isSafeInteger(navigation.order))
      invalid('页面导航顺序必须是安全整数');
    if (navigation.hidden !== undefined && typeof navigation.hidden !== 'boolean')
      invalid('页面导航隐藏状态无效');
    for (const key of ['group', 'icon', 'description']) {
      const value = navigation[key];
      if (value !== undefined && (typeof value !== 'string' || !value.trim() ||
          value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)))
        invalid('页面导航文字无效或过长');
    }
  }
  if (page.operations !== undefined && (!Array.isArray(page.operations) ||
      page.operations.length > 256 || new Set(page.operations).size !== page.operations.length ||
      page.operations.some((value) => typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,256}$/.test(value))))
    invalid('页面操作归属必须是不重复的有界标识列表');
  if (page.taskPolicy !== undefined && page.taskPolicy !== 'listed' && page.taskPolicy !== 'all')
    invalid('页面操作归属策略无效');
}
