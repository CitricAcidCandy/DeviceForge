import { hostUi } from '@deviceforge/plugin-sdk';
import type { HostContext, WorkspaceViewContext } from '@deviceforge/plugin-sdk';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@deviceforge/business-kit/dialog';
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

/** 文件表单经常处于插件分栏内，字段自身不保留宽页面的固定标签列。 */
function FileField({ label, value, onChange, type = 'text', min, max, placeholder }: {
  label: string; value: string; onChange(value: string): void;
  type?: 'text' | 'number'; min?: number; max?: number; placeholder?: string;
}) {
  const ui = hostUi(), id = ui.React.useId();
  return <div className="flex min-w-0 flex-col gap-[7px]">
    <ui.Label htmlFor={id} className="text-[14px] text-muted-foreground">{label}</ui.Label>
    <ui.Input id={id} className="min-w-0 w-full" value={value} type={type} min={min} max={max}
      placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
  </div>;
}

export function FilesView({
  browser, signal, documentRef, instance,
}: { browser: FileBrowser; signal?: AbortSignal; documentRef?: Document; instance?: WorkspaceViewContext }) {
  const ui = hostUi();
  const { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } = ui.React;
  const uploadId = useId();
  const helpId = useId();
  const [helpOpen, setHelpOpen] = useState(false);
  const snapshotSource = useMemo(() => ({
    subscribe: (notify: () => void) => browser.subscribe(() => notify()),
    read: browser.snapshot,
  }), [browser]);
  const snapshot = useSyncExternalStore(snapshotSource.subscribe, snapshotSource.read, snapshotSource.read);
  const [id, setId] = useState('');
  const [offset, setOffset] = useState('0');
  const [limit, setLimit] = useState('50');
  const [deletion, setDeletion] = useState<{ id: string; filename: string } | null>(null);
  const visibilitySource = useMemo(() => ({
    subscribe: (notify: () => void) => {
      const release = instance?.subscribeVisibility(() => notify());
      return () => { if (release) void Promise.resolve().then(release).catch(() => undefined); };
    },
    read: () => instance?.snapshot().visible ?? true,
  }), [instance]);
  const visible = useSyncExternalStore(visibilitySource.subscribe, visibilitySource.read, visibilitySource.read);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  useEffect(() => { if (!visible) setDeletion(null); }, [visible]);
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
    <Dialog open={visible && deletion !== null} onOpenChange={(open) => { if (!open) setDeletion(null); }}>
    <section hidden={!visible} inert={!visible} className="@container/files h-full min-h-0 min-w-0 overflow-auto overscroll-contain text-[15px] text-foreground [scrollbar-gutter:stable]" aria-label="文件与产物">
      <div className="mx-auto min-h-full w-full max-w-[1648px] px-6 pb-7 pt-[22px] @max-[900px]/files:px-4 @max-[900px]/files:pb-6 @max-[900px]/files:pt-4">
      <a href="#/settings" className="mb-3 inline-flex items-center gap-1 text-[13px] text-faint hover:text-body">← 返回设置</a>
      <header className="mb-6 flex min-w-0 flex-wrap items-start justify-between gap-5 border-b border-border pb-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold leading-[1.35]">文件</h1>
          <div className="mt-1.5 max-w-[680px] text-[13px] text-muted-foreground">
            <button type="button" aria-expanded={helpOpen} aria-controls={helpId}
              className="inline-flex min-h-6 items-center gap-1 text-left"
              onClick={() => setHelpOpen((value) => !value)}>
              <svg viewBox="0 0 12 12" className={`size-3 shrink-0 ${helpOpen ? 'rotate-90' : ''}`} aria-hidden="true"><path d="m4 2 4 4-4 4Z" fill="currentColor" /></svg>
              使用说明
            </button>
            <p id={helpId} hidden={!helpOpen} className="mt-2 leading-[1.7]">浏览服务器任务产物与 ZIP 目录。从任务结果复制产物 ID，或直接上传文件。</p>
          </div>
        </div>
      </header>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-6 @min-[1051px]/files:grid-cols-[minmax(240px,280px)_minmax(0,1fr)] @min-[1051px]/files:gap-8">
        <aside className="grid min-w-0 max-w-[640px] gap-3 border-b border-border pb-6 @min-[1051px]/files:max-w-none @min-[1051px]/files:border-b-0 @min-[1051px]/files:border-r @min-[1051px]/files:pb-0 @min-[1051px]/files:pr-7" aria-label="选择服务器文件">
          <ui.Label htmlFor={uploadId} className="text-[14px] text-muted-foreground">上传文件</ui.Label>
          <ui.Input id={uploadId} className="min-w-0" type="file" disabled={pending} onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void run(async (current) => {
              const result = await browser.upload(file.name, file, current);
              if (!current.aborted) { setId(result.data.id); await browser.select(result.data.id, current); }
              return result;
            });
          }} />
          <FileField label="产物 ID" value={id} onChange={setId} placeholder="任务结果中的 UUID" />
          <ui.Button className="justify-self-start" disabled={!id || pending} onClick={() => { void run((current) => browser.select(id, current)); }}>
            打开文件
          </ui.Button>
          {pending && <ui.Button className="justify-self-start" variant="outline" onClick={() => {
            active.current?.abort();
            active.current = null;
            setPending(false);
            setFeedback({ message: '已停止等待。操作结果未确认，请先重新查询，不要自动重放。', logId: null, failed: false });
          }}>取消等待</ui.Button>}
          {(feedback || error) && <div role={error || feedback?.failed ? 'alert' : 'status'} className="break-words rounded-lg border border-[#E6EAF3] bg-[#F8F9FD] p-3 text-xs leading-5">
            {error?.message ?? feedback?.message}
            {(error?.logId ?? feedback?.logId) && <p className="mt-2 break-all font-mono text-[10px] text-[#596479]">日志：{error?.logId ?? feedback?.logId}</p>}
          </div>}
          <p className="text-[13px] leading-5 text-muted-foreground">服务器产物，不使用当前设备。</p>
        </aside>
        <div className="min-h-60 min-w-0 @min-[1051px]/files:min-h-[400px]" aria-label="文件内容">
          {metadata ? <>
            <h2 className="mb-5 wrap-anywhere text-[17px] font-semibold">{metadata.filename}</h2>
            <dl className="my-3 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-x-5 gap-y-2 @min-[641px]/files:grid-cols-[repeat(2,minmax(0,1fr))]">
              <div className="min-w-0"><dt className="text-muted-foreground">产物 ID</dt><dd className="break-all">{metadata.id}</dd></div>
              <div className="min-w-0"><dt className="text-muted-foreground">类型</dt><dd className="break-all">{metadata.mediaType}</dd></div>
              <div className="min-w-0"><dt className="text-muted-foreground">大小</dt><dd>{metadata.size.toLocaleString()} 字节</dd></div>
              <div className="min-w-0"><dt className="text-muted-foreground">发布于</dt><dd>{new Date(metadata.createdAt).toLocaleString()}</dd></div>
              <div className="col-span-full min-w-0"><dt className="text-muted-foreground">SHA-256</dt><dd className="break-all">{metadata.sha256}</dd></div>
            </dl>
            <div className="mb-7 mt-5 flex flex-wrap items-center gap-2.5">
              <ui.Button variant="outline" disabled={pending} onClick={() => { void run(async (current) => {
                const result = await browser.download(metadata.id, current);
                if (!current.aborted) saveArtifact(result.data, metadata.filename, documentRef ?? document);
                return result;
              }); }}>下载原文件</ui.Button>
              <DialogTrigger asChild><ui.Button variant="destructive" disabled={pending}
                onClick={() => {
                  if (visibleRef.current) setDeletion({ id: metadata.id, filename: metadata.filename });
                }}>删除产物</ui.Button></DialogTrigger>
            </div>
            {metadata.mediaType === 'application/zip' ? <>
              <h3 className="text-[15px] font-semibold">ZIP 目录预览</h3>
              <div className="my-4 flex flex-wrap items-end gap-3">
                <FileField label="目录偏移" value={offset} type="number" min={0} onChange={setOffset} />
                <FileField label="每页条目" value={limit} type="number" min={1} max={200} onChange={setLimit} />
                <ui.Button variant="outline" disabled={pending} onClick={() => readPage(Number(offset))}>读取目录</ui.Button>
              </div>
              {page && <>
                <div className="overflow-x-auto">
                  <ui.Table><ui.TableHeader><ui.TableRow><ui.TableHead>名称</ui.TableHead><ui.TableHead>类型</ui.TableHead><ui.TableHead>原大小</ui.TableHead><ui.TableHead>压缩大小</ui.TableHead></ui.TableRow></ui.TableHeader>
                    <ui.TableBody>{page.entries.map((entry) => <ui.TableRow key={entry.name}><ui.TableCell>{entry.name}</ui.TableCell><ui.TableCell>{entry.directory ? '目录' : '文件'}</ui.TableCell><ui.TableCell>{entry.size}</ui.TableCell><ui.TableCell>{entry.compressedSize}</ui.TableCell></ui.TableRow>)}</ui.TableBody>
                  </ui.Table>
                </div>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-muted-foreground">
                  <p>共 {page.total} 个条目 · 当前偏移 {offset}</p>
                  <div className="flex gap-2"><ui.Button variant="outline" disabled={pending || Number(offset) === 0} onClick={() => readPage(Math.max(0, Number(offset) - Number(limit)))}>上一页</ui.Button><ui.Button variant="outline" disabled={pending || page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) readPage(page.nextOffset); }}>下一页</ui.Button></div>
                </div>
              </>}
            </> : <p className="text-muted-foreground">此文件类型不提供普通 ZIP 目录预览，下载保留原字节。</p>}
          </> : <div className="pb-6 text-left"><h3 className="mb-2 text-[15px] font-semibold">尚未选择产物</h3><p className="max-w-[490px] text-[14px] text-muted-foreground">上传文件或输入产物 ID。</p></div>}
        </div>
      </div>
      </div>
    </section>
    {visible && deletion && <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
      onCloseAutoFocus={(event) => { if (!visibleRef.current) event.preventDefault(); }}>
      <DialogHeader>
        <DialogTitle>删除服务器产物？</DialogTitle>
        <DialogDescription className="break-all">将删除 {deletion.filename}（{deletion.id}）。正在使用的产物会由服务器拒绝删除；此操作不会删除设备文件。</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <ui.Button variant="outline" onClick={() => setDeletion(null)}>保留文件</ui.Button>
        <ui.Button variant="destructive" disabled={pending} onClick={() => {
          const target = deletion;
          setDeletion(null);
          void run((current) => browser.remove(target.id, current));
        }}>确认删除</ui.Button>
      </DialogFooter>
    </DialogContent>}
    </Dialog>
  );
}

export function mountFiles(target: HTMLElement, context: HostContext, instance?: WorkspaceViewContext) {
  const browser = createPublicFileBrowser(context);
  const ui = hostUi();
  const release = ui.mountReact(target, <FilesView browser={browser} signal={context.signal} documentRef={target.ownerDocument}
    {...(instance ? { instance } : {})} />);
  return () => { release(); browser.dispose(); };
}
