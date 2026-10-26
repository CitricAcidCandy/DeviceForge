import { useState } from 'react';
import { Button, Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../../../../components/index.ts';
import { missingRequiredDependencies } from '../../../../features/plugin-dependencies/index.ts';
import type { DependencyTarget } from '../../../../features/plugin-dependencies/index.ts';
import type { ApiClient } from '../../../../services/api/index.ts';
import { DependencyList } from './DependencyList.tsx';
import { useDependencies } from './use-dependencies.ts';

const phaseLabels = { idle: '', loading: '正在读取依赖状态…', scanning: '正在重新检测依赖…',
  installing: '正在安装依赖…', querying: '正在查询已提交的依赖任务…' };
const jobLabels = { queued: '排队中', running: '运行中', succeeded: '已成功', failed: '已失败', cancelled: '已取消' };
const stageLabels = { preparing: '准备依赖', downloading: '下载依赖', verifying: '校验依赖',
  deploying: '部署依赖', activating: '应用配置', complete: '处理完成' };

export interface PluginDependenciesProps {
  readonly client: ApiClient;
  readonly target: DependencyTarget | null;
  readonly name: string;
  readonly onClose: () => void;
  readonly onUpdated?: ((signal: AbortSignal) => Promise<void>) | undefined;
}

function DependenciesPanel({ client, target, name, onClose, onUpdated }: Omit<PluginDependenciesProps, 'target'> & { target: DependencyTarget }) {
  const { state, controller, invoke, syncIssue } = useDependencies(client, target);
  const [copyMessage, setCopyMessage] = useState('');
  const view = state?.result?.data;
  const busy = !state || state.phase !== 'idle';
  const disabled = busy || !view || !!state?.stale || !!state?.ticket;
  const required = missingRequiredDependencies(view?.dependencies ?? []);
  const progress = state?.progress;
  async function copy(logId: string) {
    try { await navigator.clipboard.writeText(logId); setCopyMessage('日志 ID 已复制'); }
    catch { setCopyMessage('复制失败，请选中日志 ID 手动复制'); }
  }
  return <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
    <SheetContent side="right" className="w-full gap-0 bg-[color:var(--card)] p-0 sm:max-w-xl">
      <SheetHeader className="border-b border-[color:var(--hairline)] p-5 pr-12">
        <SheetTitle className="break-words text-lg text-[color:var(--text-strong)]">插件依赖 · {name}</SheetTitle>
        <SheetDescription className="text-xs text-[color:var(--text-muted)]">
          仅管理运行后端的电脑，不操作当前浏览器电脑或已连接设备。空配置由后端自动发现，无需先填写工具路径。
        </SheetDescription>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-5">
        <p className="text-xs text-[color:var(--text-muted)]">正常安装插件会自动检测并复用本机及 .deviceforge 中的兼容依赖，缺失必需项会自动下载和配置；无需另点依赖安装。此面板用于失败补救、依赖失效后重检与可选工具补装。</p>
        <p className="break-all font-mono text-xs text-[color:var(--text-faint)]">{target.kind} / {target.id}</p>
        {view && (view.target.kind !== target.kind || view.target.id !== target.id) &&
          <p role="status" className="break-all text-xs text-[color:var(--text-muted)]">此组件由完整发布统一管理：{view.target.kind} / {view.target.id}</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => invoke((model, signal) => model.refresh(signal))}>读取状态</Button>
          <Button variant="outline" size="sm" disabled={disabled} onClick={() => invoke((model, signal) => model.scan(signal), onUpdated)}>重新检测</Button>
          <Button size="sm" disabled={disabled || !required.length} onClick={() => invoke((model, signal) => model.installRequired(signal), onUpdated)}>
            安装全部缺失必需{required.length ? `（${required.length}）` : ''}
          </Button>
          {state?.ticket && <Button variant="outline" size="sm" disabled={busy} onClick={() => invoke((model, signal) => model.query(signal), onUpdated)}>查询任务状态</Button>}
          {busy && controller && <Button variant="ghost" size="sm" onClick={() => controller.cancel()}>停止等待</Button>}
        </div>
        {busy && <div role="status" className="flex flex-col gap-2 text-sm text-[color:var(--text-body)]">
          <span>{phaseLabels[state?.phase ?? 'loading']}</span>
          {progress && <span className="break-words text-xs">{stageLabels[progress.stage]}{progress.resource_id ? ` · ${progress.resource_id}` : ''}
            {' · '}{progress.completed_bytes.toLocaleString('zh-CN')}{progress.total_bytes == null ? '' : ` / ${progress.total_bytes.toLocaleString('zh-CN')}`} 字节
          </span>}
          <progress aria-label="依赖操作进度" className="h-1.5 w-full accent-[color:var(--primary)]"
            {...(progress?.total_bytes ? { max: progress.total_bytes, value: progress.completed_bytes } : {})} />
        </div>}
        {state?.notice && <p role="status" className="text-xs text-[color:var(--text-muted)]">{state.notice}</p>}
        {syncIssue && <p role="alert" className="break-words text-xs text-[color:var(--warning)]">{syncIssue.message}
          {syncIssue.logId && <> · 日志 ID：<code>{syncIssue.logId}</code></>}
        </p>}
        {view && <p role="status" className="text-sm text-[color:var(--text-body)]">
          {state?.stale ? '状态需要重新读取，不能据此确认依赖就绪。' : view.ready ? '必需依赖已就绪' : '仍有必需依赖未就绪'}
        </p>}
        {state?.job && <p className="break-all text-xs text-[color:var(--text-muted)]">
          任务 {jobLabels[state.job.status]} · <code>{state.job.id}</code>
        </p>}
        {state?.logId && <div className="flex flex-wrap items-center gap-2 text-xs text-[color:var(--text-muted)]">
          <span className="break-all">当前日志 ID：<code>{state.logId}</code></span>
          <Button variant="ghost" size="sm" onClick={() => { void copy(state.logId ?? ''); }}>复制当前日志 ID</Button>
        </div>}
        {!!state?.issues.length && <section aria-label="依赖错误记录" className="flex flex-col gap-2">
          {state.issues.map((item, index) => <div key={index} role="alert" className="rounded-lg border border-[color:var(--warning)]/40 p-3 text-xs text-[color:var(--text-body)]">
            <p className="whitespace-pre-wrap break-words">{item.message}</p>
            {item.logId && <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="break-all">日志 ID：<code>{item.logId}</code></span>
              <Button variant="ghost" size="sm" onClick={() => { void copy(item.logId ?? ''); }}>复制日志 ID</Button>
            </div>}
          </div>)}
        </section>}
        {copyMessage && <p role="status" className="text-xs">{copyMessage}</p>}
        {view && <DependencyList dependencies={view.dependencies} disabled={disabled}
          onInstall={(id) => invoke((model, signal) => model.installDependency(id, signal), onUpdated)} />}
        {!view && state?.phase === 'idle' && <p className="text-sm text-[color:var(--text-muted)]">依赖状态尚未取得，请读取状态重试。</p>}
      </div>
    </SheetContent>
  </Sheet>;
}

export function PluginDependencies(props: PluginDependenciesProps) {
  if (!props.target) return null;
  return <DependenciesPanel key={`${props.target.kind}:${props.target.id}`} {...props} target={props.target} />;
}
