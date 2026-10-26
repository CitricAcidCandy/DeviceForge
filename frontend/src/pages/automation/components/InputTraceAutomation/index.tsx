import { useState } from 'react';
import { Mic, Monitor, Play } from 'lucide-react';
import { Button } from '../../../../components/Button/index.tsx';
import { Label } from '../../../../components/Label/index.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../components/Select/index.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../../components/Dialog/index.tsx';
import { JsonResult } from '../../../../components/index.ts';
import { AutomationField as Field } from '../../field.tsx';
import { useOperationAvailable } from '../../../../app/product/capabilities.tsx';
import { ActionFeedback } from '../../../../app/product/feedback.tsx';
import { useAction } from '../../../../app/product/hooks.ts';
import type { ProductServices } from '../../../../app/product/services.ts';
import type {
  InputTracePlayback,
  InputTracePlayed,
  InputTraceRecord,
  InputTraceRecorded,
} from '../../../../features/automation/index.ts';
import type { JobOutcome, PublishedResult } from '../../../../shared/jobs/index.ts';
import { BlobDownload } from '../../../../components/BlobDownload/index.tsx';

type TraceView = InputTraceRecorded | InputTracePlayed;
type TraceCommand =
  | { kind: 'record'; input: InputTraceRecord }
  | { kind: 'playback'; input: InputTracePlayback };
const eventLabels = { 0: '全部输入', 1: '键盘输入', 2: '鼠标输入' };
const artifactNames = ['recording.msgpack', 'operation.json', 'input-trace.log'] as const;

export function InputTraceAutomation({ services }: { services: ProductServices }) {
  const action = useAction();
  const download = useAction();
  const [events, setEvents] = useState<InputTraceRecord['event_type']>(0);
  const [interval, setInterval] = useState('10');
  const [duration, setDuration] = useState('10000');
  const [artifact, setArtifact] = useState('');
  const [command, setCommand] = useState<TraceCommand | null>(null);
  const [output, setOutput] = useState<JobOutcome<PublishedResult<TraceView>> | null>(null);
  const [downloaded, setDownloaded] = useState<{ blob: Blob; filename: string } | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const canRecord = useOperationAvailable(services, 'plugin.automation.input_trace.record');
  const canPlayback = useOperationAvailable(services, 'plugin.automation.input_trace.playback');
  const run = <T extends TraceView>(
    operation: (signal: AbortSignal) => Promise<JobOutcome<PublishedResult<T>>>,
  ) =>
    action.run(async (signal) => {
      await services.automation.refreshOperations(signal);
      const result = await operation(signal);
      if (!signal.aborted) {
        download.cancel();
        setOutput(result);
        setDownloaded(null);
        setLog(null);
        const recording = result.data.artifacts.find(
          (item) => item.filename === 'recording.msgpack',
        );
        if (recording) setArtifact(recording.id);
      }
      return result;
    });
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <Monitor className="size-4" aria-hidden="true" />
          作用于运行服务器的电脑
        </span>
        <span className="font-mono">input_trace.msgpack.v1</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="hidden size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-primary sm:flex">
              <Mic className="size-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold">输入录制与回放</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                录制服务器输入事件，或以公开产物 ID 回放
              </p>
            </div>
          </div>
          {action.pending && (
            <Button size="sm" variant="outline" onClick={action.cancel}>
              取消等待
            </Button>
          )}
        </header>
        <div className="grid min-h-0 min-w-0 flex-1 auto-rows-min xl:grid-cols-[minmax(16rem,0.9fr)_minmax(0,1.6fr)]">
          <div className="min-w-0 border-b border-border bg-surface-elevated p-5 sm:p-7 xl:border-r xl:border-b-0">
            <h3 className="flex items-center gap-3 text-base font-semibold">
              <span className="flex size-10 items-center justify-center rounded-lg bg-accent text-primary">
                <Mic className="size-5" aria-hidden="true" />
              </span>
              录制
            </h3>
            <div className="mt-6 grid gap-4">
              <div className="grid min-w-0 gap-2">
                <Label htmlFor="trace-events" className="text-xs text-muted-foreground">
                  事件范围
                </Label>
                <Select
                  value={String(events)}
                  onValueChange={(value) => {
                    if (value === '0' || value === '1' || value === '2')
                      setEvents(Number(value) === 0 ? 0 : Number(value) === 1 ? 1 : 2);
                  }}
                >
                  <SelectTrigger id="trace-events" className="w-full" aria-label="轨迹事件类型">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">全部输入</SelectItem>
                    <SelectItem value="1">键盘输入</SelectItem>
                    <SelectItem value="2">鼠标输入</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="采样间隔（ms）"
                  value={interval}
                  onChange={setInterval}
                  type="number"
                  min={2}
                  max={1000}
                />
                <Field
                  label="录制时长（ms）"
                  value={duration}
                  onChange={setDuration}
                  type="number"
                  min={100}
                  max={600000}
                />
              </div>
            </div>
            <Button
              className="mt-6 w-full"
              variant="outline"
              disabled={!canRecord || action.pending}
              onClick={() =>
                setCommand({
                  kind: 'record',
                  input: {
                    event_type: events,
                    interval_ms: Number(interval),
                    duration_ms: Number(duration),
                  },
                })
              }
            >
              <Mic aria-hidden="true" />开始录制轨迹
            </Button>
            <p className="mt-3 text-xs leading-relaxed text-faint">
              录制在服务器电脑执行，需手动完成要记录的操作。
            </p>
          </div>
          <div className="flex min-w-0 flex-col p-5 sm:px-8 sm:py-7">
            <h3 className="flex items-center gap-3 text-base font-semibold">
              <span className="flex size-10 items-center justify-center rounded-lg bg-accent text-primary">
                <Play className="size-5" aria-hidden="true" />
              </span>
              回放
            </h3>
            <div className="mt-6 grid gap-4">
              <Field
                label="回放轨迹产物 ID"
                value={artifact}
                onChange={setArtifact}
                hint="录制成功后自动填入 recording.msgpack 的公开产物 ID"
              />
              <p className="text-xs text-muted-foreground">
                事件范围沿用左侧：{eventLabels[events]}
              </p>
            </div>
            <Button
              className="mt-6 self-start"
              variant="outline"
              disabled={!canPlayback || !artifact.trim() || action.pending}
              onClick={() =>
                setCommand({
                  kind: 'playback',
                  input: { artifact_id: artifact.trim(), event_type: events },
                })
              }
            >
              <Play aria-hidden="true" />回放输入轨迹
            </Button>
            <p className="mt-3 text-xs leading-relaxed text-faint">
              回放会向服务器电脑派发真实输入，执行前确认目标窗口。
            </p>
            <div className="mt-auto pt-6">
              <ActionFeedback {...action} />
            </div>
          </div>
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3 text-xs text-faint sm:px-6">
          <span>回执确认输入派发，界面效果需另行观察。</span>
          <span>{action.pending ? '正在执行' : output ? '已有执行回执' : '尚无本次执行回执'}</span>
        </footer>
      </div>
      {output && (
        <section className="min-w-0 rounded-lg border border-border bg-card p-5">
          <h3 className="mb-3 text-sm font-semibold">
            {'recorded' in output.data.result ? '录制回执' : '回放回执'}
          </h3>
          <dl className="my-3 grid gap-x-5 gap-y-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)] [&>dt]:text-muted-foreground [&>dd]:min-w-0 [&>dd]:break-words">
            <dt>事件范围</dt>
            <dd>{eventLabels[output.data.result.event_type]}</dd>
            <dt>事件数量</dt>
            <dd>{output.data.result.events}</dd>
            {'recorded' in output.data.result && (
              <>
                <dt>录制时长</dt>
                <dd>{output.data.result.duration_ms} 毫秒</dd>
                <dt>结束方式</dt>
                <dd>标准输入退出指令</dd>
              </>
            )}
            <dt>轨迹格式</dt>
            <dd className="font-mono text-xs">{output.data.result.format}</dd>
          </dl>
          <p className="break-all text-xs text-muted-foreground">任务 ID：{output.job.id}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {artifactNames
              .filter((filename) =>
                output.data.artifacts.some((item) => item.filename === filename),
              )
              .map((filename) => (
                <Button
                  key={filename}
                  size="sm"
                  variant="outline"
                  disabled={download.pending}
                  onClick={() => {
                    void download.run(async (signal) => {
                      const result = await services.automation.downloadTrace(
                        output.data,
                        filename,
                        signal,
                      );
                      if (!signal.aborted) setDownloaded({ blob: result.data, filename });
                      return result;
                    });
                  }}
                >
                  下载 {filename}
                </Button>
              ))}
            <Button
              size="sm"
              variant="ghost"
              disabled={download.pending}
              onClick={() => {
                void download.run(async (signal) => {
                  const result = await services.automation.downloadTrace(
                    output.data,
                    'input-trace.log',
                    signal,
                  );
                  const text = await result.data.text();
                  if (!signal.aborted) setLog(text.slice(0, 512 * 1024));
                  return result;
                });
              }}
            >
              读取轨迹日志
            </Button>
          </div>
          <ActionFeedback {...download} />
          {downloaded && <BlobDownload {...downloaded} label={`保存 ${downloaded.filename}`} />}
          {log !== null && (
            <pre className="mt-4 max-h-64 overflow-auto rounded-lg border border-border bg-surface-elevated p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {log || '轨迹日志为空'}
              {log.length === 512 * 1024 ? '\n预览最多显示 512 KiB；完整内容请下载。' : ''}
            </pre>
          )}
          <JsonResult value={output} />
        </section>
      )}
      <Dialog
        open={command !== null}
        onOpenChange={(open) => {
          if (!open) setCommand(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {command?.kind === 'record' ? '录制服务器输入轨迹' : '回放到服务器桌面'}
            </DialogTitle>
            <DialogDescription>
              {command?.kind === 'record'
                ? '确认录制范围和时长，然后在服务器电脑执行需要记录的操作。'
                : '确认服务器电脑及当前前台窗口是回放目标，轨迹中的输入将在此电脑执行。'}
            </DialogDescription>
          </DialogHeader>
          {command && (
            <p>
              {eventLabels[command.input.event_type]} ·{' '}
              {command.kind === 'record'
                ? `录制 ${command.input.duration_ms} 毫秒，间隔 ${command.input.interval_ms} 毫秒`
                : `产物 ${command.input.artifact_id}`}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCommand(null)}>
              返回修改
            </Button>
            <Button
              disabled={
                action.pending ||
                !command ||
                (command.kind === 'record' ? !canRecord : !canPlayback)
              }
              onClick={() => {
                const selected = command;
                if (!selected) return;
                setCommand(null);
                if (selected.kind === 'record')
                  void run((signal) =>
                    services.automation.recordInputTrace(selected.input, signal),
                  );
                else
                  void run((signal) =>
                    services.automation.playbackInputTrace(selected.input, signal),
                  );
              }}
            >
              确认执行
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
