import * as React from 'react';
import type { HostContext } from '../../../frontend/src/plugin-sdk/index.ts';
import type { DebuggerController, DebuggerState } from './controller.ts';
import { array, object, text } from './protocol.ts';
import { createDownloads, localReport, markdownReport } from './report.ts';
import { nextReportPage } from './report-pages.ts';
import { Badge, Button, Check, CopyId, Definition, Empty, JsonDetails } from './ui.tsx';

export function ReportView({ state, controller, context }: { state: DebuggerState; controller: DebuggerController; context: HostContext }) {
  const [confirmed, setConfirmed] = React.useState(false), [persist, setPersist] = React.useState(false), [status, setStatus] = React.useState('');
  const element = React.useRef<HTMLDivElement>(null);
  const downloads = React.useRef<ReturnType<typeof createDownloads> | null>(null);
  const lifetime = React.useRef(new AbortController());
  React.useEffect(() => { const signal = lifetime.current; return () => { signal.abort(); downloads.current?.dispose(); }; }, []);
  React.useEffect(() => setConfirmed(false), [state.target?.pluginId, state.target?.generation]);
  function save(format: 'json' | 'markdown') {
    const document = element.current?.ownerDocument;
    if (!document) return;
    try {
      downloads.current ??= createDownloads(document);
      const content = format === 'json' ? JSON.stringify(localReport(state), null, 2) : markdownReport(state);
      downloads.current.save(new Blob([content], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8' }),
        `deviceforge-debugger-${state.target?.pluginId ?? 'snapshot'}-${Date.now()}.${format === 'json' ? 'json' : 'md'}`);
      setStatus('已请求浏览器下载当前公开证据，未自动采集新快照。');
    } catch (error) { setStatus(error instanceof Error ? error.message : '下载失败'); }
  }
  const artifactWrapper = object(object(state.report).artifact);
  const artifact = object(artifactWrapper.metadata);
  async function saveArtifact() {
    const id = text(artifact.id), document = element.current?.ownerDocument;
    if (!context.artifacts || !id || !document) return;
    try {
      const signal = AbortSignal.any([context.signal, lifetime.current.signal, AbortSignal.timeout(15000)]);
      const response = await context.artifacts.download(id, signal); signal.throwIfAborted();
      downloads.current ??= createDownloads(document);
      downloads.current.save(response.data, text(artifact.filename, `debugger-report-${id}.json`));
      setStatus('已通过公开产物接口请求下载。');
    } catch (error) { if (!lifetime.current.signal.aborted) setStatus(error instanceof Error ? error.message : '报告产物下载失败'); }
  }
  const installation = object(state.installation);
  return <div ref={element} className="space-y-4">
    <section className="space-y-3 rounded-lg border border-[#E6EAF3] p-4"><h2 className="text-[15px] font-semibold">调试报告</h2>
      <p className="text-[13px] text-[#556176]">报告汇总当前目标的公开元数据与已缓存快照，不自动采集 UI、不执行命令。断线仍可下载带过期标记的本地缓存。</p>
      <div className="flex flex-wrap items-center gap-2"><Badge warning={state.stale}>{state.stale ? '缓存已过期' : '最近公开证据'}</Badge><span className="text-[13px]">{state.trees.length} 个缓存快照</span></div>
      <Check checked={persist} onChange={setPersist}>请求宿主持久报告产物（以实际返回 artifact 为准）</Check>
      <div className="flex flex-wrap gap-2"><Button disabled={!state.sessionId || state.stale || Boolean(state.busy)} onClick={() => void controller.report(persist, 'json')}>汇总公开报告</Button>
        <Button disabled={!state.target} onClick={() => save('json')}>下载 JSON</Button><Button disabled={!state.target} onClick={() => save('markdown')}>下载 Markdown</Button>
        {text(artifact.id) && <Button disabled={!context.artifacts} onClick={() => void saveArtifact()}>下载宿主报告产物</Button>}</div>
      {text(artifact.id) && <dl><Definition label="持久产物"><code>{text(artifact.id)}</code></Definition><Definition label="文件">{text(artifact.filename, '宿主未提供文件名')}</Definition></dl>}
      {nextReportPage(state.report) && <div className="flex flex-wrap items-center gap-2"><p className="text-[13px] text-[#8A4D00]">报告仍有缓存快照页尚未加载；本地下载会如实保留当前完整性。</p><Button disabled={state.stale || Boolean(state.busy)} onClick={() => void controller.reportNext()}>读取报告下一页</Button></div>}
      {state.report !== null && <JsonDetails value={state.report} label="报告证据与快照清单" />}
      <p role="status" className="text-[13px] text-[#556176]">{status}</p><CopyId value={state.logId} />
    </section>
    <section className="space-y-3 rounded-lg border border-[#E6EAF3] p-4"><h2 className="text-[15px] font-semibold">安装组件与运行修订</h2>
      <p className="text-[13px] text-[#556176]">只读查询部署与当前运行代次。旧独立包缺少摘要时显示未知，不用文件名或版本推断运行代码已经更新。</p>
      <Button disabled={Boolean(state.busy)} onClick={() => void controller.installation()}>查询安装与修订</Button>
      {state.installation !== null && <div className="space-y-3">
        {array(installation.installations).map((raw, index) => {
          const item = object(raw); return <article key={index} className="rounded-md border border-[#E6EAF3] p-3">
            <h3 className="break-all text-sm font-medium">{text(item.id)} · {text(item.version)}</h3><p className="my-2 break-all text-xs text-[#556176]">安装修订 {text(item.revision, '未知')} · {text(item.status)}</p>
            {array(item.components).map((rawComponent, componentIndex) => { const component = object(rawComponent); return <div key={componentIndex} className="flex flex-wrap items-center gap-2 border-t border-[#E6EAF3] py-2 text-[13px]">
              <code className="break-all">{text(component.id)}</code><Badge>{text(component.kind)}</Badge><Badge warning={component.build_state !== 'current'}>{component.build_state === 'current' ? '运行修订已核对' : component.build_state === 'refresh_required' ? '需更新运行实例' : '尚未观测构建'}</Badge>
              <span className="break-all text-xs text-[#556176]">运行代次 {text(component.running_generation, '未知')} · 运行修订 {text(component.running_revision, '未知')}</span>
            </div>; })}
          </article>;
        })}
        {array(installation.standalone).map((raw, index) => { const item = object(raw); return <article key={index} className="space-y-1 rounded-md border border-[#E6EAF3] p-3 text-[13px]">
          <p className="break-all font-medium">{text(item.id)} · {text(item.kind)} · {text(item.version)}</p><p className="text-[#556176]">部署摘要：{text(item.digest, '未知')} · {text(item.digest_status, '宿主未观测')}</p>
        </article>; })}
        {!array(installation.installations).length && !array(installation.standalone).length && <Empty title="未查询到已安装组件" />}
        <p className="text-[13px] text-[#556176]">{text(installation.note)}</p>
        <JsonDetails value={installation.running} label="当前运行代次清单" />
      </div>}
    </section>
    <section className="space-y-3 rounded-lg border border-[#E6EAF3] p-4"><h2 className="text-[15px] font-semibold">重载明确选定插件</h2>
      <p className="text-[13px] text-[#8A4D00]">重载当前浏览器插件运行实例会卸载其界面与资源。取消等待可能留下未确认结果，请先查询，不自动重复重载。</p>
      <p className="break-all text-[13px]">选定：<code>{state.target?.pluginId ?? '未选择'}</code> · 代次 <code>{state.target?.generation ?? '未知'}</code></p>
      <Check checked={confirmed} onChange={setConfirmed}>确认只重载上述插件和代次，随后核对新代次</Check>
      <Button disabled={!state.sessionId || state.stale || Boolean(state.busy) || !confirmed}
        onClick={() => { void controller.reload(confirmed); setConfirmed(false); }}>重载此插件一次</Button>
    </section>
  </div>;
}
