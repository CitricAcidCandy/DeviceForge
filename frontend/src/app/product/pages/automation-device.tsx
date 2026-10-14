import { useState } from 'react';
import { Button } from '../../../components/Button/index.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/Select/index.tsx';
import { EmptyState, Field, JsonResult } from '../../../components/index.ts';
import { useOperationAvailable } from '../capabilities.tsx';
import { ActionFeedback, ErrorNotice } from '../feedback.tsx';
import { useAction, useSnapshot } from '../hooks.ts';
import { withSelectedDevice } from '../device-target.ts';
import type { ProductServices } from '../services.ts';
import type { AutomationAction, AutomationResult, AutomationSequence } from '../../../features/automation/index.ts';
import type { JobOutcome } from '../../../shared/jobs/index.ts';
import type { DeviceRef } from '../../../plugin-sdk/index.ts';

function stepDescription(action: AutomationAction): string {
  if (action.kind === 'tap') return `点击坐标 (${action.x}, ${action.y})`;
  if (action.kind === 'swipe') return `从 (${action.x1}, ${action.y1}) 滑动到 (${action.x2}, ${action.y2})，持续 ${action.duration_ms} 毫秒`;
  if (action.kind === 'key') return `派发按键码 ${action.code}`;
  return `输入文本：${action.text}`;
}

export function DeviceAutomation({services}: {services: ProductServices}) {
  const snapshot = useSnapshot(services.runtime.devices);
  const action = useAction();
  const [steps, setSteps] = useState<AutomationSequence['steps']>([]);
  const [kind, setKind] = useState<AutomationAction['kind']>('tap');
  const [x, setX] = useState('100'); const [y, setY] = useState('100');
  const [x2, setX2] = useState('300'); const [y2, setY2] = useState('300');
  const [key, setKey] = useState('4'); const [duration, setDuration] = useState('300');
  const [text, setText] = useState(''); const [at, setAt] = useState('0');
  const [count, setCount] = useState('5'); const [interval, setInterval] = useState('500');
  const [stepError, setStepError] = useState<Error | null>(null);
  const [output, setOutput] = useState<{reference: DeviceRef; outcome: JobOutcome<AutomationResult>} | null>(null);
  const sequenceAvailable = useOperationAvailable(services, 'plugin.automation.sequence.run');
  const repeatAvailable = useOperationAvailable(services, 'plugin.automation.click.repeat');
  const provider = snapshot.providers.find(entry => entry.id === snapshot.selection?.providerId && entry.generation === snapshot.selection.generation);
  const supported = provider?.definition.discoverOperation.startsWith('plugin.android-device.') || provider?.definition.capabilities.some(entry => entry.operation.startsWith('plugin.android-device.'));
  const ready = Boolean(snapshot.selection && snapshot.selected?.state === 'online' && supported);
  const run = (operation: (device: string, signal: AbortSignal) => Promise<JobOutcome<AutomationResult>>) => action.run(async signal => {
    const result = await withSelectedDevice(services, signal, async (reference, active) => {
      const source = services.runtime.devices.snapshot().providers.find(entry => entry.id === reference.providerId && entry.generation === reference.generation);
      if (!source?.definition.discoverOperation.startsWith('plugin.android-device.') && !source?.definition.capabilities.some(entry => entry.operation.startsWith('plugin.android-device.'))) throw new Error('此设备自动化只支持声明 Android 设备操作的提供者');
      await services.automation.refreshOperations(active);
      return {reference, outcome: await operation(reference.localId, active)};
    });
    if (!signal.aborted) setOutput(result);
    return result.outcome;
  });
  function addStep() {
    try {
      const integer = (value: string, minimum: number, maximum: number) => {
        const number = Number(value);
        if (!value.trim() || !Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`请输入 ${minimum} 至 ${maximum} 范围内的整数`);
        return number;
      };
      const time = integer(at, steps.at(-1)?.at_ms ?? 0, 3600000);
      if (steps.length >= 10000) throw new Error('单个流程最多 10000 步');
      if (kind === 'text' && (text.length > 1024 || !/^[A-Za-z0-9 .,_@-]+$/.test(text))) throw new Error('设备文本限 1024 个 ASCII 字母、数字、空格及 . , _ @ -；此接口不支持中文输入');
      const next: AutomationAction = kind === 'text' ? {kind, text} : kind === 'key' ? {kind, code: integer(key, 0, 288)} : kind === 'swipe' ? {kind, x1: integer(x, 0, 65535), y1: integer(y, 0, 65535), x2: integer(x2, 0, 65535), y2: integer(y2, 0, 65535), duration_ms: integer(duration, 1, 10000)} : {kind, x: integer(x, 0, 65535), y: integer(y, 0, 65535)};
      setSteps(previous => [...previous, {at_ms: time, action: next}]); setStepError(null);
    } catch (error) { setStepError(error instanceof Error ? error : new Error('步骤内容无效')); }
  }
  return <section className="workspace-section"><h2>设备流程</h2>
    {!ready && <EmptyState title="等待支持设备输入的在线设备" description="选择声明 Android 设备操作的提供者；不同输入操作分别核对服务器目录。" />}
    <div className="form-row"><Select value={kind} onValueChange={value => { if (value === 'tap' || value === 'swipe' || value === 'key' || value === 'text') setKind(value); }}><SelectTrigger aria-label="步骤类型"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="tap">点击</SelectItem><SelectItem value="swipe">滑动</SelectItem><SelectItem value="key">按键</SelectItem><SelectItem value="text">文本</SelectItem></SelectContent></Select><Field label="执行时间（毫秒）" value={at} onChange={setAt} type="number" min={0} max={3600000} hint="相对流程开始，时间需按非递减顺序添加" />
      {kind === 'text' ? <Field label="设备输入文本" value={text} onChange={setText} hint="只支持 ASCII 字母、数字、空格和 . , _ @ -" /> : kind === 'key' ? <Field label="按键码" value={key} onChange={setKey} type="number" min={0} max={288} /> : <><Field label="设备 X 坐标" value={x} onChange={setX} type="number" min={0} max={65535} /><Field label="设备 Y 坐标" value={y} onChange={setY} type="number" min={0} max={65535} /></>}
      {kind === 'swipe' && <><Field label="滑动终点 X" value={x2} onChange={setX2} type="number" min={0} max={65535} /><Field label="滑动终点 Y" value={y2} onChange={setY2} type="number" min={0} max={65535} /><Field label="滑动持续（毫秒）" value={duration} onChange={setDuration} type="number" min={1} max={10000} /></>}<Button variant="outline" onClick={addStep} disabled={action.pending}>添加步骤</Button>
    </div><ErrorNotice error={stepError} />
    {steps.length === 0 ? <p className="muted">添加点击、滑动、按键或文本步骤后运行。</p> : <ol className="workflow-steps">{steps.map((step, index) => <li key={index}><span>{index + 1}. {step.at_ms} 毫秒 · {stepDescription(step.action)}</span><Button variant="ghost" size="sm" aria-label={`移除步骤 ${index + 1}`} disabled={action.pending} onClick={() => setSteps(previous => previous.filter((_, position) => position !== index))}>移除</Button></li>)}</ol>}
    <div className="action-row"><Button disabled={!ready || !sequenceAvailable || steps.length === 0 || action.pending} onClick={() => void run((device, signal) => services.automation.runSequence({device_id: device, steps}, signal))}>运行设备流程</Button></div>
    <h3>设备重复点击</h3><div className="form-row"><Field label="重复点击 X" value={x} onChange={setX} type="number" min={0} max={65535} /><Field label="重复点击 Y" value={y} onChange={setY} type="number" min={0} max={65535} /><Field label="设备点击次数" value={count} onChange={setCount} type="number" min={1} max={10000} /><Field label="设备点击间隔（毫秒）" value={interval} onChange={setInterval} type="number" min={10} max={60000} /><Button variant="outline" disabled={!ready || !repeatAvailable || action.pending} onClick={() => void run((device, signal) => services.automation.repeatClick({device_id: device, x: Number(x), y: Number(y), count: Number(count), interval_ms: Number(interval)}, signal))}>重复点击设备</Button></div>
    <ActionFeedback {...action} />{output && <><h3>设备执行回执</h3>{JSON.stringify(output.reference) !== JSON.stringify(snapshot.selection) && <p className="capability-notice">以下属于先前设备的历史结果。</p>}<p>设备 {output.outcome.data.device_id} · 已派发 {output.outcome.data.dispatched} 次输入 · 派发流程已结束</p><p className="muted">界面效果尚未确认。任务 ID：{output.outcome.job.id}</p><JsonResult value={output.outcome} /></>}
  </section>;
}
