import { useState } from 'react';
import { ArrowRight, Keyboard, MousePointer2, Play, Plus, Repeat2, Smartphone, Type, X } from 'lucide-react';
import { Button } from '../../../../components/Button/index.tsx';
import { JsonResult } from '../../../../components/index.ts';
import { AutomationField as Field } from '../../field.tsx';
import { useOperationAvailable } from '../../../../app/product/capabilities.tsx';
import { ActionFeedback, ErrorNotice } from '../../../../app/product/feedback.tsx';
import { useAction, useSnapshot } from '../../../../app/product/hooks.ts';
import { withSelectedDevice } from '../../../../app/product/device-target.ts';
import type { ProductServices } from '../../../../app/product/services.ts';
import type {
  AutomationAction,
  AutomationResult,
  AutomationSequence,
} from '../../../../features/automation/index.ts';
import type { JobOutcome } from '../../../../shared/jobs/index.ts';
import type { DeviceRef } from '../../../../plugin-sdk/index.ts';

const actionTypes = [
  { kind: 'tap', label: '点击', icon: MousePointer2 },
  { kind: 'swipe', label: '滑动', icon: ArrowRight },
  { kind: 'key', label: '按键', icon: Keyboard },
  { kind: 'text', label: '文本', icon: Type },
] as const;

function stepDescription(action: AutomationAction): string {
  if (action.kind === 'tap') return `X ${action.x} · Y ${action.y}`;
  if (action.kind === 'swipe')
    return `${action.x1}, ${action.y1} → ${action.x2}, ${action.y2} · ${action.duration_ms} ms`;
  if (action.kind === 'key') return `按键码 ${action.code}`;
  return action.text;
}

export function DeviceAutomation({ services }: { services: ProductServices }) {
  const snapshot = useSnapshot(services.runtime.devices);
  const action = useAction();
  const [steps, setSteps] = useState<AutomationSequence['steps']>([]);
  const [kind, setKind] = useState<AutomationAction['kind']>('tap');
  const [x, setX] = useState('100');
  const [y, setY] = useState('100');
  const [x2, setX2] = useState('300');
  const [y2, setY2] = useState('300');
  const [key, setKey] = useState('4');
  const [duration, setDuration] = useState('300');
  const [text, setText] = useState('');
  const [at, setAt] = useState('0');
  const [count, setCount] = useState('5');
  const [interval, setInterval] = useState('500');
  const [stepError, setStepError] = useState<Error | null>(null);
  const [output, setOutput] = useState<{
    reference: DeviceRef;
    outcome: JobOutcome<AutomationResult>;
  } | null>(null);
  const sequenceAvailable = useOperationAvailable(services, 'plugin.automation.sequence.run');
  const repeatAvailable = useOperationAvailable(services, 'plugin.automation.click.repeat');
  const provider = snapshot.providers.find(
    (entry) =>
      entry.id === snapshot.selection?.providerId &&
      entry.generation === snapshot.selection.generation,
  );
  const supported =
    provider?.definition.discoverOperation.startsWith('plugin.android-device.') ||
    provider?.definition.capabilities.some((entry) =>
      entry.operation.startsWith('plugin.android-device.'),
    );
  const ready = Boolean(snapshot.selection && snapshot.selected?.state === 'online' && supported);
  const run = (
    operation: (device: string, signal: AbortSignal) => Promise<JobOutcome<AutomationResult>>,
  ) =>
    action.run(async (signal) => {
      const result = await withSelectedDevice(services, signal, async (reference, active) => {
        const source = services.runtime.devices
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
          throw new Error('此设备自动化只支持声明 Android 设备操作的提供者');
        await services.automation.refreshOperations(active);
        return { reference, outcome: await operation(reference.localId, active) };
      });
      if (!signal.aborted) setOutput(result);
      return result.outcome;
    });
  function addStep() {
    try {
      const integer = (value: string, minimum: number, maximum: number) => {
        const number = Number(value);
        if (!value.trim() || !Number.isInteger(number) || number < minimum || number > maximum)
          throw new Error(`请输入 ${minimum} 至 ${maximum} 范围内的整数`);
        return number;
      };
      const time = integer(at, steps.at(-1)?.at_ms ?? 0, 3600000);
      if (steps.length >= 10000) throw new Error('单个流程最多 10000 步');
      if (kind === 'text' && (text.length > 1024 || !/^[A-Za-z0-9 .,_@-]+$/.test(text)))
        throw new Error(
          '设备文本限 1024 个 ASCII 字母、数字、空格及 . , _ @ -；此接口不支持中文输入',
        );
      const next: AutomationAction =
        kind === 'text'
          ? { kind, text }
          : kind === 'key'
            ? { kind, code: integer(key, 0, 288) }
            : kind === 'swipe'
              ? {
                  kind,
                  x1: integer(x, 0, 65535),
                  y1: integer(y, 0, 65535),
                  x2: integer(x2, 0, 65535),
                  y2: integer(y2, 0, 65535),
                  duration_ms: integer(duration, 1, 10000),
                }
              : { kind, x: integer(x, 0, 65535), y: integer(y, 0, 65535) };
      setSteps((previous) => [...previous, { at_ms: time, action: next }]);
      setStepError(null);
    } catch (error) {
      setStepError(error instanceof Error ? error : new Error('步骤内容无效'));
    }
  }
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="inline-flex min-w-0 items-center gap-2">
          <Smartphone className="size-4" aria-hidden="true" />
          <span className="truncate">{snapshot.selection?.localId ?? '未选择设备'}</span>
          <span className={ready ? 'text-success' : 'text-muted-foreground'}>
            {ready ? '设备就绪' : '等待支持输入的在线设备'}
          </span>
        </span>
        <span>设备像素坐标 · 按时间顺序执行</span>
      </div>
      <div className="grid min-w-0 overflow-hidden rounded-lg border border-border bg-card lg:grid-cols-[minmax(0,1fr)_19.75rem]">
        <div className="flex min-w-0 flex-col">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-6">
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold">设备流程</h2>
              <span className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">{steps.length} 步</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="hidden text-xs text-faint sm:inline">当前草稿</span>
              <Button
                size="sm"
                disabled={!ready || !sequenceAvailable || steps.length === 0 || action.pending}
                onClick={() =>
                  void run((device, signal) =>
                    services.automation.runSequence({ device_id: device, steps }, signal),
                  )
                }
              >
                <Play aria-hidden="true" />运行流程
              </Button>
              {action.pending && <Button size="sm" variant="outline" onClick={action.cancel}>取消等待</Button>}
            </div>
          </header>
          <div className="min-w-0 flex-1 px-5 py-4 sm:px-6">
            <div aria-hidden="true" className="grid grid-cols-[2rem_4.5rem_minmax(0,1fr)] gap-2 pb-2 text-[11px] text-faint sm:grid-cols-[2rem_5.5rem_minmax(0,1fr)]">
              <span>序号</span><span>执行时间</span><span>动作</span>
            </div>
            {steps.length === 0 ? (
              <div className="flex min-h-56 flex-col items-center justify-center gap-3 py-10 text-center">
                <div className="flex size-10 items-center justify-center rounded-lg bg-accent text-primary"><Plus className="size-5" aria-hidden="true" /></div>
                <p className="text-sm text-muted-foreground">添加第一个步骤</p>
                <p className="text-xs text-faint">点击、滑动、按键或输入文本</p>
              </div>
            ) : (
              <ol aria-label="设备流程步骤" className="m-0 list-none p-0">
                {steps.map((step, index) => {
                  const type = actionTypes.find((entry) => entry.kind === step.action.kind);
                  const Icon = type?.icon ?? MousePointer2;
                  return (
                    <li className="grid grid-cols-[2rem_4.5rem_minmax(0,1fr)_2rem] items-center gap-2 border-b border-border py-4 last:border-b-0 sm:grid-cols-[2rem_5.5rem_minmax(0,1fr)_2rem]" key={index}>
                      <span className="font-mono text-xs text-faint">{String(index + 1).padStart(2, '0')}</span>
                      <span className="font-mono text-xs text-muted-foreground">{step.at_ms} ms</span>
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="hidden size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-primary sm:flex"><Icon className="size-4" aria-hidden="true" /></span>
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{type?.label}</p>
                          <p className="mt-1 break-words font-mono text-xs text-muted-foreground">{stepDescription(step.action)}</p>
                        </div>
                      </div>
                      <Button variant="ghost" size="icon-sm" aria-label={`移除步骤 ${index + 1}`} disabled={action.pending}
                        onClick={() => setSteps((previous) => previous.filter((_, position) => position !== index))}>
                        <X className="size-4 text-faint" aria-hidden="true" />
                      </Button>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
          <div className="border-t border-border bg-surface-elevated px-5 py-5 sm:px-6">
            <div className="mb-4 flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-sm font-medium"><Repeat2 className="size-4 text-muted-foreground" aria-hidden="true" />重复点击</h3>
              <span className="text-xs text-faint">独立运行</span>
            </div>
            <div className="grid grid-cols-2 items-end gap-3 xl:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
              <Field label="重复点击 X" value={x} onChange={setX} type="number" min={0} max={65535} />
              <Field label="重复点击 Y" value={y} onChange={setY} type="number" min={0} max={65535} />
              <Field label="点击次数" value={count} onChange={setCount} type="number" min={1} max={10000} />
              <Field label="间隔（ms）" value={interval} onChange={setInterval} type="number" min={10} max={60000} />
              <Button className="col-span-2 justify-self-start xl:col-span-1" variant="outline" disabled={!ready || !repeatAvailable || action.pending}
                onClick={() => void run((device, signal) => services.automation.repeatClick({ device_id: device, x: Number(x), y: Number(y), count: Number(count), interval_ms: Number(interval) }, signal))}>
                重复点击
              </Button>
            </div>
          </div>
        </div>
        <aside className="flex min-w-0 flex-col border-t border-border bg-surface-elevated px-5 py-5 lg:border-t-0 lg:border-l">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-base font-semibold">添加步骤</h3>
            <span className="font-mono text-xs text-faint">{String(steps.length + 1).padStart(2, '0')}</span>
          </div>
          <div className="mt-5 mb-6 grid grid-cols-2 gap-2" role="group" aria-label="步骤类型">
            {actionTypes.map((entry) => (
              <Button key={entry.kind} variant="outline" aria-pressed={kind === entry.kind} disabled={action.pending}
                className={`justify-start ${kind === entry.kind ? 'border-primary bg-accent text-primary hover:bg-accent hover:text-primary' : 'text-muted-foreground'}`}
                onClick={() => setKind(entry.kind)}>
                <entry.icon className="size-4" aria-hidden="true" />{entry.label}
              </Button>
            ))}
          </div>
          <div className="grid gap-4">
            <Field label="执行时间（ms）" value={at} onChange={setAt} type="number" min={0} max={3600000} hint="相对流程开始，按非递减顺序添加" />
            {kind === 'text' ? (
              <Field label="设备输入文本" value={text} onChange={setText} hint="仅 ASCII 字母、数字、空格和 . , _ @ -" />
            ) : kind === 'key' ? (
              <Field label="按键码" value={key} onChange={setKey} type="number" min={0} max={288} />
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <Field label="X 坐标" value={x} onChange={setX} type="number" min={0} max={65535} />
                <Field label="Y 坐标" value={y} onChange={setY} type="number" min={0} max={65535} />
              </div>
            )}
            {kind === 'swipe' && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="终点 X" value={x2} onChange={setX2} type="number" min={0} max={65535} />
                  <Field label="终点 Y" value={y2} onChange={setY2} type="number" min={0} max={65535} />
                </div>
                <Field label="滑动持续（ms）" value={duration} onChange={setDuration} type="number" min={1} max={10000} />
              </>
            )}
            {(kind === 'tap' || kind === 'swipe') && <p className="text-xs text-faint">坐标使用设备像素。</p>}
          </div>
          <div className="mt-auto pt-7">
            <Button className="w-full" variant="outline" onClick={addStep} disabled={action.pending}><Plus aria-hidden="true" />添加到流程</Button>
          </div>
          <ErrorNotice error={stepError} />
        </aside>
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3 text-xs text-faint lg:col-span-2 sm:px-6">
          <span>回执确认输入派发，界面效果需另行观察。</span>
          <span>{action.pending ? '正在执行' : output ? '已有执行回执' : '尚无本次执行回执'}</span>
        </footer>
      </div>
      <ActionFeedback {...action} />
      {output && (
        <section className="min-w-0 rounded-lg border border-border bg-card p-5">
          <h3 className="mb-3 text-sm font-semibold">设备执行回执</h3>
          {JSON.stringify(output.reference) !== JSON.stringify(snapshot.selection) && <p className="mb-2 text-xs text-warning">以下属于先前设备的历史结果。</p>}
          <p className="text-sm">设备 {output.outcome.data.device_id} · 已派发 {output.outcome.data.dispatched} 次输入 · 派发流程已结束</p>
          <p className="mt-2 break-all text-xs text-muted-foreground">界面效果尚未确认。任务 ID：{output.outcome.job.id}</p>
          <JsonResult value={output.outcome} />
        </section>
      )}
    </section>
  );
}
