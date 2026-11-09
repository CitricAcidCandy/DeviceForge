import { useState, useEffect, useId, useMemo, useRef, useSyncExternalStore } from 'react';
import { hostUi } from '@deviceforge/plugin-sdk';
import type { HostContext, WorkspaceViewContext } from '@deviceforge/plugin-sdk';
import { createFridaServices } from './services.ts';
const { Button } = hostUi();
const {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} = hostUi();
const { Input } = hostUi();
const { Label } = hostUi();
const {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} = hostUi();
import { RefreshCw, Download, FileCode2, Play } from 'lucide-react';
const { PageTitle, EmptyState, JsonResult } = hostUi();
import { FridaField as Field } from './field.tsx';
import { useOperationAvailable } from '@deviceforge/business-kit/react';
import { ActionFeedback } from '@deviceforge/business-kit/react';
import { useAction, useSnapshot } from '@deviceforge/business-kit/react';
import type { FridaServices } from './services.ts';
import type {
  FridaDeployment,
  FridaMode,
  FridaProcesses,
  FridaScriptResult,
  FridaServerRun,
  FridaStatus,
} from './model/index.ts';
import type { JobOutcome, PublishedResult } from '@deviceforge/business-kit/jobs';
import type { DeviceRef } from '@deviceforge/plugin-sdk';
import { withSelectedDevice } from '@deviceforge/business-kit/platform';
const { BlobDownload } = hostUi();

const actionClass = 'justify-self-start @min-[641px]/frida:mt-[27px] @min-[900px]/frida:mt-0';
const metadataClass = 'my-3 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 [&_dt]:text-muted-foreground [&_dd]:min-w-0 [&_dd]:wrap-anywhere @max-[640px]/frida-result:grid-cols-1 @max-[640px]/frida-result:gap-y-1 @max-[640px]/frida-result:[&_dd]:mb-3';

type FridaView =
  | FridaDeployment
  | FridaProcesses
  | FridaScriptResult
  | FridaServerRun
  | FridaStatus;
interface FridaOutput {
  readonly reference: DeviceRef;
  readonly outcome: JobOutcome<PublishedResult<FridaView>>;
}

export function FridaPage({ services, instance }: { services: FridaServices; instance?: WorkspaceViewContext }) {
  const id = useId(), modeId = `${id}-mode`, serverId = `${id}-server`, scriptId = `${id}-script`;
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
  const [modeOpen, setModeOpen] = useState(false);
  useEffect(() => { if (!visible) setModeOpen(false); }, [visible]);
  useEffect(() => {
    void services.operations.list(services.context.signal).catch(() => undefined);
  }, [services]);
  const device = useSnapshot(services.devices);
  const action = useAction();
  const [packageId, setPackageId] = useState('');
  const [duration, setDuration] = useState('10000');
  const [mode, setMode] = useState<FridaMode>('attach');
  const [script, setScript] = useState<File | null>(null);
  const [server, setServer] = useState<File | null>(null);
  const [output, setOutput] = useState<FridaOutput | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState<{ blob: Blob; filename: string } | null>(null);
  const download = useAction();
  const statusAvailable = useOperationAvailable(services, 'plugin.frida.server.status');
  const deployAvailable = useOperationAvailable(services, 'plugin.frida.server.deploy');
  const processesAvailable = useOperationAvailable(services, 'plugin.frida.processes');
  const runAvailable = useOperationAvailable(services, 'plugin.frida.server.run');
  const scriptAvailable = useOperationAvailable(services, 'plugin.frida.script.run');
  const permissionsAvailable = useOperationAvailable(services, 'plugin.frida.permissions.analyze');
  const provider = device.providers.find(
    (entry) =>
      entry.id === device.selection?.providerId && entry.generation === device.selection.generation,
  );
  const supportsTarget =
    provider?.definition.discoverOperation.startsWith('plugin.android-device.') ||
    provider?.definition.capabilities.some((entry) =>
      entry.operation.startsWith('plugin.android-device.'),
    );
  const ready = Boolean(device.selection && device.selected?.state === 'online' && supportsTarget);
  const run = <T extends FridaView>(
    operation: (id: string, signal: AbortSignal) => Promise<JobOutcome<PublishedResult<T>>>,
  ) =>
    action.run(async (signal) => {
      const result = await withSelectedDevice(services, signal, async (reference, active) => {
        const source = services.devices
          .snapshot()
          .providers.find(
            (entry) =>
              entry.id === reference.providerId && entry.generation === reference.generation,
          );
        if (
          !source?.definition.discoverOperation.startsWith('plugin.android-device.') &&
          !source?.definition.capabilities.some((entry) =>
            entry.operation.startsWith('plugin.android-device.'),
          )
        )
          throw new Error('此 Frida 插件只支持声明 Android 设备操作的提供者');
        await services.frida.refreshOperations(active);
        return { reference, outcome: await operation(reference.localId, active) };
      });
      if (!signal.aborted) {
        download.cancel();
        setOutput(result);
        setLog(null);
        setDownloaded(null);
      }
      return result.outcome;
    });
  return (
    <div hidden={!visible} inert={!visible} className="@container/frida-page h-full min-h-0 min-w-0 w-full overflow-hidden">
    <section className="@container/frida mx-auto flex h-full min-h-0 min-w-0 w-full max-w-[1648px] flex-1 flex-col overflow-y-auto overscroll-contain px-6 pb-7 pt-[22px] text-[15px] @max-[900px]/frida-page:px-4 @max-[900px]/frida-page:pb-6 @max-[900px]/frida-page:pt-4" data-product-page="frida">
      <PageTitle
        eyebrow="深度调试"
        title="Frida"
        description="检查服务器状态、进程与脚本输出。部署和注入需要设备及服务端相应权限。"
      >
        <Button
          variant="outline"
          disabled={!ready || !statusAvailable || action.pending}
          onClick={() => void run((target, signal) => services.frida.status(target, signal))}
        >
          <RefreshCw />
          检查状态
        </Button>
      </PageTitle>
      {!ready && (
        <EmptyState
          title="请选择支持 Frida 的在线设备"
          description="注入与部署需要相应设备权限。"
        />
      )}
      <div className="grid min-h-0 min-w-0 shrink-0 items-start gap-x-8 gap-y-6 @min-[900px]/frida:grid-cols-[minmax(16.25rem,18.75rem)_minmax(0,1fr)]">
      <aside className="min-w-0 border-b border-border pb-6 @min-[900px]/frida:border-r @min-[900px]/frida:border-b-0 @min-[900px]/frida:pb-0 @min-[900px]/frida:pr-7" aria-label="Frida 执行配置">
      <h2 className="text-base font-semibold">脚本与目标</h2>
      <div className="my-4 grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(12.5rem,100%),1fr))] items-start gap-4 @min-[900px]/frida:grid-cols-1">
        <Field label="应用包名" value={packageId} onChange={setPackageId} />
        <Field
          label="执行时长（毫秒）"
          value={duration}
          type="number"
          onChange={setDuration}
          min={1000}
          max={120000}
        />
        <div className="flex min-w-0 flex-col gap-[7px]">
        <Label htmlFor={modeId}>注入模式</Label>
        <Select
          open={visible && modeOpen}
          onOpenChange={(open) => setModeOpen(visibleRef.current && open)}
          value={mode}
          onValueChange={(value) => {
            if (!visibleRef.current) return;
            if (value === 'attach' || value === 'spawn') setMode(value);
          }}
        >
          <SelectTrigger id={modeId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent onCloseAutoFocus={(event) => { if (!visibleRef.current) event.preventDefault(); }}>
            <SelectItem value="attach">附加运行中的应用</SelectItem>
            <SelectItem value="spawn">启动并注入应用</SelectItem>
          </SelectContent>
        </Select>
        </div>
      </div>
      <details className="my-5 border-y border-border py-3 text-sm"><summary>服务器部署与进程</summary><div className="my-4 grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(12.5rem,100%),1fr))] items-start gap-4 @min-[900px]/frida:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-[7px]">
          <Label htmlFor={serverId}>Frida 服务器文件</Label>
          <Input
            id={serverId}
            type="file"
            onChange={(event) => setServer(event.target.files?.[0] ?? null)}
          />
        </div>
        <Button
          className={actionClass}
          variant="outline"
          disabled={!ready || !deployAvailable || !server || action.pending}
          onClick={() =>
            void run(async (target, signal) => {
              if (!server) throw new Error('请选择服务器文件');
              const upload = await services.frida.uploadServer(server, signal);
              return services.frida.deploy(target, upload.data.id, signal);
            })
          }
        >
          上传并部署
        </Button>
        <Button
          className={actionClass}
          variant="outline"
          disabled={!ready || !processesAvailable || action.pending}
          onClick={() => void run((target, signal) => services.frida.processes(target, signal))}
        >
          读取进程
        </Button>
        <Button
          className={actionClass}
          variant="outline"
          disabled={!ready || !runAvailable || action.pending}
          onClick={() =>
            void run((target, signal) => services.frida.runServer(target, Number(duration), signal))
          }
        >
          <Play />
          限时运行服务器
        </Button>
      </div></details>
      <div className="my-4 grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(12.5rem,100%),1fr))] items-start gap-4 @min-[900px]/frida:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-[7px]">
          <Label htmlFor={scriptId}>UTF-8 脚本</Label>
          <Input
            id={scriptId}
            type="file"
            accept=".js,text/javascript"
            onChange={(event) => setScript(event.target.files?.[0] ?? null)}
          />
        </div>
        <Button
          className={actionClass}
          disabled={!ready || !scriptAvailable || !script || !packageId || action.pending}
          onClick={() =>
            void run(async (target, signal) => {
              if (!script) throw new Error('请选择脚本');
              const upload = await services.frida.uploadScript(script, signal);
              return services.frida.runScript(
                target,
                {
                  script_artifact_id: upload.data.id,
                  package: packageId,
                  mode,
                  duration_ms: Number(duration),
                },
                signal,
              );
            })
          }
        >
          <FileCode2 />
          运行脚本
        </Button>
        <Button
          className={actionClass}
          variant="outline"
          disabled={!ready || !permissionsAvailable || !packageId || action.pending}
          onClick={() =>
            void run((target, signal) =>
              services.frida.analyzePermissions(
                target,
                { package: packageId, mode, duration_ms: Number(duration), show_log: true },
                signal,
              ),
            )
          }
        >
          分析权限调用
        </Button>
      </div>
      <ActionFeedback {...action} />
      </aside>
      <div className="@container/frida-result min-h-60 min-w-0 space-y-3 @min-[900px]/frida:min-h-[440px]" aria-label="Frida 执行输出">
      {output ? (
        <section>
          <h2 className="text-[17px] font-semibold">执行结果</h2>
          <p className="mb-5 mt-2 break-all text-xs text-muted-foreground">来源 {output.reference.localId} · 任务 {output.outcome.job.id}</p>
          {JSON.stringify(output.reference) !== JSON.stringify(device.selection) && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">以下属于先前设备的历史结果，不是当前设备状态。</p>
          )}
          <FridaResultView result={output.outcome.data.result} />
          <div className="my-5 flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={download.pending}
              onClick={() => {
                void download.run(async (signal) => {
                  const result = await services.frida.download(
                    output.outcome.data,
                    'frida.log',
                    signal,
                  );
                  const text = await result.data.text();
                  if (!signal.aborted) setLog(text.slice(0, 512 * 1024));
                  return result;
                });
              }}
            >
              读取运行日志
            </Button>
            {output.outcome.data.artifacts.map((artifact) => (
              <Button
                key={artifact.id}
                variant="ghost"
                disabled={download.pending}
                onClick={() => {
                  void download.run(async (signal) => {
                    const result = await services.frida.download(
                      output.outcome.data,
                      artifact.filename,
                      signal,
                    );
                    if (!signal.aborted)
                      setDownloaded({ blob: result.data, filename: artifact.filename });
                    return result;
                  });
                }}
              >
                <Download />
                {artifact.filename}
              </Button>
            ))}
          </div>
          <ActionFeedback {...download} />
          {downloaded && <BlobDownload {...downloaded} label={`保存 ${downloaded.filename}`} />}
          {log !== null && (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 font-mono text-xs">
              {log || '运行日志为空'}
              {log.length === 512 * 1024 ? '\n预览最多显示 512 KiB；完整内容请下载。' : ''}
            </pre>
          )}
          <JsonResult value={output.outcome} />
        </section>
      ) : <div className="mb-2 pb-6 text-left"><h3 className="mb-2 text-[15px] font-semibold">尚无执行结果</h3><p className="max-w-[490px] text-sm text-muted-foreground">选择脚本并运行，输出会显示在这里。</p></div>}
      </div>
      </div>
    </section>
    </div>
  );
}

export function mountFrida(target: HTMLElement, context: HostContext, instance?: WorkspaceViewContext) {
  const services = createFridaServices(context);
  try {
    const release = hostUi().mountReact(target, <FridaPage services={services} {...(instance ? { instance } : {})} />);
    return async () => { try { await release(); } finally { services.dispose(); } };
  } catch (error) { services.dispose(); throw error; }
}

function FridaResultView({ result }: { result: FridaView }) {
  if ('installed' in result)
    return (
      <dl className={metadataClass}>
        <dt>服务器文件</dt>
        <dd>{result.installed ? '已部署' : '未部署'}</dd>
        <dt>当前观测</dt>
        <dd>{result.running ? `发现进程 ${result.pids.join('、')}` : '没有发现运行进程'}</dd>
        <dt>版本输出</dt>
        <dd className="font-mono text-xs">{result.version_output || '没有版本输出'}</dd>
        <dt>所有权</dt>
        <dd>只读观测，不宣称由本次调用创建或持有</dd>
      </dl>
    );
  if ('processes' in result)
    return (
      <>
        <h2 className="text-[17px] font-semibold">设备进程 · {result.processes.length}</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>PID</TableHead>
              <TableHead>进程名称</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.processes.slice(0, 1000).map((process) => (
              <TableRow key={`${process.pid}:${process.name}`}>
                <TableCell className="font-mono text-xs">{process.pid}</TableCell>
                <TableCell>{process.name}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {result.processes.length > 1000 && (
          <p className="text-xs text-muted-foreground">先展示 1000 项；完整进程数据可下载产物查看。</p>
        )}
      </>
    );
  if ('deployed' in result)
    return (
      <>
        <h2 className="text-[17px] font-semibold">服务器部署完成</h2>
        <p className="text-xs text-muted-foreground">部署要求 Root；版本回执：</p>
        <pre className="my-3 min-w-0 max-w-full max-h-[360px] overflow-auto rounded-[4px] bg-muted px-4 py-[14px] font-[Consolas,monospace] text-[13px] leading-[1.65]">{result.version_output}</pre>
      </>
    );
  if ('process_start_ticks' in result)
    return (
      <dl className={metadataClass}>
        <dt>本次服务器进程</dt>
        <dd>
          PID {result.pid} · 创建标识 {result.process_start_ticks}
        </dd>
        <dt>实际限时</dt>
        <dd>{result.duration_ms} 毫秒</dd>
        <dt>资源清理</dt>
        <dd>已确认本次调用持有的进程清理</dd>
      </dl>
    );
  return (
    <>
      <dl className={metadataClass}>
        <dt>脚本目标</dt>
        <dd>
          {result.package} · {result.mode === 'attach' ? '附加进程' : '启动进程'}
        </dd>
        <dt>执行资格</dt>
        <dd>脚本已装载 · 请求 {result.duration_requested_ms} 毫秒</dd>
        <dt>实际通知</dt>
        <dd>{result.notice_count} 条</dd>
        <dt>清理范围</dt>
        <dd>已确认直接 CLI 结束；不宣称目标应用进程已退出</dd>
      </dl>
      {result.hook_summary.length > 0 && (
        <details open>
          <summary>钩子执行摘要</summary>
          <pre className="my-3 min-w-0 max-w-full max-h-[360px] overflow-auto rounded-[4px] bg-muted px-4 py-[14px] font-[Consolas,monospace] text-[13px] leading-[1.65]">{JSON.stringify(result.hook_summary, null, 2)}</pre>
        </details>
      )}
    </>
  );
}
