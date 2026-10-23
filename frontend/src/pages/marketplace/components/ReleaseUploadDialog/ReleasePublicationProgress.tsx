import type { ReleasePublicationProgress } from '../../release-publication/index.ts';

const stageLabels: Record<ReleasePublicationProgress['stage'], string> = {
  checking: '正在检查发布内容',
  uploading: '正在上传组件与工具依赖',
  manifest: '正在上传在线发布清单',
  catalog: '正在提交唯一市场条目',
  complete: '完整功能插件发布完成',
};

export function ReleasePublicationProgressView({ progress }: { progress: ReleasePublicationProgress }) {
  return (
    <section role="status" aria-live="polite" aria-label="完整发布进度" className="grid gap-1 text-sm">
      <strong>{stageLabels[progress.stage]}</strong>
      {progress.totalResources > 0 && (
        <p>资源 {progress.completedResources} / {progress.totalResources} · {progress.completedBytes.toLocaleString('zh-CN')} / {progress.totalBytes.toLocaleString('zh-CN')} 字节</p>
      )}
      {progress.current && <p className="break-all text-muted-foreground">{progress.current}</p>}
    </section>
  );
}
