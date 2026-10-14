import { ApiError, normalizeSessionId } from '../../../services/api/index.ts';
import type { ApiResult, SessionGateway } from '../../../services/api/index.ts';
import { abortable } from '../../../services/api/abort.ts';
import { aiSdkStreamOperation, decodeDefinitions, decodeInfo, decodePage, decodeRecords, invalidStream, normalizeInput, normalizeOwner, pollInterval, readLimit, streamError } from '../utils/rules.ts';
import { createAiSdkStreamState } from './state.ts';
import type { AiSdkStreamRequest } from './state.ts';
import { waitForAiSdkPoll } from './polling.ts';
import type { AiSdkStreamInput, AiSdkStreamOwner, AiSdkStreamReadOptions, AiSdkStreamingOptions } from '../types/index.ts';
export type * from '../types/index.ts';
export function createAiSdkStreaming(gateway: SessionGateway, options: AiSdkStreamingOptions = {}) {
  const interval = pollInterval(options.pollIntervalMs);
  const state = createAiSdkStreamState();
  async function read(context: AiSdkStreamRequest, request: (signal: AbortSignal) => Promise<ApiResult<unknown>>) {
    state.assertCurrent(context);
    const response = await abortable(request(context.signal), context.signal);
    state.assertCurrent(context, response.logId); context.logId = response.logId;
    return response;
  }
  async function run<T>(context: AiSdkStreamRequest, action: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
    try {
      const response = await action(); state.assertCurrent(context, response.logId); state.end(context);
      return response;
    } catch (error) { const failure = streamError(error, context.logId); state.failure(context, failure); throw failure; }
  }
  function identity(context: AiSdkStreamRequest) {
    if (!context.identity) throw new ApiError('protocol', 'ai_sdk_session_not_selected', '请先打开或恢复SDK实时会话');
    return context.identity;
  }
  function assertTerminal() {
    const failure = state.snapshot().terminalError;
    if (failure) throw failure;
  }
  async function output(context: AiSdkStreamRequest, limit: number) {
    const selected = identity(context);
    const after = state.snapshot().stream.cursor;
    const response = await read(context, (requestSignal) => gateway.output(selected.id, { after, limit }, requestSignal));
    const data = decodePage(response.data, selected, after, limit, response.logId);
    const nextDecoder = state.decoder().fork();
    for (const chunk of data.chunks) nextDecoder.append(chunk, response.logId);
    state.observe(context, data.session, response.logId, nextDecoder); assertTerminal();
    return { data, logId: response.logId };
  }
  return {
    refreshDefinitions(signal: AbortSignal) {
      const context = state.begin('definitions', signal);
      return run(context, async () => {
        const response = await read(context, (requestSignal) => gateway.definitions(requestSignal));
        const data = decodeDefinitions(response.data, response.logId);
        state.update(context, { definitions: data }, response.logId);
        return { data, logId: response.logId };
      });
    },
    refreshRecords(signal: AbortSignal) {
      const context = state.begin('records', signal);
      return run(context, async () => {
        const response = await read(context, (requestSignal) => gateway.list(requestSignal));
        const data = decodeRecords(response.data, response.logId);
        state.update(context, { records: data }, response.logId);
        return { data, logId: response.logId };
      });
    },
    open(input: AiSdkStreamInput, signal: AbortSignal) {
      const copied = normalizeInput(input);
      if (!state.snapshot().definitions?.sessions.some((entry) => entry.id === aiSdkStreamOperation)) throw new ApiError('protocol', 'ai_sdk_stream_unavailable', '请先刷新真实会话目录并确认SDK实时操作可用');
      const owner = normalizeOwner(copied.thread_id === undefined ? { project_id: copied.project_id } : { project_id: copied.project_id, thread_id: copied.thread_id });
      const context = state.begin('open', signal, { owner });
      return run(context, async () => {
        const response = await read(context, (requestSignal) => gateway.open({ operation: aiSdkStreamOperation, input: copied }, requestSignal));
        const data = decodeInfo(response.data, response.logId);
        if (data.status !== 'opening' || data.output_sequence !== 0) throw invalidStream(response.logId);
        state.observe(context, data, response.logId);
        return { data, logId: response.logId };
      });
    },
    resume(id: string, owner: AiSdkStreamOwner, signal: AbortSignal) {
      const sessionId = normalizeSessionId(id); const copied = normalizeOwner(owner);
      const context = state.begin('resume', signal, { owner: copied, resumeId: sessionId });
      return run(context, async () => {
        const response = await read(context, (requestSignal) => gateway.get(sessionId, requestSignal));
        const data = decodeInfo(response.data, response.logId, context.identity ?? sessionId);
        state.observe(context, data, response.logId); assertTerminal();
        return { data, logId: response.logId };
      });
    },
    query(signal: AbortSignal) {
      const context = state.begin('query', signal); const selected = identity(context);
      return run(context, async () => {
        const response = await read(context, (requestSignal) => gateway.get(selected.id, requestSignal));
        const data = decodeInfo(response.data, response.logId, selected);
        state.observe(context, data, response.logId); assertTerminal();
        return { data, logId: response.logId };
      });
    },
    readOutput(readOptions: AiSdkStreamReadOptions, signal: AbortSignal) {
      const limit = readLimit(readOptions); const context = state.begin('output', signal);
      return run(context, () => output(context, limit));
    },
    pollOutput(readOptions: AiSdkStreamReadOptions, signal: AbortSignal) {
      const limit = readLimit(readOptions); const context = state.begin('output', signal);
      return run(context, async () => {
        while (true) {
          const response = await output(context, limit); const snapshot = state.snapshot();
          if (snapshot.result !== null) return { data: snapshot.result, logId: response.logId };
          if (snapshot.stream.cursor >= (snapshot.session?.output_sequence ?? 0)) await waitForAiSdkPoll(interval, context.signal, response.logId);
        }
      });
    },
    cancel(signal: AbortSignal) {
      const context = state.begin('cancel', signal); const selected = identity(context);
      return run(context, async () => {
        const response = await read(context, (requestSignal) => gateway.cancel(selected.id, requestSignal));
        const data = decodeInfo(response.data, response.logId, selected);
        if (data.status !== 'stopping' && data.status !== 'finished') throw invalidStream(response.logId);
        state.observe(context, data, response.logId);
        return { data, logId: response.logId };
      });
    },
    snapshot: state.snapshot,
    subscribe: state.subscribe,
    clear: state.clear,
    dispose: state.dispose,
  };
}
