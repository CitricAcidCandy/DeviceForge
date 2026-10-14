import { useEffect, useState } from 'react';

// 页面暂时保留通用 Blob 下载工具；业务展示从各功能组件入口公开。
export { ProfileArchiveView } from '../../../features/android-profile/components/index.ts';
export { PerformanceReadings } from '../../../features/performance/components/index.ts';

export function metricText(value: number | null | undefined, unit = ''): string {
  return value == null ? '—' : `${Number.isInteger(value) ? value : value.toFixed(2)}${unit ? ` ${unit}` : ''}`;
}

// 每个对象 URL 只属于当前 Blob；更换结果与卸载时释放，不让旧画面混入新样本。
export function useBlobUrl(blob: Blob | null): string | null {
  const [current, setCurrent] = useState<{ blob: Blob; url: string } | null>(null);
  useEffect(() => {
    if (!blob) { setCurrent(null); return; }
    const url = URL.createObjectURL(blob);
    setCurrent({ blob, url });
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  return current?.blob === blob ? current.url : null;
}

export function BlobDownload({ blob, filename, label }: { blob: Blob; filename: string; label: string }) {
  const url = useBlobUrl(blob);
  return url ? <a className="artifact-download" href={url} download={filename}>{label}</a> : <span className="muted">正在准备下载链接</span>;
}
