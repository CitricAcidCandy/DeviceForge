import { hostUi } from '@deviceforge/plugin-sdk';
import type { DeviceActionModel } from './actions.ts';

const labels = { idle: '', submitting: '正在提交，尚未确认接纳', waiting: '任务已接纳，等待最终结果',
  succeeded: '任务已完成', failed: '调用或任务失败', unknown: '结果尚未确认' };
export function ActionStatus({ model }: { readonly model: DeviceActionModel }) {
  const ui = hostUi();
  const state = ui.React.useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  const [notice, setNotice] = ui.React.useState<string | null>(null);
  if (state.phase === 'idle') return null;
  return <div className="space-y-2 text-xs leading-6" aria-live="polite">
    <div className={`rounded-lg border p-3 ${state.phase === 'unknown' ? 'border-[#E8CDAA] bg-[#FFF8EE] text-[#9A5A11]' : 'border-[#E6EAF3] bg-[#F5F6FB] text-[#596479]'}`}>
      <p className="font-medium" role={state.phase === 'failed' ? 'alert' : 'status'}>{labels[state.phase]}</p>
      {state.message && <p>{state.message}</p>}
      {state.pending && <button type="button" onClick={model.cancel} className="mt-1 text-[#6C4CF5]">停止页面等待</button>}
      {state.phase === 'unknown' && !state.pending && <div className="mt-1 flex flex-wrap items-center gap-3">
        {state.ticket && <button type="button" onClick={() => { void model.query().catch((error: unknown) => setNotice(error instanceof Error ? error.message : '任务查询未完成')); }} className="text-[#6C4CF5]">查询任务结果</button>}
        <a href="#/tasks" className="text-[#6C4CF5]">核对任务记录</a><span>不自动重放写入</span>
      </div>}
      {state.ticket && <p className="break-all font-mono text-[10px]">任务 ID：{state.ticket.id}</p>}
      {state.logId && <button type="button" className="break-all text-left font-mono text-[10px]" onClick={() => {
        const value = state.logId;
        if (value && globalThis.navigator?.clipboard) void globalThis.navigator.clipboard.writeText(value).then(
          () => setNotice('日志 ID 已复制'), () => setNotice('无法复制，请手动选择日志 ID'));
      }}>日志 ID：{state.logId} · 复制</button>}
      {notice && <p role="status">{notice}</p>}
    </div>
    {state.phase === 'succeeded' && <ui.JsonResult value={state.result} />}
    {state.previous.length > 0 && <details className="rounded-lg border border-[#E6EAF3] p-2 text-[#596479]">
      <summary className="cursor-pointer">先前任务票据</summary>
      {state.previous.map((ticket, at) => <p key={`${ticket.id}:${at}`} className="mt-1 break-all font-mono text-[10px]">{ticket.id} · {ticket.operation}</p>)}
    </details>}
  </div>;
}
