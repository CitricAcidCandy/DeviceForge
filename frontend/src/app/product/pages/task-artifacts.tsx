import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '../../../components/ui/button.tsx';
import { decodeArtifactEnvelope, downloadPublishedArtifact } from '../../../shared/jobs/index.ts';
import { isRecord } from '../../../shared/api/validation.ts';
import type { ProductServices } from '../services.ts';
import { useAction } from '../hooks.ts';
import { ActionFeedback, ErrorNotice } from '../feedback.tsx';
import { BlobDownload } from './profile-view.tsx';

// 只从公开产物封套取得文件；下载复用大小与 SHA-256 校验，任务切换时释放链接。
export function TaskArtifacts({ services, value, logId }: { services: ProductServices; value: unknown; logId: string | null }) {
  const publication = useMemo(() => {
    if (!isRecord(value) || !Object.hasOwn(value, 'artifacts')) return null;
    try { return { envelope: decodeArtifactEnvelope(value, '任务产物', logId), error: null }; }
    catch (error) { return { envelope: null, error }; }
  }, [value, logId]);
  const action = useAction();
  const [downloaded, setDownloaded] = useState<{ blob: Blob; filename: string } | null>(null);
  if (!publication) return null;
  if (!publication.envelope) return <ErrorNotice error={publication.error} />;
  const envelope = publication.envelope;
  if (envelope.artifacts.length === 0) return null;
  return <section className="workspace-section" aria-label="任务产物"><h3>任务文件</h3>
    <div className="action-row">{envelope.artifacts.map(artifact => <Button key={artifact.id} variant="outline" disabled={action.pending} onClick={() => {
      void action.run(async signal => {
        setDownloaded(null);
        const result = await downloadPublishedArtifact(services.runtime.artifacts, envelope, artifact.filename, signal);
        if (!signal.aborted) setDownloaded({ blob: result.data, filename: artifact.filename });
        return result;
      });
    }}><Download />{artifact.filename} · {artifact.size.toLocaleString()} 字节</Button>)}</div>
    <ActionFeedback {...action} />{downloaded && <BlobDownload {...downloaded} label={`保存 ${downloaded.filename}`} />}
  </section>;
}
