import type { JobEventDto } from '../../../services/api/index.ts';

const stages = {
  preparing: '准备安装', downloading: '下载资源', verifying: '校验资源',
  deploying: '部署组件', activating: '启用组件', complete: '处理完成',
};

export function formatJobProgress(value: NonNullable<JobEventDto['progress']>): string {
  const bytes = value.total_bytes == null
    ? `${value.completed_bytes.toLocaleString('zh-CN')} 字节`
    : `${value.completed_bytes.toLocaleString('zh-CN')} / ${value.total_bytes.toLocaleString('zh-CN')} 字节`;
  return `${stages[value.stage]}${value.resource_id ? ` · ${value.resource_id}` : ''} · ${bytes}`;
}
