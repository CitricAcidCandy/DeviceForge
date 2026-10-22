import { useState } from 'react';
import { Button } from '../../../../components/Button/index.tsx';
import { Textarea } from '../../../../components/Textarea/index.tsx';
import { Label } from '../../../../components/Label/index.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../components/Select/index.tsx';
import { Field, EmptyState, JsonResult } from '../../../../components/index.ts';
import { useOperationAvailable } from '../../../../app/product/capabilities.tsx';
import { ActionFeedback, ErrorNotice } from '../../../../app/product/feedback.tsx';
import { useAction, useSnapshot } from '../../../../app/product/hooks.ts';
import type { ProductServices } from '../../../../app/product/services.ts';

type AiMode = 'stream' | 'single' | 'turn' | 'assistant';
interface Answer {
  readonly text: string;
  readonly thread_id: string;
  readonly project_id: string;
}
interface Qualification {
  readonly ready: boolean;
  readonly projects: readonly string[];
  readonly reason: string | null;
}
const itemNames: Readonly<Record<string, string>> = {
  agent_message: '回答',
  reasoning: '推理摘要',
  command_execution: '命令执行',
  file_change: '文件改动',
  mcp_tool_call: 'MCP 调用',
  web_search: '搜索',
  todo_list: '任务计划',
};

export function AiProviderPanel({
  services,
  provider,
}: {
  services: ProductServices;
  provider: 'sdk' | 'cli';
}) {
  const [project, setProject] = useState('');
  const [thread, setThread] = useState('');
  const [prompt, setPrompt] = useState('');
  const [resumeId, setResumeId] = useState('');
  const [mode, setMode] = useState<AiMode>('stream');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [qualification, setQualification] = useState<Qualification | null>(null);
  const [threadStatus, setThreadStatus] = useState<{
    closed: boolean;
    uncertain: boolean;
    turns: string;
  } | null>(null);
  const action = useAction();
  const turn = useAction();
  const stream = provider === 'sdk' ? services.runtime.aiSdkStreaming : services.aiStreaming;
  const sdkSnapshot = useSnapshot(services.runtime.aiSdkStreaming);
  const cliSnapshot = useSnapshot(services.aiStreaming);
  const current = provider === 'sdk' ? sdkSnapshot : cliSnapshot;
  const prefix = provider === 'sdk' ? 'plugin.ai-sdk.' : 'plugin.ai-assistant.';
  const canStatus = useOperationAvailable(services, prefix + 'runtime.status');
  const canQuery = useOperationAvailable(services, prefix + 'session.get');
  const canClose = useOperationAvailable(services, prefix + 'session.close');
  const canSubmitJob = useOperationAvailable(
    services,
    prefix + (mode === 'assistant' ? 'assistant.run' : `${provider}.${mode}`),
  );
  const streamAvailable =
    current.definitions?.sessions.some(
      (item) => item.id === prefix + (provider === 'sdk' ? 'sdk.stream' : 'cli.stream'),
    ) ?? false;
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
      await stream.open(
        { project_id: project, prompt, ...(thread ? { thread_id: thread } : {}) },
        signal,
      );
      const result = await stream.pollOutput({ limit: 100 }, signal);
      if (!signal.aborted) {
        setThread(result.data.thread_id);
        setAnswer(result.data);
      }
      return result;
    }
    if (provider === 'sdk') {
      await services.runtime.aiSdk.refreshOperations(signal);
      const result =
        mode === 'assistant'
          ? await services.runtime.aiSdk.runAssistant(
              { project_id: project, user_prompt: prompt, stream_output: false },
              signal,
            )
          : mode === 'single'
            ? await services.runtime.aiSdk.single({ project_id: project, prompt }, signal)
            : await services.runtime.aiSdk.turn(
                { project_id: project, prompt, ...(thread ? { thread_id: thread } : {}) },
                signal,
              );
      if (!signal.aborted) {
        setAnswer(result.data);
        setThread(result.data.thread_id);
      }
      return result;
    }
    const result =
      mode === 'single'
        ? await services.aiAssistant.single({ project_id: project, prompt }, signal)
        : await services.aiAssistant.turn(
            { project_id: project, prompt, ...(thread ? { thread_id: thread } : {}) },
            signal,
          );
    if (!signal.aborted) {
      setAnswer(result.data);
      setThread(result.data.thread_id);
    }
    return result;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2 rounded-[12px] border border-[color:var(--hairline)] bg-[color:var(--card)] p-3">
        <Field
          label="项目 ID"
          value={project}
          onChange={(value) => {
            turn.cancel();
            setProject(value);
            setThread('');
            setThreadStatus(null);
          }}
          placeholder="服务器项目白名单中的 ID"
        />
        <Field
          label="线程 ID"
          value={thread}
          onChange={(value) => {
            turn.cancel();
            setThread(value);
            setThreadStatus(null);
          }}
        />
        <div className="form-field w-40">
          <Label htmlFor={`ai-mode-${provider}`}>执行方式</Label>
          <Select
            value={mode}
            disabled={busy}
            onValueChange={(value) => {
              if (
                value === 'stream' ||
                value === 'single' ||
                value === 'turn' ||
                value === 'assistant'
              )
                setMode(value);
            }}
          >
            <SelectTrigger id={`ai-mode-${provider}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stream">实时回答</SelectItem>
              <SelectItem value="single">单次任务</SelectItem>
              <SelectItem value="turn">线程续聊任务</SelectItem>
              {provider === 'sdk' && <SelectItem value="assistant">编排助手任务</SelectItem>}
            </SelectContent>
          </Select>
        </div>
        <div className="flex-1" />
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void action.run(refresh)}>
          刷新目录
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!canStatus || busy}
          onClick={() =>
            void action.run(async (signal) => {
              if (provider === 'sdk') {
                await services.runtime.aiSdk.refreshOperations(signal);
                const result = await services.runtime.aiSdk.runtimeStatus(signal);
                if (!signal.aborted)
                  setQualification({
                    ready: result.data.ready,
                    projects: result.data.projects,
                    reason: result.data.reason,
                  });
                return result;
              }
              const result = await services.aiAssistant.runtimeStatus(signal);
              if (!signal.aborted)
                setQualification({
                  ready: result.data.configured,
                  projects: result.data.projects,
                  reason: null,
                });
              return result;
            })
          }
        >
          检查配置
        </Button>
      </div>

      {qualification && (
        <p className="flex flex-wrap items-center gap-2 px-1 text-[13px] text-[color:var(--text-muted)]">
          <span
            className={
              qualification.ready
                ? 'text-[color:var(--success)]'
                : 'text-[color:var(--warning)]'
            }
          >
            ● {qualification.ready ? '运行资格就绪' : '运行资格未就绪'}
          </span>
          <span>{qualification.reason ?? '项目由服务器部署配置提供'}</span>
          <span className="font-mono text-[12px] text-[color:var(--text-faint)]">
            可用项目：{qualification.projects.join('、') || '无'}
          </span>
        </p>
      )}

      <div
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto rounded-[12px] border border-[color:var(--hairline)] bg-[color:var(--card)] px-4 py-3"
        role="log"
        aria-label={`${provider} 助手回答`}
      >
        {mode === 'stream' && current.stream.text ? (
          <p className="whitespace-pre-wrap text-[14px] leading-[1.75] text-[color:var(--text-body)]">
            {current.stream.text}
          </p>
        ) : answer ? (
          <>
            <p className="font-mono text-[12px] text-[color:var(--text-faint)]">
              {answer.project_id} · 线程 {answer.thread_id}
            </p>
            <p className="whitespace-pre-wrap text-[14px] leading-[1.75] text-[color:var(--text-body)]">
              {answer.text}
            </p>
          </>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-[13px] text-[color:var(--text-faint)]">输入问题开始对话</p>
          </div>
        )}
        {current.stream.items.length > 0 && mode === 'stream' && (
          <details className="mt-auto">
            <summary className="text-[12px] text-[color:var(--text-muted)]">
              执行过程 · {current.stream.items.length} 项
            </summary>
            <ul className="flex flex-col gap-1 pt-2 text-[13px] text-[color:var(--text-muted)]">
              {current.stream.items.map((item) => (
                <li key={item.item.id} className="flex gap-2">
                  <span className="text-[color:var(--text-faint)]">
                    {itemNames[item.item.type] ?? item.item.type}
                  </span>
                  <span>
                    {item.item.status === 'completed'
                      ? '完成'
                      : item.item.status === 'failed'
                        ? '失败'
                        : '进行中'}
                  </span>
                  <span className="truncate">{item.item.text}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-2 rounded-[12px] border border-[color:var(--hairline)] bg-[color:var(--card)] p-3">
        <Label htmlFor={`assistant-prompt-${provider}`} className="sr-only">
          发给助手
        </Label>
        <textarea
          id={`assistant-prompt-${provider}`}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="描述要完成的任务…"
          rows={3}
          className="w-full resize-none rounded-md bg-transparent text-[14px] leading-[1.7] text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-ghost)]"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={
              !project ||
              !prompt.trim() ||
              busy ||
              (mode === 'stream' && (!streamAvailable || liveSession)) ||
              (mode !== 'stream' && !canSubmitJob)
            }
            onClick={() => void turn.run(submit)}
          >
            {mode === 'stream'
              ? '发送'
              : mode === 'single'
                ? '发起单次任务'
                : mode === 'assistant'
                  ? '运行编排助手'
                  : '发起线程续聊'}
          </Button>
          <Button size="sm" variant="ghost" disabled={!turn.pending} onClick={turn.cancel}>
            暂停等待
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!current.session || turn.pending}
            onClick={() => void turn.run((signal) => stream.pollOutput({ limit: 100 }, signal))}
          >
            继续读取
          </Button>
          <div className="flex-1" />
          <span className="font-mono text-[12px] text-[color:var(--text-ghost)]">
            {current.session?.id ?? '未建立会话'} · {current.session?.status ?? '待发送'}
          </span>
          <Button
            size="sm"
            variant="destructive"
            disabled={!liveSession || action.pending}
            onClick={() => void action.run((signal) => stream.cancel(signal))}
          >
            停止本次会话
          </Button>
        </div>
      </div>

      <details className="shrink-0 rounded-[12px] border border-[color:var(--hairline)] bg-[color:var(--card)] px-4 py-2">
        <summary className="text-[12px] text-[color:var(--text-muted)]">线程与会话管理</summary>
        <div className="flex flex-col gap-2 pt-3">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={!thread || !project || !canQuery || busy}
              onClick={() =>
                void action.run(async (signal) => {
                  if (provider === 'sdk') {
                    await services.runtime.aiSdk.refreshOperations(signal);
                    const result = await services.runtime.aiSdk.getThread(
                      { project_id: project, thread_id: thread },
                      signal,
                    );
                    if (!signal.aborted) setThreadStatus(result.data);
                    return result;
                  }
                  const result = await services.aiAssistant.getSession(
                    { project_id: project, thread_id: thread },
                    signal,
                  );
                  if (!signal.aborted) setThreadStatus(result.data);
                  return result;
                })
              }
            >
              查询线程
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!thread || !project || !canClose || busy}
              onClick={() =>
                void action.run(async (signal) => {
                  if (provider === 'sdk') {
                    await services.runtime.aiSdk.refreshOperations(signal);
                    const result = await services.runtime.aiSdk.closeThread(
                      { project_id: project, thread_id: thread },
                      signal,
                    );
                    if (!signal.aborted) setThreadStatus(result.data);
                    return result;
                  }
                  const result = await services.aiAssistant.closeSession(
                    { project_id: project, thread_id: thread },
                    signal,
                  );
                  if (!signal.aborted) setThreadStatus(result.data);
                  return result;
                })
              }
            >
              关闭线程
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!current.session || action.pending}
              onClick={() => void action.run((signal) => stream.query(signal))}
            >
              查询会话状态
            </Button>
          </div>
          {threadStatus && (
            <p className="text-[12px] text-[color:var(--text-muted)]">
              线程{threadStatus.closed ? '已关闭' : '开放'} · {threadStatus.turns} 轮 ·{' '}
              {threadStatus.uncertain ? '状态存在不确定性，请重新查询' : '状态已确认'}
            </p>
          )}
          <details>
            <summary className="text-[12px] text-[color:var(--text-muted)]">恢复已有实时会话</summary>
            <div className="flex flex-wrap items-end gap-2 pt-2">
              <Field label="实时传输会话 ID" value={resumeId} onChange={setResumeId} />
              <Button
                size="sm"
                variant="outline"
                disabled={!resumeId || !project || busy}
                onClick={() =>
                  void action.run((signal) =>
                    stream.resume(
                      resumeId,
                      { project_id: project, ...(thread ? { thread_id: thread } : {}) },
                      signal,
                    ),
                  )
                }
              >
                恢复会话
              </Button>
            </div>
            {current.records.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-2">
                {current.records.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setResumeId(item.id)}
                    className="rounded px-2 py-1 font-mono text-[12px] text-[color:var(--text-muted)] hover:bg-[color:var(--surface-hover)]"
                  >
                    {item.id.slice(0, 8)} · {item.status}
                  </button>
                ))}
              </div>
            )}
          </details>
        </div>
      </details>

      <ErrorNotice error={current.terminalError} />
      <ActionFeedback {...turn} />
      <ActionFeedback {...action} />
      <details className="text-[12px] text-[color:var(--text-ghost)]">
        <summary>原始结果</summary>
        <JsonResult value={turn.result} />
        <JsonResult value={action.result} />
      </details>
    </div>
  );
}
