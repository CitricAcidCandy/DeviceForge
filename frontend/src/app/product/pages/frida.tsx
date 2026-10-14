import { useState } from 'react';
import { Button } from '../../../components/ui/button.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select.tsx';
import { Input } from '../../../components/ui/input.tsx';
import { Label } from '../../../components/ui/label.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table.tsx';
import { RefreshCw, Download, FileCode2, Play } from 'lucide-react';
import { Field, PageTitle, EmptyState, JsonResult } from '../../../components/common/index.ts';
import { useOperationAvailable } from '../capabilities.tsx';
import { ActionFeedback } from '../feedback.tsx';
import { useAction, useSnapshot } from '../hooks.ts';
import type { ProductServices } from '../services.ts';
import type { FridaDeployment, FridaMode, FridaProcesses, FridaScriptResult, FridaServerRun, FridaStatus } from '../../../features/frida/index.ts';
import type { JobOutcome, PublishedResult } from '../../../shared/jobs/index.ts';
import type { DeviceRef } from '../../../plugin-sdk/index.ts';
import { withSelectedDevice } from '../device-target.ts';
import { BlobDownload } from './profile-view.tsx';

type FridaView = FridaDeployment | FridaProcesses | FridaScriptResult | FridaServerRun | FridaStatus;
interface FridaOutput { readonly reference: DeviceRef; readonly outcome: JobOutcome<PublishedResult<FridaView>> }

export function FridaPage({services}: {services: ProductServices}) {
  const device = useSnapshot(services.runtime.devices);
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
  const provider = device.providers.find((entry) => entry.id === device.selection?.providerId && entry.generation === device.selection.generation);
  const supportsTarget = provider?.definition.discoverOperation.startsWith('plugin.android-device.') || provider?.definition.capabilities.some((entry) => entry.operation.startsWith('plugin.android-device.'));
  const ready = Boolean(device.selection && device.selected?.state === 'online' && supportsTarget);
  const run = <T extends FridaView,>(operation: (id: string, signal: AbortSignal) => Promise<JobOutcome<PublishedResult<T>>>) => action.run(async signal => {
    const result = await withSelectedDevice(services, signal, async (reference, active) => {
      const source = services.runtime.devices.snapshot().providers.find((entry) => entry.id === reference.providerId && entry.generation === reference.generation);
      if (!source?.definition.discoverOperation.startsWith('plugin.android-device.') && !source?.definition.capabilities.some((entry) => entry.operation.startsWith('plugin.android-device.'))) throw new Error('此 Frida 插件只支持声明 Android 设备操作的提供者');
      await services.frida.refreshOperations(active);
      return { reference, outcome: await operation(reference.localId, active) };
    });
    if (!signal.aborted) { download.cancel(); setOutput(result); setLog(null); setDownloaded(null); }
    return result.outcome;
  });
  return <section className="product-page"><PageTitle eyebrow="深度调试" title="Frida" description="检查服务器状态、进程与脚本输出。部署和注入需要设备及服务端相应权限。"><Button variant="outline" disabled={!ready || !statusAvailable || action.pending} onClick={() => void run((target, signal) => services.frida.status(target, signal))}><RefreshCw />检查状态</Button></PageTitle>
    {!ready && <EmptyState title="等待支持 Frida 的在线设备" description="选择声明 Android 设备操作的在线提供者。在线不等于已获得 Root 或注入权限；每项操作还需对应插件贡献。" />}
    <div className="form-row"><Field label="应用包名" value={packageId} onChange={setPackageId} /><Field label="执行时长（毫秒）" value={duration} type="number" onChange={setDuration} min={1000} max={120000} /><Select value={mode} onValueChange={value => { if (value === 'attach' || value === 'spawn') setMode(value); }}><SelectTrigger aria-label="注入模式"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="attach">附加运行中的应用</SelectItem><SelectItem value="spawn">启动并注入应用</SelectItem></SelectContent></Select></div>
    <div className="form-row"><div className="form-field"><Label htmlFor="frida-server-file">Frida 服务器文件</Label><Input id="frida-server-file" type="file" onChange={event => setServer(event.target.files?.[0] ?? null)} /></div><Button variant="outline" disabled={!ready || !deployAvailable || !server || action.pending} onClick={() => void run(async (target, signal) => { if (!server) throw new Error('请选择服务器文件'); const upload = await services.frida.uploadServer(server, signal); return services.frida.deploy(target, upload.data.id, signal); })}>上传并部署</Button><Button variant="outline" disabled={!ready || !processesAvailable || action.pending} onClick={() => void run((target, signal) => services.frida.processes(target, signal))}>读取进程</Button><Button variant="outline" disabled={!ready || !runAvailable || action.pending} onClick={() => void run((target, signal) => services.frida.runServer(target, Number(duration), signal))}><Play />限时运行服务器</Button></div>
    <div className="form-row"><div className="form-field"><Label htmlFor="frida-script-file">UTF-8 脚本</Label><Input id="frida-script-file" type="file" accept=".js,text/javascript" onChange={event => setScript(event.target.files?.[0] ?? null)} /></div><Button disabled={!ready || !scriptAvailable || !script || !packageId || action.pending} onClick={() => void run(async (target, signal) => { if (!script) throw new Error('请选择脚本'); const upload = await services.frida.uploadScript(script, signal); return services.frida.runScript(target, {script_artifact_id: upload.data.id, package: packageId, mode, duration_ms: Number(duration)}, signal); })}><FileCode2 />运行脚本</Button><Button variant="outline" disabled={!ready || !permissionsAvailable || !packageId || action.pending} onClick={() => void run((target, signal) => services.frida.analyzePermissions(target, {package: packageId, mode, duration_ms: Number(duration), show_log: true}, signal))}>分析权限调用</Button></div>
    <ActionFeedback {...action} />
    {output && <section className="workspace-section"><PageTitle title="本次执行结果" description={`来源设备 ${output.reference.localId} · 任务 ${output.outcome.job.id}`} />{JSON.stringify(output.reference) !== JSON.stringify(device.selection) && <p className="capability-notice">以下属于先前设备的历史结果，不是当前设备状态。</p>}<FridaResultView result={output.outcome.data.result} />
      <div className="action-row"><Button variant="outline" disabled={download.pending} onClick={() => { void download.run(async signal => { const result = await services.frida.download(output.outcome.data, 'frida.log', signal); const text = await result.data.text(); if (!signal.aborted) setLog(text.slice(0, 512 * 1024)); return result; }); }}>读取运行日志</Button>{output.outcome.data.artifacts.map(artifact => <Button key={artifact.id} variant="ghost" disabled={download.pending} onClick={() => { void download.run(async signal => { const result = await services.frida.download(output.outcome.data, artifact.filename, signal); if (!signal.aborted) setDownloaded({ blob: result.data, filename: artifact.filename }); return result; }); }}><Download />{artifact.filename}</Button>)}</div><ActionFeedback {...download} />{downloaded && <BlobDownload {...downloaded} label={`保存 ${downloaded.filename}`} />}{log !== null && <pre className="terminal-output">{log || '运行日志为空'}{log.length === 512 * 1024 ? '\n预览最多显示 512 KiB；完整内容请下载。' : ''}</pre>}<JsonResult value={output.outcome} />
    </section>}
  </section>;
}

function FridaResultView({ result }: { result: FridaView }) {
  if ('installed' in result) return <dl className="metadata-grid"><dt>服务器文件</dt><dd>{result.installed ? '已部署' : '未部署'}</dd><dt>当前观测</dt><dd>{result.running ? `发现进程 ${result.pids.join('、')}` : '没有发现运行进程'}</dd><dt>版本输出</dt><dd className="mono">{result.version_output || '没有版本输出'}</dd><dt>所有权</dt><dd>只读观测，不宣称由本次调用创建或持有</dd></dl>;
  if ('processes' in result) return <><h2>设备进程 · {result.processes.length}</h2><Table><TableHeader><TableRow><TableHead>PID</TableHead><TableHead>进程名称</TableHead></TableRow></TableHeader><TableBody>{result.processes.slice(0, 1000).map(process => <TableRow key={`${process.pid}:${process.name}`}><TableCell className="mono">{process.pid}</TableCell><TableCell>{process.name}</TableCell></TableRow>)}</TableBody></Table>{result.processes.length > 1000 && <p className="muted">先展示 1000 项；完整进程数据可下载产物查看。</p>}</>;
  if ('deployed' in result) return <><h2>服务器部署完成</h2><p className="muted">部署要求 Root；版本回执：</p><pre>{result.version_output}</pre></>;
  if ('process_start_ticks' in result) return <dl className="metadata-grid"><dt>本次服务器进程</dt><dd>PID {result.pid} · 创建标识 {result.process_start_ticks}</dd><dt>实际限时</dt><dd>{result.duration_ms} 毫秒</dd><dt>资源清理</dt><dd>已确认本次调用持有的进程清理</dd></dl>;
  return <><dl className="metadata-grid"><dt>脚本目标</dt><dd>{result.package} · {result.mode === 'attach' ? '附加进程' : '启动进程'}</dd><dt>执行资格</dt><dd>脚本已装载 · 请求 {result.duration_requested_ms} 毫秒</dd><dt>实际通知</dt><dd>{result.notice_count} 条</dd><dt>清理范围</dt><dd>已确认直接 CLI 结束；不宣称目标应用进程已退出</dd></dl>{result.hook_summary.length > 0 && <details open><summary>钩子执行摘要</summary><pre>{JSON.stringify(result.hook_summary, null, 2)}</pre></details>}</>;
}
