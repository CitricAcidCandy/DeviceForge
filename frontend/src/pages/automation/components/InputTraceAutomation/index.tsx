import { useState } from 'react';
import { Button } from '../../../../components/Button/index.tsx';
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
import { Field, JsonResult } from '../../../../components/index.ts';
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
    <section className="workspace-section">
      <h2>服务器输入轨迹</h2>
      <p className="muted">
        录制服务器电脑的输入事件，或以公开产物 ID 回放。回放会向服务器电脑派发真实输入，格式为
        input_trace.msgpack.v1。
      </p>
      <div className="form-row">
        <Select
          value={String(events)}
          onValueChange={(value) => {
            if (value === '0' || value === '1' || value === '2')
              setEvents(Number(value) === 0 ? 0 : Number(value) === 1 ? 1 : 2);
          }}
        >
          <SelectTrigger aria-label="轨迹事件类型">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="0">全部输入</SelectItem>
            <SelectItem value="1">键盘输入</SelectItem>
            <SelectItem value="2">鼠标输入</SelectItem>
          </SelectContent>
        </Select>
        <Field
          label="轨迹采样间隔（毫秒）"
          value={interval}
          onChange={setInterval}
          type="number"
          min={2}
          max={1000}
        />
        <Field
          label="轨迹录制时长（毫秒）"
          value={duration}
          onChange={setDuration}
          type="number"
          min={100}
          max={600000}
        />
        <Button
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
          开始录制轨迹
        </Button>
      </div>
      <div className="form-row">
        <Field
          label="回放轨迹产物 ID"
          value={artifact}
          onChange={setArtifact}
          hint="录制成功后自动填入 recording.msgpack 的公开产物 ID"
        />
        <Button
          variant="outline"
          disabled={!canPlayback || !artifact.trim() || action.pending}
          onClick={() =>
            setCommand({
              kind: 'playback',
              input: { artifact_id: artifact.trim(), event_type: events },
            })
          }
        >
          回放输入轨迹
        </Button>
      </div>
      <ActionFeedback {...action} />
      {output && (
        <>
          <h3>{'recorded' in output.data.result ? '录制回执' : '回放回执'}</h3>
          <dl className="metadata-grid">
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
            <dd>{output.data.result.format}</dd>
          </dl>
          <p className="capability-notice">界面效果尚未确认。任务 ID：{output.job.id}</p>
          <div className="action-row">
            {artifactNames
              .filter((filename) =>
                output.data.artifacts.some((item) => item.filename === filename),
              )
              .map((filename) => (
                <Button
                  key={filename}
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
            <pre className="terminal-output">
              {log || '轨迹日志为空'}
              {log.length === 512 * 1024 ? '\n预览最多显示 512 KiB；完整内容请下载。' : ''}
            </pre>
          )}
          <JsonResult value={output} />
        </>
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
