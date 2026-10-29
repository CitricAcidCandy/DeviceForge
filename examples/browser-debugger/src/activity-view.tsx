import * as React from 'react';
import type { DebuggerController, DebuggerState } from './controller.ts';
import { activitySteps, toolLabel } from './activity-presentation.ts';
import { json, object, text } from './protocol.ts';
import { Button, CopyId, Empty, JsonDetails } from './ui.tsx';

export function ActivityView({ state, controller, narrow, onData, onInspect, onDetails, onTargets }: {
  state: DebuggerState; controller: DebuggerController; narrow: boolean;
  onData: () => void; onInspect: () => void; onDetails: () => void; onTargets: () => void;
}) {
  const [stepId, setStepId] = React.useState('');
  const detail = state.activityDetail;
  const current = detail ?? state.activity?.items[0] ?? null;
  const steps = activitySteps(json(current));
  const selected = steps.find(step => step.id === stepId) ?? steps.at(-1);
  const pending = current?.state === 'queued' || current?.state === 'delivered';
  React.useEffect(() => setStepId(''), [current?.commandId]);
  if (!state.target) return <Empty title="先选择要调试的插件">
    <p>选择插件 → 让 Agent 调用调试工具 → 在这里查看过程与结果。</p>
    <div className="mt-4"><Button primary onClick={onTargets}>选择插件</Button></div>
  </Empty>;
  if (!current) return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-3"><h2 className="mr-auto text-[15px] font-semibold">当前插件的调试过程</h2>
      <Button disabled={Boolean(state.busy)} onClick={() => void controller.refreshActivity()}>刷新记录</Button></div>
    <div className="flex min-h-64 flex-col items-center justify-center gap-4 rounded-xl border border-[#E6EAF3] bg-[#F7F8FC] p-6 text-center">
      <h3 className="text-lg font-semibold">等待第一条调试调用</h3>
      <p className="max-w-xl text-sm leading-relaxed text-[#556176]">{state.activity?.unavailable || 'Agent 调用这个插件的公开调试工具后，可以在这里查看调用和结果。也可以先手动检查界面或数据。'}</p>
      <div className="flex flex-wrap justify-center gap-3"><Button primary disabled={!state.connected || state.stale} onClick={onInspect}>在页面上选择</Button><Button onClick={onData}>查看数据</Button></div>
    </div>
    <p className="text-xs text-[#556176]">这里只保留当前宿主仍留存的调用；没有记录不代表从未调用，也不代表 Agent 离线。</p>
  </div>;
  return <div className={`grid min-h-full gap-6 ${narrow ? 'grid-cols-1' : 'grid-cols-[minmax(0,1.66fr)_minmax(280px,1fr)]'}`}>
    <section className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-3"><h2 className="mr-auto text-[15px] font-semibold">{current.tool === 'automation_run' ? `本次调试计划${steps.length ? ` · ${steps.length}步` : ''}` : toolLabel(current.tool)}</h2>
        <span className="text-xs text-[#556176]">外部工具调用{state.stale ? ' · 已过期' : ''}</span><Button disabled={Boolean(state.busy)} onClick={() => void controller.refreshActivity()}>刷新</Button></div>
      <div className="overflow-hidden rounded-xl border border-[#E6EAF3]">
        {steps.length ? steps.map((step, index) => <button key={step.id || index} type="button" aria-pressed={selected?.id === step.id}
          onClick={() => setStepId(step.id)} className={`${selected?.id === step.id ? 'bg-[#EFEBFF]' : index % 2 ? 'bg-[#FBFCFE]' : 'bg-white'} flex min-h-20 w-full items-center gap-4 px-5 py-4 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5]`}>
          <span aria-hidden="true" className={step.tone === 'success' ? 'text-[#17664F]' : step.tone === 'error' || step.tone === 'warning' ? 'text-[#8A4D00]' : 'text-[#556176]'}>{pending ? '○' : step.tone === 'error' ? '!' : step.tone === 'warning' ? '?' : step.status === '未执行' ? '—' : '✓'}</span>
          <span className="min-w-0 break-words font-medium">{step.label}</span><span aria-hidden="true" className="text-[#556176]">·</span>
          <span className={`${step.tone === 'success' ? 'text-[#17664F]' : step.tone === 'warning' || step.tone === 'error' ? 'text-[#8A4D00]' : 'text-[#23272E]'} min-w-0 break-words`}>{state.stale ? '当时' : ''}{step.status}</span>
        </button>) : <p className="p-5 text-sm text-[#556176]">{pending ? '整段计划执行中，等待最终回执；尚未取得可展示的步骤。' : '回执未提供步骤正文，可在技术详情查看留存信息。'}</p>}
      </div>
      <p className="text-[13px] leading-relaxed text-[#556176]">{state.stale ? '这些是断线前的历史证据，不代表当前页面仍保持相同状态。' : pending ? '等待最终回执；暂不显示逐步成功或失败。' : '点击步骤可查看结果。只有明确通过的检查会标记为通过。'}</p>
      {(state.activity?.gap || state.activity?.retainedOnly) && <p className="text-xs text-[#556176]">{state.activity?.gap ? '记录存在保留缺口。' : ''}此处仅展示仍留存的命令，不是完整历史。</p>}
      {(state.activity?.items.length ?? 0) > 1 && <details className="rounded-lg border border-[#E6EAF3] p-3 text-[13px]"><summary className="cursor-pointer text-[#556176]">其他调试调用（{state.activity?.items.length}）</summary>
        <div className="mt-2 space-y-2">{state.activity?.items.filter(item => item.commandId !== current.commandId).map(item => <Button key={item.commandId} onClick={() => void controller.selectActivity(item.commandId)}>{toolLabel(item.tool)} · {item.state === 'succeeded' ? '已返回' : item.state === 'failed' ? '失败' : '等待核对'}</Button>)}</div>
      </details>}
      {state.activity?.nextBefore != null && <Button disabled={Boolean(state.busy)} onClick={() => void controller.refreshActivity(state.activity?.nextBefore ?? undefined)}>查看更早记录</Button>}
    </section>
    <aside aria-label="选中步骤的执行结果" className="min-w-0 space-y-5 rounded-xl bg-[#F7F8FC] p-6">
      <h3 className="text-sm font-semibold">执行结果{state.stale ? ' · 最后观测' : ''}</h3>
      <h4 className={`text-lg font-semibold ${selected?.tone === 'success' ? 'text-[#17664F]' : selected?.tone === 'warning' || selected?.tone === 'error' || state.stale ? 'text-[#8A4D00]' : 'text-[#23272E]'}`}>
        {state.stale ? '最后观测内容' : pending ? '正在等待结果' : selected?.status ?? '回执已返回'}</h4>
      <p className="break-words text-sm leading-relaxed text-[#556176]">{state.stale ? '当前状态尚未确认。重新连接只恢复观察，不会自动重放先前动作。' : selected?.detail || (pending ? '最终结果返回后，这里会显示对应步骤的公开证据。' : '已收到此步骤回执，完整证据与日志在技术详情中。')}</p>
      {!pending && <div className="flex flex-col gap-3">
        {(/unconfirmed/.test(current.state) || object(current.response).status === 'indeterminate' || object(current.response).status === 'cancelled') && <Button primary disabled={Boolean(state.busy)} onClick={() => void controller.selectActivity(current.commandId)}>查询原命令结果</Button>}
        <Button disabled={state.stale || !state.connected} onClick={onData}>查看当前数据</Button>
        <Button onClick={onDetails}>查看技术详情与日志</Button>
      </div>}
      {selected?.logId && <CopyId value={selected.logId} />}
      <details className="text-[13px] text-[#556176]"><summary className="cursor-pointer">此步骤的公开证据</summary><div className="mt-3"><JsonDetails value={selected?.result ?? object(current.response)} label="展开原始结果" /></div></details>
    </aside>
  </div>;
}
