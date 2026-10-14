import { useState } from 'react';
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
import { Field, JsonResult } from '../../../../components/index.ts';
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
      if (!signal.aborted) setOutput(result);
      return result;
    });
  return (
    <section className="workspace-section">
      <h2>服务器桌面输入</h2>
      <p className="muted">
        输入作用于运行服务器的电脑。坐标属于虚拟桌面，可为负数；回执只确认派发，界面效果需另行观察。
      </p>
      <div className="action-row">
        <Button
          variant="outline"
          disabled={!canPosition || action.pending}
          onClick={() => void run((signal) => services.automation.mousePosition(signal))}
        >
          读取服务器鼠标位置
        </Button>
      </div>
      <div className="form-row">
        <Select
          value={button}
          onValueChange={(value) => {
            if (value === 'left' || value === 'right' || value === 'middle') setButton(value);
          }}
        >
          <SelectTrigger aria-label="桌面鼠标按键">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(buttons).map(([value, label]) => (
              <SelectItem value={value} key={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={click}
          onValueChange={(value) => {
            if (value === 'single' || value === 'double') setClick(value);
          }}
        >
          <SelectTrigger aria-label="桌面点击方式">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="single">单击</SelectItem>
            <SelectItem value="double">双击</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="setting-toggle">
        <Label htmlFor="desktop-fixed-position">使用指定坐标</Label>
        <Switch id="desktop-fixed-position" checked={fixed} onCheckedChange={setFixed} />
      </div>
      {fixed ? (
        <div className="form-row">
          <Field
            label="桌面 X 坐标"
            value={x}
            onChange={setX}
            type="number"
            min={-2147483648}
            max={2147483647}
          />
          <Field
            label="桌面 Y 坐标"
            value={y}
            onChange={setY}
            type="number"
            min={-2147483648}
            max={2147483647}
          />
        </div>
      ) : (
        <p className="muted">不指定坐标，使用执行时服务器鼠标当前位置。</p>
      )}
      <div className="action-row">
        <Button
          variant="outline"
          disabled={!canClick || action.pending}
          onClick={() => setCommand({ kind: 'click', input: base })}
        >
          执行桌面点击
        </Button>
      </div>
      <h3>桌面连续点击</h3>
      <div className="form-row">
        <Field
          label="桌面点击间隔（毫秒）"
          value={interval}
          onChange={setInterval}
          type="number"
          min={10}
          max={60000}
        />
        <Select
          value={limit}
          onValueChange={(value) => {
            if (value === 'count' || value === 'duration' || value === 'manual') setLimit(value);
          }}
        >
          <SelectTrigger aria-label="桌面停止条件">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="count">按次数停止</SelectItem>
            <SelectItem value="duration">按时长停止</SelectItem>
            <SelectItem value="manual">F9 或时限停止</SelectItem>
          </SelectContent>
        </Select>
        {limit === 'count' ? (
          <Field
            label="桌面点击次数"
            value={count}
            onChange={setCount}
            type="number"
            min={1}
            max={10000}
          />
        ) : (
          <Field
            label={limit === 'duration' ? '桌面执行时长（毫秒）' : '手动模式时限（毫秒）'}
            value={duration}
            onChange={setDuration}
            type="number"
            min={100}
            max={600000}
          />
        )}
      </div>
      <div className="setting-toggle">
        <Label htmlFor="desktop-stop-f9">允许 F9 停止</Label>
        <Switch id="desktop-stop-f9" checked={f9} onCheckedChange={setF9} />
      </div>
      <p className="muted">
        次数模式的总等待时间最多 10 分钟；时长和手动模式均需设置最长 10 分钟的时限。
      </p>
      <Button
        disabled={!canRepeat || action.pending}
        onClick={() =>
          setCommand({
            kind: 'repeat',
            input: { ...base, interval_ms: Number(interval), repeat: repetition, stop_on_f9: f9 },
          })
        }
      >
        执行桌面连续点击
      </Button>
      <ActionFeedback {...action} />
      {output && (
        <>
          <h3>桌面执行回执</h3>
          <DesktopResult result={output.data} />
          <p className="muted">任务 ID：{output.job.id}</p>
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
      <dl className="metadata-grid">
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
      <dl className="metadata-grid">
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
      <p className="capability-notice">界面效果尚未确认；已派发次数不等于界面接受次数。</p>
    </>
  );
}
