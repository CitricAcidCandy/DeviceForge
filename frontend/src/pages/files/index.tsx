import { useState } from 'react';
import { Button } from '../../components/Button/index.tsx';
import { Input } from '../../components/Input/index.tsx';
import { Label } from '../../components/Label/index.tsx';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/Table/index.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../components/Dialog/index.tsx';
import { EmptyState, Field, PageTitle } from '../../components/index.ts';
import { ActionFeedback } from '../../app/product/feedback.tsx';
import { useAction, useSnapshot } from '../../app/product/hooks.ts';
import type { ProductServices } from '../../app/product/services.ts';

function saveArtifact(content: Blob, filename: string): void {
  const url = URL.createObjectURL(content);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
export function FilesPage({ services }: { services: ProductServices }) {
  const [id, setId] = useState('');
  const [offset, setOffset] = useState('0');
  const [limit, setLimit] = useState('50');
  const [deletion, setDeletion] = useState<{ id: string; filename: string } | null>(null);
  const snapshot = useSnapshot(services.artifactBrowser);
  const action = useAction();
  const metadata = snapshot.metadata;
  const page = snapshot.page;
  const readPage = (next: number) => {
    setOffset(String(next));
    void action.run((signal) =>
      services.artifactBrowser.page({ offset: next, limit: Number(limit) }, signal),
    );
  };
  return (
    <Dialog
      open={deletion !== null}
      onOpenChange={(open) => {
        if (!open) setDeletion(null);
      }}
    >
      <section className="product-page">
        <PageTitle
          eyebrow="服务器产物"
          title="文件"
          description="浏览任务发布的文件与 ZIP 目录。当前公开能力没有设备文件目录、推送或拉取接口。"
        />
        <div className="capability-notice">
          此页面不使用所选设备；文件由服务器产物 ID 定位。服务器尚未开放全产物目录，请从任务结果选取
          ID 或上传文件。
        </div>
        <div className="workspace-section">
          <Label htmlFor="artifact-upload">上传文件</Label>
          <Input
            id="artifact-upload"
            type="file"
            disabled={action.pending}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file)
                void action.run(async (signal) => {
                  const result = await services.artifactBrowser.upload(file.name, file, signal);
                  if (!signal.aborted) {
                    setId(result.data.id);
                    await services.artifactBrowser.select(result.data.id, signal);
                  }
                  return result;
                });
            }}
          />
          <div className="form-grid">
            <Field label="公开产物 ID" value={id} onChange={setId} />
            <Button
              disabled={!id || action.pending}
              onClick={() => {
                void action.run((signal) => services.artifactBrowser.select(id, signal));
              }}
            >
              读取文件元数据
            </Button>
          </div>
          <ActionFeedback {...action} />
        </div>
        {metadata ? (
          <div className="workspace-section">
            <h2>{metadata.filename}</h2>
            <dl className="metadata-grid">
              <div>
                <dt>产物 ID</dt>
                <dd>{metadata.id}</dd>
              </div>
              <div>
                <dt>类型</dt>
                <dd>{metadata.media_type}</dd>
              </div>
              <div>
                <dt>大小</dt>
                <dd>{metadata.size.toLocaleString()} 字节</dd>
              </div>
              <div>
                <dt>发布于</dt>
                <dd>{new Date(metadata.created_at).toLocaleString()}</dd>
              </div>
              <div>
                <dt>SHA-256</dt>
                <dd className="break-all">{metadata.sha256}</dd>
              </div>
            </dl>
            <div className="page-actions">
              <Button
                variant="outline"
                disabled={action.pending}
                onClick={() => {
                  const selected = metadata;
                  void action.run(async (signal) => {
                    const result = await services.artifactBrowser.download(selected.id, signal);
                    if (!signal.aborted) saveArtifact(result.data, selected.filename);
                    return result;
                  });
                }}
              >
                下载原文件
              </Button>
              <DialogTrigger asChild>
                <Button
                  variant="destructive"
                  disabled={action.pending}
                  onClick={() => setDeletion({ id: metadata.id, filename: metadata.filename })}
                >
                  删除产物
                </Button>
              </DialogTrigger>
            </div>
            {metadata.media_type === 'application/zip' ? (
              <>
                <h3>ZIP 目录预览</h3>
                <div className="form-grid">
                  <Field
                    label="目录偏移"
                    value={offset}
                    type="number"
                    min={0}
                    onChange={setOffset}
                  />
                  <Field
                    label="每页条目"
                    value={limit}
                    type="number"
                    min={1}
                    max={100}
                    onChange={setLimit}
                  />
                  <Button
                    variant="outline"
                    disabled={action.pending}
                    onClick={() => readPage(Number(offset))}
                  >
                    读取目录
                  </Button>
                </div>
                {page && (
                  <>
                    <div className="table-scroll">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>名称</TableHead>
                            <TableHead>类型</TableHead>
                            <TableHead>原大小</TableHead>
                            <TableHead>压缩大小</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {page.entries.map((entry) => (
                            <TableRow key={entry.name}>
                              <TableCell>{entry.name}</TableCell>
                              <TableCell>{entry.directory ? '目录' : '文件'}</TableCell>
                              <TableCell>{entry.size}</TableCell>
                              <TableCell>{entry.compressed_size}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    <p className="muted">
                      共 {page.total} 个条目 · 当前偏移 {offset}
                    </p>
                    <Button
                      variant="outline"
                      disabled={action.pending || Number(offset) === 0}
                      onClick={() => readPage(Math.max(0, Number(offset) - Number(limit)))}
                    >
                      上一页
                    </Button>
                    <Button
                      variant="outline"
                      disabled={action.pending || page.next_offset == null}
                      onClick={() => {
                        if (typeof page.next_offset === 'number') readPage(page.next_offset);
                      }}
                    >
                      下一页
                    </Button>
                  </>
                )}
              </>
            ) : (
              <p className="muted">此文件类型不提供普通 ZIP 目录预览，下载保留原字节。</p>
            )}
          </div>
        ) : (
          <EmptyState
            title="尚未选择产物"
            description="上传文件或输入任务结果中的产物 ID，查询真实元数据与文件内容。"
          />
        )}
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除服务器产物？</DialogTitle>
            <DialogDescription>
              将删除 {deletion?.filename}（{deletion?.id}
              ）。正在使用的产物会由服务器拒绝删除；此操作不会删除设备文件。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletion(null)}>
              保留文件
            </Button>
            <Button
              variant="destructive"
              disabled={action.pending}
              onClick={() => {
                const target = deletion;
                if (target) {
                  setDeletion(null);
                  void action.run((signal) => services.artifactBrowser.remove(target.id, signal));
                }
              }}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </section>
    </Dialog>
  );
}
