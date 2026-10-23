import { useState } from 'react';
import { SlidersHorizontalIcon } from 'lucide-react';
import { EmptyState, JsonResult } from '../../../../components/index.ts';
import { ErrorNotice, ActionFeedback } from '../../../../app/product/feedback.tsx';
import { useAction, useSnapshot } from '../../../../app/product/hooks.ts';
import { useOperationAvailable } from '../../../../app/product/capabilities.tsx';
import { cn } from '../../../../utils/classnames.ts';
import type { ProductServices } from '../../../../app/product/services.ts';
import { SessionList } from '../SessionList/index.tsx';
import { PromptComposer } from '../PromptComposer/index.tsx';
import { AiSettingsSheet } from '../AiSettingsSheet/index.tsx';
import type {
  AiMode,
  QualificationView,
  ThreadStatusView,
} from '../AiSettingsSheet/index.tsx';

interface Answer {
  readonly text: string;
  readonly thread_id: string;
  readonly project_id: string;
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

/**
 * AI 助手主面板：左侧会话栏、中间会话流、设置收进右侧抽屉。
 * 配置与线程操作不再常驻，主区只保留"当前在干什么"。
 */
export function AiProviderPanel({
  services,
  provider,
  onProviderChange,
}: {
  services: ProductServices;
  provider: 'sdk' | 'cli';
  onProviderChange: (value: 'sdk' | 'cli') => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [project, setProject] = useState('');
  const [thread, setThread] = useState('');
  const [prompt, setPrompt] = useState('');
  const [resumeId, setResumeId] = useState('');
  const [mode, setMode] = useState<AiMode>('stream');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [lastPrompt, setLastPrompt] = useState('');
  const [qualification, setQualification] = useState<QualificationView | null>(null);
  const [threadStatus, setThreadStatus] = useState<ThreadStatusView | null>(null);
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
  const streamText = mode === 'stream' ? (current.stream.text ?? '') : '';
  const answerText = streamText || answer?.text || '';
  const items = mode === 'stream' ? current.stream.items : [];
  const threadLabel = thread || project || '新会话';
  const statusLabel = liveSession
    ? '运行中'
    : answerText
      ? '已完成'
      : current.session
        ? String(current.session.status)
        : '待发送';
  const statusTone = liveSession
    ? 'text-[color:var(--primary)]'
    : answerText
      ? 'text-[color:var(--success)]'
      : 'text-[color:var(--text-faint)]';

  async function refresh(signal: AbortSignal) {
    await services.runtime.operations.refresh(signal);
    if (provider === 'sdk') await services.runtime.aiSdk.refreshOperations(signal);
    await stream.refreshDefinitions(signal);
    return stream.refreshRecords(signal);
  }
  async function submit(signal: AbortSignal) {
    setLastPrompt(prompt);
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
  function resetConversation() {
    turn.cancel();
    setThread('');
    setAnswer(null);
    setLastPrompt('');
    setResumeId('');
    setThreadStatus(null);
  }
  const submitLabel =
    mode === 'stream'
      ? '发送'
      : mode === 'single'
        ? '发起单次任务'
        : mode === 'assistant'
          ? '运行编排助手'
          : '发起线程续聊';
  const canSubmit =
    Boolean(project) &&
    Boolean(prompt.trim()) &&
    !busy &&
    (mode === 'stream' ? streamAvailable && !liveSession : canSubmitJob);

  return (
    <div className="flex min-h-0 flex-1">
      <SessionList
        items={current.records}
        selectedId={resumeId}
        onSelect={setResumeId}
        onCreate={resetConversation}
      />
      <div className="flex min-h-0 flex-1 flex-col bg-[color:var(--card)]">
        <header className="flex shrink-0 items-center justify-between gap-3 px-7 pb-3.5 pt-4">
          <h1 className="min-w-0 truncate text-[17px] font-semibold text-[color:var(--text-strong)]">
            {threadLabel}
          </h1>
          <div className="flex shrink-0 items-center gap-2">
            <span
              className={cn(
                'flex h-6 items-center gap-1.5 rounded-[5px] bg-[color:var(--accent)] px-2 text-[11px] font-medium',
                statusTone,
              )}
            >
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  liveSession
                    ? 'bg-[color:var(--primary)]'
                    : answerText
                      ? 'bg-[color:var(--success)]'
                      : 'bg-[color:var(--text-ghost)]',
                )}
                aria-hidden="true"
              />
              {statusLabel}
            </span>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="打开对话设置"
              className="flex size-7 items-center justify-center rounded-[5px] bg-[color:var(--surface-sunken)] text-[color:var(--text-body)] transition-colors hover:bg-[color:var(--surface-hover)]"
            >
              <SlidersHorizontalIcon className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        </header>
        <div className="h-px shrink-0 bg-[color:var(--hairline)]" aria-hidden="true" />

        <div
          className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-7 py-4"
          role="log"
          aria-label={`${provider} 助手回答`}
        >
          {lastPrompt && (
            <div className="flex justify-end">
              <p className="max-w-[36rem] whitespace-pre-wrap rounded-[10px] bg-[color:var(--surface-sunken)] px-3.5 py-2.5 text-[14px] leading-[1.6] text-[color:var(--text-strong)]">
                {lastPrompt}
              </p>
            </div>
          )}
          {answerText ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'size-1.5 rounded-full',
                    liveSession ? 'bg-[color:var(--primary)]' : 'bg-[color:var(--success)]',
                  )}
                  aria-hidden="true"
                />
                <span className="font-mono text-[11px] font-medium tracking-[0.06em] text-[color:var(--text-faint)]">
                  {provider === 'sdk' ? 'CODEX SDK' : 'CODEX CLI'}
                </span>
                <span className="font-mono text-[11px] text-[color:var(--text-ghost)]">
                  {statusLabel}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-[14px] leading-[1.75] text-[color:var(--text-body)]">
                {answerText}
              </p>
              {items.length > 0 && (
                <div className="flex flex-col gap-1 pt-1">
                  {items.map((item) => (
                    <div
                      key={item.item.id}
                      className="flex items-center justify-between gap-3 rounded-[6px] bg-[color:var(--accent)] px-2.5 py-2"
                    >
                      <span className="truncate font-mono text-[12px] text-[color:var(--primary)]">
                        {itemNames[item.item.type] ?? item.item.type} · {item.item.text}
                      </span>
                      <span
                        className={cn(
                          'shrink-0 font-mono text-[11px]',
                          item.item.status === 'failed'
                            ? 'text-[color:var(--destructive)]'
                            : item.item.status === 'completed'
                              ? 'text-[color:var(--success)]'
                              : 'text-[color:var(--warning)]',
                        )}
                      >
                        {item.item.status === 'completed'
                          ? '完成'
                          : item.item.status === 'failed'
                            ? '失败'
                            : '进行中'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : items.length === 0 ? (
            <div className="flex min-h-[12rem] flex-1 items-center justify-center">
              <EmptyState
                title="还没有对话"
                description="在下面描述要完成的任务，或用右侧对话设置调整连接方式。"
              />
            </div>
          ) : null}
        </div>

        <PromptComposer
          id={`assistant-prompt-${provider}`}
          value={prompt}
          placeholder="描述要完成的任务…"
          submitLabel={submitLabel}
          pending={busy}
          canSubmit={canSubmit}
          canCancel={liveSession && !action.pending}
          sessionLabel={`${current.session?.id ?? '未建立会话'} · ${current.session?.status ?? '待发送'}`}
          actions={[
            {
              label: '检查配置',
              disabled: !canStatus || busy,
              onClick: () =>
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
                }),
            },
            {
              label: '刷新目录',
              disabled: busy,
              onClick: () => void action.run(refresh),
            },
            {
              label: '新建会话',
              disabled: busy,
              onClick: resetConversation,
            },
          ]}
          onChange={setPrompt}
          onSubmit={() => void turn.run(submit)}
          onCancel={() => void action.run((signal) => stream.cancel(signal))}
        />

        <div className="px-7 pb-3">
          <ErrorNotice error={current.terminalError} />
          <ActionFeedback {...turn} />
          <ActionFeedback {...action} />
          <details className="text-[12px] text-[color:var(--text-ghost)]">
            <summary className="cursor-pointer">原始结果</summary>
            <JsonResult value={turn.result} />
            <JsonResult value={action.result} />
          </details>
        </div>
      </div>

      <AiSettingsSheet
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        provider={provider}
        onProviderChange={onProviderChange}
        mode={mode}
        onModeChange={(value) => {
          turn.cancel();
          setMode(value);
        }}
        project={project}
        onProjectChange={(value) => {
          turn.cancel();
          setProject(value);
          setThread('');
          setThreadStatus(null);
        }}
        thread={thread}
        onThreadChange={(value) => {
          turn.cancel();
          setThread(value);
          setThreadStatus(null);
        }}
        resumeId={resumeId}
        onResumeIdChange={setResumeId}
        busy={busy}
        canStatus={canStatus}
        canQuery={canQuery}
        canClose={canClose}
        qualification={qualification}
        threadStatus={threadStatus}
        records={current.records}
        onRefresh={() => void action.run(refresh)}
        onCheckStatus={() =>
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
        onQueryThread={() =>
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
        onCloseThread={() =>
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
        onResume={() =>
          void action.run((signal) =>
            stream.resume(
              resumeId,
              { project_id: project, ...(thread ? { thread_id: thread } : {}) },
              signal,
            ),
          )
        }
        onQuerySession={() => void action.run((signal) => stream.query(signal))}
        hasSession={Boolean(current.session)}
      />
    </div>
  );
}
