import * as React from 'react';
import type { HostContext } from '../../../frontend/src/plugin-sdk/index.ts';
import type { DebuggerController, DebuggerState } from './controller.ts';
import { CatalogView } from './targets-view.tsx';
import { TimelineView } from './timeline-view.tsx';
import { ReportView } from './report-view.tsx';
import { Button, CopyId, Definition, JsonDetails } from './ui.tsx';

export function DetailsView({ state, controller, context, onInvoke, onResize }: {
  state: DebuggerState; controller: DebuggerController; context: HostContext;
  onInvoke: () => void; onResize: () => void;
}) {
  return <div className="space-y-4">
    <p className="text-sm text-[#556176]">按需展开完整身份、能力、日志和证据。查看历史不会重新执行原操作。</p>
    <details className="rounded-xl border border-[#E6EAF3] p-4"><summary className="cursor-pointer text-sm font-semibold">目标身份与公开登记</summary>
      <div className="mt-3 space-y-3"><dl>
        <Definition label="插件"><code>{state.target?.pluginId ?? '未选择'}</code></Definition>
        <Definition label="浏览器实例"><code>{state.target?.instanceId ?? '服务器目标'}</code></Definition>
        <Definition label="代次"><code>{state.target?.generation ?? '未提供'}</code>{state.stale ? '（已过期）' : ''}</Definition>
        <Definition label="观察会话"><code>{state.sessionId ?? '未打开'}</code> · {state.sessionState}</Definition>
      </dl><Button disabled={!state.sessionId || state.stale || Boolean(state.busy)} onClick={() => void controller.refreshInspection()}>刷新公开登记</Button>
        <CopyId value={state.logId} /><JsonDetails value={state.inspection} label="登记资源、能力与历史清理告警" />
        {!state.sessionCleanupSupported && <p className="rounded-lg bg-[#FDF6ED] p-3 text-[13px] text-[#8A4D00]">此宿主缺少会话生命周期登记，请先关闭观察会话再停用调试器。</p>}
      </div>
    </details>
    <details className="rounded-xl border border-[#E6EAF3] p-4"><summary className="cursor-pointer text-sm font-semibold">公开能力、槽位与路由</summary>
      <div className="mt-4 space-y-4"><Button disabled={!state.sessionId || state.stale} onClick={onInvoke}>调用公开能力</Button><CatalogView state={state} controller={controller} /></div>
    </details>
    <details className="rounded-xl border border-[#E6EAF3] p-4"><summary className="cursor-pointer text-sm font-semibold">日志与事件</summary><div className="mt-4"><TimelineView state={state} controller={controller} /></div></details>
    <details className="rounded-xl border border-[#E6EAF3] p-4"><summary className="cursor-pointer text-sm font-semibold">报告、安装修订与插件操作</summary><div className="mt-4"><ReportView state={state} controller={controller} context={context} /></div></details>
    <details className="rounded-xl border border-[#E6EAF3] p-4"><summary className="cursor-pointer text-sm font-semibold">本次调用完整证据</summary><div className="mt-3"><JsonDetails value={state.activityDetail} label="调用与最终回执" /><JsonDetails value={state.result} label="最近手动操作结果" /></div></details>
    <details className="rounded-xl border border-[#E6EAF3] p-4"><summary className="cursor-pointer text-sm font-semibold">面板设置</summary><div className="mt-3 space-y-2"><p className="text-[13px] text-[#556176]">拖动标题栏移动浮窗，拖动右下角改变尺寸。Alt + 方向键移动悬浮球。</p><Button onClick={onResize}>使用键盘调整尺寸</Button></div></details>
  </div>;
}
