import { useState } from 'react';
import { Crosshair, Monitor, MousePointer2, Play } from 'lucide-react';
import { Button } from '../../../../components/Button/index.tsx';
import { Label } from '../../../../components/Label/index.tsx';
import { Switch } from '../../../../components/Switch/index.tsx';
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
  DesktopClick,
  DesktopClickResult,
  DesktopPositionResult,
  DesktopRepeat,
  DesktopRepeatLimit,
  DesktopRepeatResult,
} from '../../../../features/automation/index.ts';
import type { JobOutcome } from '../../../../shared/jobs/index.ts';

type DesktopView = DesktopPositionResult | DesktopClickResult | DesktopRepeatResult;
type DesktopCommand =
  | { kind: 'click'; input: DesktopClick }
  | { kind: 'repeat'; input: DesktopRepeat };
const buttons = { left: '左键', right: '右键', middle: '中键' };
const stopReasons = {
  count_limit: '达到次数上限',
  duration: '达到时长',
  manual_limit: '达到手动模式时限',
  f9: 'F9 停止',
};

export function DesktopAutomation({ services }: { services: ProductServices }) {
  const action = useAction();
  const [button, setButton] = useState<DesktopClick['button']>('left');
  const [click, setClick] = useState<DesktopClick['click']>('single');
  const [fixed, setFixed] = useState(false);
  const [x, setX] = useState('0');
  const [y, setY] = useState('0');
  const [interval, setInterval] = useState('500');
  const [limit, setLimit] = useState<DesktopRepeatLimit['kind']>('count');
  const [count, setCount] = useState('5');
  const [duration, setDuration] = useState('10000');
  const [f9, setF9] = useState(true);
  const [command, setCommand] = useState<DesktopCommand | null>(null);
  const [output, setOutput] = useState<JobOutcome<DesktopView> | null>(null);
  const [position, setPosition] = useState<DesktopPositionResult | null>(null);
  const canPosition = useOperationAvailable(services, 'plugin.automation.windows.mouse.position');
  const canClick = useOperationAvailable(services, 'plugin.automation.windows.mouse.click');
  const canRepeat = useOperationAvailable(services, 'plugin.automation.windows.mouse.repeat');
  const base: DesktopClick = {
    button,
    click,
    ...(fixed ? { position: { x: Number(x), y: Number(y) } } : {}),
  };
  const repetition: DesktopRepeatLimit =
    limit === 'count'
      ? { kind: limit, count: Number(count) }
      : limit === 'duration'
        ? { kind: limit, duration_ms: Number(duration) }
        : { kind: limit, max_duration_ms: Number(duration) };
  const run = <T extends DesktopView>(operation: (signal: AbortSignal) => Promise<JobOutcome<T>>) =>
    action.run(async (signal) => {
      await services.automation.refreshOperations(signal);
      const result = await operation(signal);
      if (!signal.aborted) {
        setOutput(result);
        if ('coordinate_space' in result.data) setPosition(result.data);
      }
      return result;
    });
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2"><Monitor className="size-4" aria-hidden="true" />作用于运行服务器的电脑</span>
        <span>执行前确认目标电脑与前台窗口</span>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-6">
          <h2 className="text-base font-semibold">服务器桌面输入</h2>
          <div className="flex items-center gap-2">
            {action.pending && <Button size="sm" variant="outline" onClick={action.cancel}>取消等待</Button>}
            <Button size="sm" disabled={!canRepeat || action.pending}
              onClick={() => setCommand({ kind: 'repeat', input: { ...base, interval_ms: Number(interval), repeat: repetition, stop_on_f9: f9 } })}>
              <Play aria-hidden="true" />执行连续点击
            </Button>
          </div>
        </header>
        <div className="grid min-w-0 lg:grid-cols-[minmax(16rem,0.9fr)_minmax(0,1.6fr)]">
          <div className="min-w-0 border-b border-border bg-surface-elevated p-5 sm:p-7 lg:border-r lg:border-b-0">
            <h3 className="flex items-center gap-3 text-base font-semibold">
              <span className="flex size-10 items-center justify-center rounded-lg bg-accent text-primary"><MousePointer2 className="size-5" aria-hidden="true" /></span>
              鼠标与坐标
            </h3>
            <div className="pt-9 pb-6 text-center" aria-live="polite">
              <p className="text-xs text-faint">当前位置</p>
              <div className="my-4 flex flex-wrap items-baseline justify-center gap-x-3 gap-y-2 font-mono text-3xl font-medium">
                <span className="text-xs font-normal text-faint">X</span><span>{position?.x ?? '—'}</span>
                <span className="ml-2 text-xs font-normal text-faint">Y</span><span>{position?.y ?? '—'}</span>
              </div>
              <p className="text-xs text-faint">读取服务器当前鼠标位置</p>
              <Button className="mt-5" variant="outline" disabled={!canPosition || action.pending}
                onClick={() => void run((signal) => services.automation.mousePosition(signal))}>
                <Crosshair aria-hidden="true" />读取位置
              </Button>
            </div>
            <div className="border-t border-border pt-5">
              <div className="mb-5 flex items-center justify-between gap-3">
                <Label htmlFor="desktop-fixed-position">使用指定坐标</Label>
                <Switch id="desktop-fixed-position" checked={fixed} onCheckedChange={setFixed} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="桌面 X 坐标" value={x} onChange={setX} type="number" min={-2147483648} max={2147483647} disabled={!fixed} />
                <Field label="桌面 Y 坐标" value={y} onChange={setY} type="number" min={-2147483648} max={2147483647} disabled={!fixed} />
              </div>
              <p className="mt-3 text-xs leading-relaxed text-faint">{fixed ? '虚拟桌面坐标，可为负数。' : '使用执行时服务器鼠标当前位置。'}</p>
            </div>
          </div>
          <div className="flex min-w-0 flex-col p-5 sm:px-8 sm:py-7">
            <h3 className="text-base font-semibold">点击方式</h3>
            <div className="mt-5 mb-5 grid gap-4 sm:grid-cols-2">
              <div className="grid min-w-0 gap-2">
                <Label htmlFor="desktop-mouse-button" className="text-xs text-muted-foreground">鼠标按键</Label>
                <Select value={button} onValueChange={(value) => { if (value === 'left' || value === 'right' || value === 'middle') setButton(value); }}>
                  <SelectTrigger id="desktop-mouse-button" className="w-full" aria-label="桌面鼠标按键"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(buttons).map(([value, label]) => <SelectItem value={value} key={value}>{label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid min-w-0 gap-2">
                <Label htmlFor="desktop-click-kind" className="text-xs text-muted-foreground">点击类型</Label>
                <Select value={click} onValueChange={(value) => { if (value === 'single' || value === 'double') setClick(value); }}>
                  <SelectTrigger id="desktop-click-kind" className="w-full" aria-label="桌面点击方式"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="single">单击</SelectItem><SelectItem value="double">双击</SelectItem></SelectContent>
                </Select>
              </div>
            </div>
            <Button className="self-start" variant="outline" disabled={!canClick || action.pending} onClick={() => setCommand({ kind: 'click', input: base })}>
              <MousePointer2 aria-hidden="true" />执行一次点击
            </Button>
            <div className="mt-6 border-t border-border pt-6">
              <h3 className="text-base font-semibold">连续点击</h3>
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <Field label="点击间隔（ms）" value={interval} onChange={setInterval} type="number" min={10} max={60000} />
                <div className="grid min-w-0 gap-2">
                  <Label htmlFor="desktop-repeat-limit" className="text-xs text-muted-foreground">停止方式</Label>
                  <Select value={limit} onValueChange={(value) => { if (value === 'count' || value === 'duration' || value === 'manual') setLimit(value); }}>
                    <SelectTrigger id="desktop-repeat-limit" className="w-full" aria-label="桌面停止条件"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="count">按次数停止</SelectItem>
                      <SelectItem value="duration">按时长停止</SelectItem>
                      <SelectItem value="manual">F9 或时限停止</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {limit === 'count' ? (
                  <Field label="点击次数" value={count} onChange={setCount} type="number" min={1} max={10000} />
                ) : (
                  <Field label={limit === 'duration' ? '执行时长（ms）' : '手动模式时限（ms）'} value={duration} onChange={setDuration} type="number" min={100} max={600000} />
                )}
              </div>
              <div className="mt-5 flex items-center justify-between gap-3">
                <Label htmlFor="desktop-stop-f9" className="text-sm text-muted-foreground">允许 <kbd className="mx-1 rounded border border-border bg-surface-elevated px-1.5 py-0.5 font-mono text-xs">F9</kbd> 停止</Label>
                <Switch id="desktop-stop-f9" checked={f9} onCheckedChange={setF9} />
              </div>
            </div>
            <p className="mt-auto pt-6 text-xs leading-relaxed text-faint">次数模式总等待及各模式时限最多 10 分钟。</p>
          </div>
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3 text-xs text-faint sm:px-6">
          <span>回执确认输入派发，界面效果需另行观察。</span>
          <span>{action.pending ? '正在执行' : output ? '已有执行回执' : '尚无本次执行回执'}</span>
        </footer>
      </div>
      <ActionFeedback {...action} />
      {output && (
        <section className="min-w-0 rounded-lg border border-border bg-card p-5">
          <h3 className="mb-3 text-sm font-semibold">桌面执行回执</h3>
          <DesktopResult result={output.data} />
          <p className="break-all text-xs text-muted-foreground">任务 ID：{output.job.id}</p>
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
              {command?.kind === 'repeat' ? '在服务器桌面连续点击' : '在服务器桌面点击'}
            </DialogTitle>
            <DialogDescription>
              将向服务器电脑当前前台窗口派发真实鼠标输入。确认此电脑及窗口是本次操作目标。
            </DialogDescription>
          </DialogHeader>
          {command && (
            <>
              <p>
                {buttons[command.input.button]} ·{' '}
                {command.input.click === 'single' ? '单击' : '双击'} ·{' '}
                {command.input.position
                  ? `指定坐标 (${command.input.position.x}, ${command.input.position.y})`
                  : '执行时鼠标当前位置'}
              </p>
              {command.kind === 'repeat' && (
                <p>
                  间隔 {command.input.interval_ms} 毫秒 ·{' '}
                  {command.input.repeat.kind === 'count'
                    ? `最多 ${command.input.repeat.count} 次`
                    : command.input.repeat.kind === 'duration'
                      ? `持续 ${command.input.repeat.duration_ms} 毫秒`
                      : `手动模式上限 ${command.input.repeat.max_duration_ms} 毫秒`}{' '}
                  · F9 停止{command.input.stop_on_f9 ? '开启' : '关闭'}
                </p>
              )}
            </>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCommand(null)}>
              返回修改
            </Button>
            <Button
              disabled={
                action.pending || !command || (command.kind === 'click' ? !canClick : !canRepeat)
              }
              onClick={() => {
                const selected = command;
                if (!selected) return;
                setCommand(null);
                if (selected.kind === 'click')
                  void run((signal) => services.automation.clickMouse(selected.input, signal));
                else void run((signal) => services.automation.repeatMouse(selected.input, signal));
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

function DesktopResult({ result }: { result: DesktopView }) {
  if ('coordinate_space' in result)
    return (
      <dl className="my-3 grid gap-x-5 gap-y-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)] [&>dt]:text-muted-foreground [&>dd]:min-w-0 [&>dd]:break-words">
        <dt>服务器鼠标位置</dt>
        <dd>
          ({result.x}, {result.y})
        </dd>
        <dt>坐标空间</dt>
        <dd>虚拟桌面 · GetCursorPos</dd>
      </dl>
    );
  return (
    <>
      <dl className="my-3 grid gap-x-5 gap-y-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)] [&>dt]:text-muted-foreground [&>dd]:min-w-0 [&>dd]:break-words">
        <dt>输入派发</dt>
        <dd>
          {result.dispatched} 次 · {buttons[result.button]} ·{' '}
          {result.click === 'single' ? '单击' : '双击'}
        </dd>
        <dt>实际坐标</dt>
        <dd>
          ({result.position.x}, {result.position.y})
        </dd>
        {'stop_reason' in result && (
          <>
            <dt>停止原因</dt>
            <dd>{stopReasons[result.stop_reason]}</dd>
            <dt>实际耗时</dt>
            <dd>{result.elapsed_ms} 毫秒</dd>
          </>
        )}
      </dl>
      <p className="mb-3 text-xs text-muted-foreground">界面效果尚未确认；已派发次数不等于界面接受次数。</p>
    </>
  );
}
