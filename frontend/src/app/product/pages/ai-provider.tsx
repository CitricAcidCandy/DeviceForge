import { useState } from 'react';
import { Button } from '../../../components/ui/button.tsx';
import { Textarea } from '../../../components/ui/textarea.tsx';
import { Label } from '../../../components/ui/label.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select.tsx';
import { Field, EmptyState, JsonResult } from '../../../components/common/index.ts';
import { useOperationAvailable } from '../capabilities.tsx';
import { ActionFeedback, ErrorNotice } from '../feedback.tsx';
import { useAction, useSnapshot } from '../hooks.ts';
import type { ProductServices } from '../services.ts';

type AiMode = 'stream' | 'single' | 'turn' | 'assistant';
interface Answer { readonly text: string; readonly thread_id: string; readonly project_id: string }
interface Qualification { readonly ready: boolean; readonly projects: readonly string[]; readonly reason: string | null }
const itemNames: Readonly<Record<string, string>> = {agent_message: '回答', reasoning: '推理摘要', command_execution: '命令执行', file_change: '文件改动', mcp_tool_call: 'MCP 调用', web_search: '搜索', todo_list: '任务计划'};

export function AiProviderPanel({services, provider}: {services: ProductServices; provider: 'sdk' | 'cli'}) {
  const [project, setProject] = useState(''); const [thread, setThread] = useState('');
  const [prompt, setPrompt] = useState(''); const [resumeId, setResumeId] = useState('');
  const [mode, setMode] = useState<AiMode>('stream'); const [answer, setAnswer] = useState<Answer | null>(null);
  const [qualification, setQualification] = useState<Qualification | null>(null);
  const [threadStatus, setThreadStatus] = useState<{closed: boolean; uncertain: boolean; turns: string} | null>(null);
  const action = useAction(); const turn = useAction();
  const stream = provider === 'sdk' ? services.runtime.aiSdkStreaming : services.aiStreaming;
  const sdkSnapshot = useSnapshot(services.runtime.aiSdkStreaming);
  const cliSnapshot = useSnapshot(services.aiStreaming);
  const current = provider === 'sdk' ? sdkSnapshot : cliSnapshot;
  const prefix = provider === 'sdk' ? 'plugin.ai-sdk.' : 'plugin.ai-assistant.';
  const canStatus = useOperationAvailable(services, prefix + 'runtime.status');
  const canQuery = useOperationAvailable(services, prefix + 'session.get');
  const canClose = useOperationAvailable(services, prefix + 'session.close');
  const canSubmitJob = useOperationAvailable(services, prefix + (mode === 'assistant' ? 'assistant.run' : `${provider}.${mode}`));
  const streamAvailable = current.definitions?.sessions.some(item => item.id === prefix + (provider === 'sdk' ? 'sdk.stream' : 'cli.stream')) ?? false;
  const liveSession = Boolean(current.session && current.session.status !== 'finished');
  const busy = turn.pending || action.pending;
  async function refresh(signal: AbortSignal) {
    await services.runtime.operations.refresh(signal);
    if (provider === 'sdk') await services.runtime.aiSdk.refreshOperations(signal);
    await stream.refreshDefinitions(signal);
    return stream.refreshRecords(signal);
  }
  async function submit(signal: AbortSignal) {
    if (mode === 'stream') {
      await stream.refreshDefinitions(signal);
      await stream.open({project_id: project, prompt, ...(thread ? {thread_id: thread} : {})}, signal);
      const result = await stream.pollOutput({limit: 100}, signal);
      if (!signal.aborted) {setThread(result.data.thread_id); setAnswer(result.data);} return result;
    }
    if (provider === 'sdk') {
      await services.runtime.aiSdk.refreshOperations(signal);
      const result = mode === 'assistant' ? await services.runtime.aiSdk.runAssistant({project_id: project, user_prompt: prompt, stream_output: false}, signal)
        : mode === 'single' ? await services.runtime.aiSdk.single({project_id: project, prompt}, signal)
          : await services.runtime.aiSdk.turn({project_id: project, prompt, ...(thread ? {thread_id: thread} : {})}, signal);
      if (!signal.aborted) {setAnswer(result.data); setThread(result.data.thread_id);} return result;
    }
    const result = mode === 'single' ? await services.aiAssistant.single({project_id: project, prompt}, signal)
      : await services.aiAssistant.turn({project_id: project, prompt, ...(thread ? {thread_id: thread} : {})}, signal);
    if (!signal.aborted) {setAnswer(result.data); setThread(result.data.thread_id);} return result;
  }
  return <div className="ai-provider"><div className="action-row"><Button variant="outline" disabled={busy} onClick={() => void action.run(refresh)}>刷新助手目录</Button><Button variant="outline" disabled={!canStatus || busy} onClick={() => void action.run(async signal => {
    if (provider === 'sdk') {await services.runtime.aiSdk.refreshOperations(signal); const result = await services.runtime.aiSdk.runtimeStatus(signal); if (!signal.aborted) setQualification({ready: result.data.ready, projects: result.data.projects, reason: result.data.reason}); return result;}
    const result = await services.aiAssistant.runtimeStatus(signal); if (!signal.aborted) setQualification({ready: result.data.configured, projects: result.data.projects, reason: null}); return result;
  })}>检查运行资格</Button></div>
    {qualification && <div className="capability-notice"><strong>{qualification.ready ? '运行资格就绪' : '运行资格未就绪'}</strong><p>{qualification.reason ?? '项目由服务器部署配置提供。'}</p><p>可用项目：{qualification.projects.join('、') || '没有公开项目'}</p></div>}
    <div className="form-row"><Field label={`${provider === 'sdk' ? 'SDK' : 'CLI'} 项目 ID`} value={project} onChange={value => {turn.cancel(); setProject(value); setThread(''); setThreadStatus(null);}} placeholder="服务器项目白名单中的 ID" /><Field label="线程 ID（可选）" value={thread} onChange={value => {turn.cancel(); setThread(value); setThreadStatus(null);}} /><div className="form-field"><Label htmlFor={`ai-mode-${provider}`}>执行方式</Label><Select value={mode} disabled={busy} onValueChange={value => {if (value === 'stream' || value === 'single' || value === 'turn' || value === 'assistant') setMode(value);}}><SelectTrigger id={`ai-mode-${provider}`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="stream">实时回答</SelectItem><SelectItem value="single">单次任务</SelectItem><SelectItem value="turn">线程续聊任务</SelectItem>{provider === 'sdk' && <SelectItem value="assistant">编排助手任务</SelectItem>}</SelectContent></Select></div></div>
    <div className="ai-transcript" role="log" aria-label={`${provider} 助手回答`}>{mode === 'stream' && current.stream.text ? <div className="ai-answer">{current.stream.text}</div> : answer ? <><p className="muted">来源项目：{answer.project_id} · 线程：{answer.thread_id}</p><div className="ai-answer">{answer.text}</div></> : <EmptyState title="从一个明确的问题开始" description="回答和过程来自服务器的真实会话。缺少工具、模型或项目配置时会显示对应原因。" />}{current.stream.items.length > 0 && mode === 'stream' && <details><summary>执行过程 · {current.stream.items.length} 项</summary>{current.stream.items.map(item => <p key={item.item.id}><strong>{itemNames[item.item.type] ?? item.item.type}</strong> · {item.item.status === 'completed' ? '完成' : item.item.status === 'failed' ? '失败' : '进行中'}<span>{item.item.text}</span></p>)}</details>}</div>
    <Label htmlFor={`assistant-prompt-${provider}`}>发给助手</Label><Textarea id={`assistant-prompt-${provider}`} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="描述要完成的任务…" rows={4} />
    <div className="action-row"><Button disabled={!project || !prompt.trim() || busy || mode === 'stream' && (!streamAvailable || liveSession) || mode !== 'stream' && !canSubmitJob} onClick={() => void turn.run(submit)}>{mode === 'stream' ? '发送并读取实时回答' : mode === 'single' ? '发起单次任务' : mode === 'assistant' ? '运行编排助手' : '发起线程续聊'}</Button><Button variant="outline" disabled={!turn.pending} onClick={turn.cancel}>暂停等待</Button><Button variant="outline" disabled={!current.session || turn.pending} onClick={() => void turn.run(signal => stream.pollOutput({limit: 100}, signal))}>继续读取回答</Button><Button variant="destructive" disabled={!liveSession || action.pending} onClick={() => void action.run(signal => stream.cancel(signal))}>停止本次会话</Button></div>
    <div className="action-row"><Button variant="ghost" disabled={!thread || !project || !canQuery || busy} onClick={() => void action.run(async signal => {
      if (provider === 'sdk') {await services.runtime.aiSdk.refreshOperations(signal); const result = await services.runtime.aiSdk.getThread({project_id: project, thread_id: thread}, signal); if (!signal.aborted) setThreadStatus(result.data); return result;}
      const result = await services.aiAssistant.getSession({project_id: project, thread_id: thread}, signal); if (!signal.aborted) setThreadStatus(result.data); return result;
    })}>查询线程</Button><Button variant="ghost" disabled={!thread || !project || !canClose || busy} onClick={() => void action.run(async signal => {
      if (provider === 'sdk') {await services.runtime.aiSdk.refreshOperations(signal); const result = await services.runtime.aiSdk.closeThread({project_id: project, thread_id: thread}, signal); if (!signal.aborted) setThreadStatus(result.data); return result;}
      const result = await services.aiAssistant.closeSession({project_id: project, thread_id: thread}, signal); if (!signal.aborted) setThreadStatus(result.data); return result;
    })}>关闭线程</Button><Button variant="ghost" disabled={!current.session || action.pending} onClick={() => void action.run(signal => stream.query(signal))}>查询会话状态</Button></div>
    {threadStatus && <p className="capability-notice">线程{threadStatus.closed ? '已关闭' : '开放'} · {threadStatus.turns} 轮 · {threadStatus.uncertain ? '状态存在不确定性，请重新查询' : '状态已确认'}</p>}
    <details><summary>恢复已有实时会话</summary><div className="form-row"><Field label="实时传输会话 ID" value={resumeId} onChange={setResumeId} /><Button variant="outline" disabled={!resumeId || !project || busy} onClick={() => void action.run(signal => stream.resume(resumeId, {project_id: project, ...(thread ? {thread_id: thread} : {})}, signal))}>恢复会话</Button></div>{current.records.map(item => <Button key={item.id} variant="ghost" onClick={() => setResumeId(item.id)}>{item.id.slice(0, 8)} · {item.status}</Button>)}</details>
    <p className="muted">传输会话：{current.session?.id ?? '尚未建立'} · {current.session?.status ?? '待发送'} · 回答所属项目：{current.owner?.project_id ?? '尚无'}。暂停等待不会停止服务器任务；CLI 和 SDK 各自保留草稿与线程。</p><ErrorNotice error={current.terminalError} /><ActionFeedback {...turn} /><ActionFeedback {...action} /><JsonResult value={turn.result} /><JsonResult value={action.result} />
  </div>;
}
