import { useMemo, useState } from 'react';
import { hostUi } from '@deviceforge/plugin-sdk';
import type { HostContext, JsonValue } from '@deviceforge/plugin-sdk';
import { decodePublication, downloadTaskArtifact } from './model/index.ts';
import { ActionError, Button, useAction } from './view-support.tsx';

export function TaskArtifacts({ context, value, logId }: {
  context: HostContext; value: JsonValue; logId: string | null;
}) {
  const publication = useMemo(() => {
    try { return { envelope: decodePublication(value, logId), error: null }; }
    catch (error) { return { envelope: null, error }; }
  }, [value, logId]);
  const action = useAction();
  const [downloaded, setDownloaded] = useState<{ blob: Blob; filename: string } | null>(null);
  const Download = hostUi().BlobDownload;
  if (publication.error) return <ActionError error={publication.error} />;
  const envelope = publication.envelope;
  if (!envelope?.artifacts.length) return null;
  return <section className="space-y-2" aria-label="任务产物">
    <h3 className="text-[13px] font-semibold text-[color:var(--text-muted)]">任务文件</h3>
    <div className="flex flex-wrap gap-2">
      {envelope.artifacts.map((artifact) => <Button key={artifact.id} variant="outline"
        disabled={action.pending} onClick={() => void action.run(async (signal) => {
          setDownloaded(null);
          const result = await downloadTaskArtifact(context, envelope, artifact.id, signal);
          if (!signal.aborted) setDownloaded({ blob: result.data, filename: artifact.filename });
        })}>
        {artifact.filename} · {artifact.size.toLocaleString()} 字节
      </Button>)}
    </div>
    <ActionError error={action.error} />
    {downloaded && <Download {...downloaded} label={`保存 ${downloaded.filename}`} />}
  </section>;
}
