import { hostUi } from '@deviceforge/plugin-sdk';
import type { HostContext } from '@deviceforge/plugin-sdk';
import { createPublicFileBrowser } from './gateway.ts';
import type { FileBrowser, FileFailure } from './model/index.ts';

function logId(value: unknown): string | null {
  return value !== null && typeof value === 'object' &&
    'logId' in value && typeof value.logId === 'string' ? value.logId : null;
}
function saveArtifact(content: Blob, filename: string, documentRef: Document): void {
  const url = URL.createObjectURL(content);
  try {
    const link = documentRef.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
  } finally { URL.revokeObjectURL(url); }
}

export function FilesView({
  browser, signal, documentRef,
}: { browser: FileBrowser; signal?: AbortSignal; documentRef?: Document }) {
  const ui = hostUi();
  const { useEffect, useMemo, useRef, useState, useSyncExternalStore } = ui.React;
  const snapshotSource = useMemo(() => ({
    subscribe: (notify: () => void) => browser.subscribe(() => notify()),
    read: browser.snapshot,
  }), [browser]);
  const snapshot = useSyncExternalStore(snapshotSource.subscribe, snapshotSource.read, snapshotSource.read);
  const [id, setId] = useState('');
  const [offset, setOffset] = useState('0');
  const [limit, setLimit] = useState('50');
  const [deletion, setDeletion] = useState<{ id: string; filename: string } | null>(null);
  const [feedback, setFeedback] = useState<{ message: string; logId: string | null; failed: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const active = useRef<AbortController | null>(null);
  const lifetime = useRef(new AbortController());
  useEffect(() => {
    const controller = lifetime.current;
    return () => { controller.abort(); active.current?.abort(); };
  }, []);
  const run = async (work: (current: AbortSignal) => Promise<unknown>) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const current = AbortSignal.any([controller.signal, lifetime.current.signal, ...(signal ? [signal] : [])]);
    setPending(true);
    setFeedback(null);
    try {
      const result = await work(current);
      if (active.current === controller && !current.aborted)
        setFeedback({ message: '调用完成', logId: logId(result), failed: false });
    } catch (error) {
      if (active.current === controller && !current.aborted)
        setFeedback({ message: error instanceof Error ? error.message : '调用失败', logId: logId(error), failed: true });
    } finally {
      if (active.current === controller) {
        active.current = null;
        if (!lifetime.current.signal.aborted) setPending(false);
      }
    }
  };
  const metadata = snapshot.metadata;
  const page = snapshot.page;
  const readPage = (next: number) => {
    setOffset(String(next));
    void run((current) => browser.page({ offset: next, limit: Number(limit) }, current));
  };
  const error: FileFailure | null = snapshot.error?.kind === 'cancelled' ? null : snapshot.error;
  return (
    <section className="@container/files flex min-h-full min-w-0 flex-col gap-4 bg-[#F5F6FB] p-6 text-[#222631]" aria-label="文件与产物">
      <a href="#/settings" className="self-start text-xs text-[#6C4CF5] hover:underline">← 返回设置</a>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] tracking-[0.14em] text-[#596479]">服务器产物</p>
          <h1 className="mt-1 text-xl font-semibold">文件</h1>
          <p className="mt-1 text-xs text-[#596479]">浏览服务器任务产物与 ZIP 目录。从任务结果复制产物 ID，或直接上传文件。</p>
        </div>
      </header>
      <div className="grid min-w-0 gap-4 @3xl/files:grid-cols-[250px_minmax(0,1fr)]">
        <aside className="flex min-w-0 flex-col gap-4 rounded-xl border border-[#E6EAF3] bg-white p-4" aria-label="选择服务器文件">
          <ui.Label htmlFor="artifact-upload">上传文件</ui.Label>
          <ui.Input id="artifact-upload" type="file" disabled={pending} onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void run(async (current) => {
              const result = await browser.upload(file.name, file, current);
              if (!current.aborted) { setId(result.data.id); await browser.select(result.data.id, current); }
              return result;
            });
          }} />
          <ui.Field label="产物 ID" value={id} onChange={setId} placeholder="任务结果中的 UUID" />
          <ui.Button disabled={!id || pending} onClick={() => { void run((current) => browser.select(id, current)); }}>
            打开文件
          </ui.Button>
          {pending && <ui.Button variant="outline" onClick={() => {
            active.current?.abort();
            active.current = null;
            setPending(false);
            setFeedback({ message: '已停止等待。操作结果未确认，请先重新查询，不要自动重放。', logId: null, failed: false });
          }}>取消等待</ui.Button>}
          {(feedback || error) && <div role={error || feedback?.failed ? 'alert' : 'status'} className="break-words rounded-lg border border-[#E6EAF3] bg-[#F8F9FD] p-3 text-xs leading-5">
            {error?.message ?? feedback?.message}
            {(error?.logId ?? feedback?.logId) && <p className="mt-2 break-all font-mono text-[10px] text-[#596479]">日志：{error?.logId ?? feedback?.logId}</p>}
          </div>}
          <p className="text-xs leading-5 text-[#596479]">当前是服务器产物，不使用设备文件。切换页面保留草稿，关闭视图会释放本实例。</p>
        </aside>
        <main className="min-w-0 rounded-xl border border-[#E6EAF3] bg-white p-5">
          {metadata ? <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0"><h2 className="break-all text-base font-semibold">{metadata.filename}</h2><p className="mt-1 break-all font-mono text-[10px] text-[#596479]">{metadata.id}</p></div>
              <div className="flex flex-wrap gap-2">
                <ui.Button variant="outline" disabled={pending} onClick={() => { void run(async (current) => {
                  const result = await browser.download(metadata.id, current);
                  if (!current.aborted) saveArtifact(result.data, metadata.filename, documentRef ?? document);
                  return result;
                }); }}>下载原文件</ui.Button>
                <ui.Button variant="destructive" disabled={pending} onClick={() => setDeletion({ id: metadata.id, filename: metadata.filename })}>删除产物</ui.Button>
              </div>
            </div>
            <dl className="my-5 grid grid-cols-1 gap-4 rounded-lg bg-[#F8F9FD] p-4 text-xs @lg/files:grid-cols-2">
              <div><dt className="text-[#596479]">类型</dt><dd className="mt-1 break-all">{metadata.mediaType}</dd></div>
              <div><dt className="text-[#596479]">大小</dt><dd className="mt-1">{metadata.size.toLocaleString()} 字节</dd></div>
              <div><dt className="text-[#596479]">发布于</dt><dd className="mt-1">{new Date(metadata.createdAt).toLocaleString()}</dd></div>
              <div><dt className="text-[#596479]">SHA-256</dt><dd className="mt-1 break-all font-mono text-[10px]">{metadata.sha256}</dd></div>
            </dl>
            {metadata.mediaType === 'application/zip' ? <>
              <h3 className="text-sm font-semibold">ZIP 目录预览</h3>
              <div className="my-4 flex flex-wrap items-end gap-3">
                <ui.Field label="目录偏移" value={offset} type="number" min={0} onChange={setOffset} />
                <ui.Field label="每页条目" value={limit} type="number" min={1} max={200} onChange={setLimit} />
                <ui.Button variant="outline" disabled={pending} onClick={() => readPage(Number(offset))}>读取目录</ui.Button>
              </div>
              {page && <>
                <div className="overflow-x-auto">
                  <ui.Table><ui.TableHeader><ui.TableRow><ui.TableHead>名称</ui.TableHead><ui.TableHead>类型</ui.TableHead><ui.TableHead>原大小</ui.TableHead><ui.TableHead>压缩大小</ui.TableHead></ui.TableRow></ui.TableHeader>
                    <ui.TableBody>{page.entries.map((entry) => <ui.TableRow key={entry.name}><ui.TableCell>{entry.name}</ui.TableCell><ui.TableCell>{entry.directory ? '目录' : '文件'}</ui.TableCell><ui.TableCell>{entry.size}</ui.TableCell><ui.TableCell>{entry.compressedSize}</ui.TableCell></ui.TableRow>)}</ui.TableBody>
                  </ui.Table>
                </div>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-[#596479]">
                  <p>共 {page.total} 个条目 · 当前偏移 {offset}</p>
                  <div className="flex gap-2"><ui.Button variant="outline" disabled={pending || Number(offset) === 0} onClick={() => readPage(Math.max(0, Number(offset) - Number(limit)))}>上一页</ui.Button><ui.Button variant="outline" disabled={pending || page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) readPage(page.nextOffset); }}>下一页</ui.Button></div>
                </div>
              </>}
            </> : <p className="text-xs text-[#596479]">此文件类型不提供普通 ZIP 目录预览，下载保留原字节。</p>}
          </> : <div className="grid min-h-72 place-content-center gap-2 text-center"><h2 className="text-sm font-semibold">尚未选择产物</h2><p className="text-xs text-[#596479]">上传文件或输入产物 ID。</p></div>}
        </main>
      </div>
      {deletion && <div className="fixed inset-0 z-[80] grid place-items-center bg-black/25 p-5">
        <section role="alertdialog" aria-modal="true" aria-labelledby="files-delete-title" aria-describedby="files-delete-description" className="max-h-[calc(100dvh-2.5rem)] w-full max-w-md overflow-y-auto rounded-xl border border-[#E6EAF3] bg-white p-6 shadow-xl">
          <h2 id="files-delete-title" className="text-base font-semibold">删除服务器产物？</h2>
          <p id="files-delete-description" className="mt-3 break-all text-sm leading-6 text-[#596479]">将删除 {deletion.filename}（{deletion.id}）。正在使用的产物由服务器拒绝删除；此操作不会删除设备文件。</p>
          <div className="mt-5 flex justify-end gap-2"><ui.Button variant="outline" autoFocus onClick={() => setDeletion(null)}>保留文件</ui.Button><ui.Button variant="destructive" disabled={pending} onClick={() => {
            const target = deletion;
            setDeletion(null);
            void run((current) => browser.remove(target.id, current));
          }}>确认删除</ui.Button></div>
        </section>
      </div>}
    </section>
  );
}

export function mountFiles(target: HTMLElement, context: HostContext) {
  const browser = createPublicFileBrowser(context);
  const ui = hostUi();
  const release = ui.mountReact(target, <FilesView browser={browser} signal={context.signal} documentRef={target.ownerDocument} />);
  return () => { release(); browser.dispose(); };
}
