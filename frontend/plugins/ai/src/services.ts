import type { HostContext, PluginTransport } from '@deviceforge/plugin-sdk';
import { abortable, ApiError } from '@deviceforge/business-kit/api';
import { createOperationSource } from '@deviceforge/business-kit/platform';
import type { JobGateway } from '@deviceforge/business-kit/jobs';
import { createAiSdk } from './model/sdk/index.ts';
import { createAiAssistant } from './model/cli/index.ts';
import { createAiSdkStreaming } from './model/sdk-stream/index.ts';
import { createAiStreaming } from './model/cli-stream/index.ts';
import { createAiJobGateway, createAiSessionGateway, readAiOperations } from './model/gateway.ts';
import { createAiOwnership } from './model/ownership.ts';
import type { AiProvider } from './model/ownership.ts';

export interface AiDraft {
  project: string;
  thread: string;
  prompt: string;
  resumeId: string;
  mode: 'stream' | 'single' | 'turn' | 'assistant';
  lastPrompt: string;
  answer: { readonly text: string; readonly thread_id: string; readonly project_id: string } | null;
  qualification: { readonly ready: boolean; readonly projects: readonly string[]; readonly reason: string | null } | null;
  threadStatus: { readonly closed: boolean; readonly uncertain: boolean; readonly turns: string } | null;
}
const draft = (): AiDraft => ({
  project: '', thread: '', prompt: '', resumeId: '', mode: 'stream', lastPrompt: '',
  answer: null, qualification: null, threadStatus: null,
});

export function createAiServices(context: HostContext, options: { pollIntervalMs?: number } = {}) {
  const transport = context.transport, registerCleanup = context.onCleanup;
  if (!transport || !registerCleanup)
    throw new Error('AI 工作区需要公开通信与有界清理能力；不会接管旧 AI 页面');
  const activeTransport = transport, activeRegisterCleanup = registerCleanup;
  const lifetime = new AbortController();
  const targets = { sdk: new AbortController(), cli: new AbortController() };
  function lease(provider: AiProvider) {
    const owner = createAiOwnership(provider);
    const release = activeRegisterCleanup(async (cleanup) => { await owner.release(cleanup); });
    return { owner, release };
  }
  const leases = { sdk: lease('sdk'), cli: lease('cli') };
  function requestFor(provider: AiProvider): Pick<PluginTransport, 'request'> {
    return {
      request(input, signal) {
        const current = AbortSignal.any([signal, context.signal, lifetime.signal, targets[provider].signal]);
        return abortable(activeTransport.request(input, current), current);
      },
    };
  }
  function jobsFor(provider: AiProvider): JobGateway {
    const gateway = createAiJobGateway(requestFor(provider));
    return {
      async submit(operation, input, signal) {
        const owner = leases[provider].owner;
        const result = await gateway.submit(operation, input, signal);
        if (result.data.operation !== operation)
          throw new ApiError('protocol', 'invalid_ai_job_owner', 'AI 任务受理回执与提交操作不匹配', null, result.logId);
        owner.recordJob(result.data, result.logId);
        return result;
      },
      async getJob(id, signal) {
        const owner = leases[provider].owner;
        const result = await gateway.getJob(id, signal);
        owner.observeJob(result.data);
        return result;
      },
      async cancelJob(id, signal) {
        const owner = leases[provider].owner;
        const result = await gateway.cancelJob(id, signal);
        owner.observeJob(result.data);
        return result;
      },
    };
  }
  function streamsFor(provider: AiProvider) {
    const gateway = createAiSessionGateway(requestFor(provider));
    return {
      ...gateway,
      async open(input: Parameters<typeof gateway.open>[0], signal: AbortSignal) {
        const owner = leases[provider].owner;
        const result = await gateway.open(input, signal);
        owner.recordStream(result.data, result.logId);
        return result;
      },
    };
  }
  const operations = createOperationSource(context);
  const targetSignal = (provider: AiProvider) =>
    () => AbortSignal.any([context.signal, lifetime.signal, targets[provider].signal]);
  const sdk = createAiSdk(jobsFor('sdk'), {
    ...options, targetSignal: targetSignal('sdk'),
    operations: { list: (signal) => readAiOperations(requestFor('sdk'), signal) },
  });
  const cli = createAiAssistant(jobsFor('cli'), { ...options, targetSignal: targetSignal('cli') });
  const sdkStreaming = createAiSdkStreaming(streamsFor('sdk'), { ...options, targetSignal: targetSignal('sdk') });
  const cliStreaming = createAiStreaming(streamsFor('cli'), { ...options, targetSignal: targetSignal('cli') });
  const releases = [
    sdkStreaming.subscribe((value) => leases.sdk.owner.observeStream(value.session)),
    cliStreaming.subscribe((value) => leases.cli.owner.observeStream(value.session)),
  ];
  function stop() {
    lifetime.abort(); targets.sdk.abort(); targets.cli.abort();
    sdk.dispose(); cli.dispose(); sdkStreaming.dispose(); cliStreaming.dispose();
    operations.dispose();
    for (const release of releases) void release();
  }
  const release = registerCleanup(stop);
  let closing: Promise<void> | null = null;
  const drafts = { sdk: draft(), cli: draft() }, selection: { provider: AiProvider } = { provider: 'sdk' };
  return {
    context, operations, sdk, cli, sdkStreaming, cliStreaming, drafts, selection,
    changeTarget(provider: AiProvider) {
      targets[provider].abort(); targets[provider] = new AbortController();
      const previous = leases[provider];
      leases[provider] = lease(provider);
      (provider === 'sdk' ? sdkStreaming : cliStreaming).clear();
      // 旧目标只回收其已确认资源，新目标不等待历史清理债务。
      void Promise.resolve(previous.release()).catch(() => undefined);
    },
    stopWatching() {
      for (const provider of ['sdk', 'cli'] satisfies AiProvider[]) {
        targets[provider].abort(); targets[provider] = new AbortController();
      }
    },
    owned: () => ({ sdk: leases.sdk.owner.snapshot(), cli: leases.cli.owner.snapshot() }),
    dispose(): Promise<void> {
      if (!closing) {
        stop();
        closing = (async () => {
          const results = await Promise.allSettled([release(), leases.sdk.release(), leases.cli.release()]);
          const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
          if (failures.length === 1) throw failures[0];
          if (failures.length) throw new AggregateError(failures, 'AI 实例自有资源回收未全部确认');
        })();
      }
      return closing;
    },
  };
}
export type AiServices = ReturnType<typeof createAiServices>;
