import { ApiError, normalizeSessionId } from '../../../services/api/index.ts';
import type { ApiResult, SessionGateway, SessionOpenInput } from '../../../services/api/index.ts';
import { abortable } from '../../../services/api/abort.ts';
import {
  cloneFrozen,
  copyBytes,
  decodeDefinitions,
  decodeInfo,
  decodePage,
  decodeReceipt,
  decodeRecords,
  decodeRemoved,
  normalizeOpen,
  normalizeRead,
  pollInterval,
  sessionError,
} from '../utils/rules.ts';
import { createSessionState } from './state.ts';
import type { SessionRequest } from './state.ts';
import { waitForPoll } from './polling.ts';
import type { InteractiveSessionOptions, SessionReadOptions } from '../types/index.ts';
export type * from '../types/index.ts';
export function createInteractiveSessions(
  gateway: SessionGateway,
  options: InteractiveSessionOptions = {},
) {
  const interval = pollInterval(options.pollIntervalMs);
  const state = createSessionState();
  async function read(
    context: SessionRequest,
    request: (signal: AbortSignal) => Promise<ApiResult<unknown>>,
  ): Promise<ApiResult<unknown>> {
    state.assertCurrent(context);
    const result = await abortable(request(context.signal), context.signal);
    state.assertCurrent(context, result.logId);
    return result;
  }
  async function run<T>(
    context: SessionRequest,
    action: () => Promise<ApiResult<T>>,
  ): Promise<ApiResult<T>> {
    try {
      const result = await action();
      state.assertCurrent(context, result.logId);
      state.end(context);
      state.assertAlive(context, result.logId);
      return result;
    } catch (error) {
      const failure = sessionError(error);
      state.failure(context, failure);
      throw failure;
    }
  }
  function identity(context: SessionRequest) {
    if (!context.identity)
      throw new ApiError('protocol', 'session_not_selected', '请先打开或恢复已有会话');
    return context.identity;
  }
  function open(input: SessionOpenInput, signal: AbortSignal) {
    const copied = normalizeOpen(input, state.snapshot().definitions);
    const context = state.begin('open', signal);
    return run(context, async () => {
      const result = await read(context, (requestSignal) => gateway.open(copied, requestSignal));
      const data = decodeInfo(result.data, result.logId);
      if (
        data.operation !== copied.operation ||
        data.status !== 'opening' ||
        data.output_sequence !== 0
      )
        throw new ApiError(
          'protocol',
          'invalid_session_open',
          '打开响应未返回本次操作的Opening记录',
          null,
          result.logId,
        );
      state.update(context, { session: data, inputState: 'writable' }, result.logId);
      return { data, logId: result.logId };
    });
  }
  async function output(context: SessionRequest, limit: number) {
    const selected = identity(context);
    const query = normalizeRead({ limit }, state.snapshot().cursor);
    const result = await read(context, (requestSignal) =>
      gateway.output(selected.id, query, requestSignal),
    );
    const data = decodePage(result.data, selected, query, result.logId);
    state.observe(context, data.session, result.logId, data);
    return { data, logId: result.logId };
  }
  return {
    refreshDefinitions(signal: AbortSignal) {
      const context = state.begin('definitions', signal);
      return run(context, async () => {
        const result = await read(context, (requestSignal) => gateway.definitions(requestSignal));
        const data = decodeDefinitions(result.data, result.logId);
        state.update(context, { definitions: data }, result.logId);
        return { data, logId: result.logId };
      });
    },
    refreshRecords(signal: AbortSignal) {
      const context = state.begin('records', signal);
      return run(context, async () => {
        const result = await read(context, (requestSignal) => gateway.list(requestSignal));
        const data = decodeRecords(result.data, result.logId);
        state.update(context, { records: data }, result.logId);
        return { data, logId: result.logId };
      });
    },
    open,
    openTerminal: (profile: string, signal: AbortSignal) =>
      open({ operation: 'plugin.terminal.open', input: { profile } }, signal),
    resume(id: string, signal: AbortSignal, after = 0) {
      const sessionId = normalizeSessionId(id);
      normalizeRead({}, after);
      const context = state.begin('resume', signal);
      return run(context, async () => {
        const result = await read(context, (requestSignal) =>
          gateway.get(sessionId, requestSignal),
        );
        const data = decodeInfo(result.data, result.logId, { id: sessionId });
        if (after > data.output_sequence)
          throw new ApiError(
            'protocol',
            'invalid_session_cursor',
            '恢复游标超出会话保留输出',
            null,
            result.logId,
          );
        state.update(
          context,
          { session: data, cursor: after, inputState: 'unknown' },
          result.logId,
        );
        return { data, logId: result.logId };
      });
    },
    query(signal: AbortSignal) {
      const context = state.begin('query', signal);
      const selected = identity(context);
      return run(context, async () => {
        const result = await read(context, (requestSignal) =>
          gateway.get(selected.id, requestSignal),
        );
        const data = decodeInfo(result.data, result.logId, selected);
        state.observe(context, data, result.logId);
        return { data, logId: result.logId };
      });
    },
    readOutput(readOptions: SessionReadOptions, signal: AbortSignal) {
      const query = normalizeRead(readOptions, state.snapshot().cursor);
      const context = state.begin('output', signal);
      return run(context, () => output(context, query.limit));
    },
    pollOutput(readOptions: SessionReadOptions, signal: AbortSignal) {
      const query = normalizeRead(readOptions, state.snapshot().cursor);
      const context = state.begin('output', signal);
      return run(context, async () => {
        while (true) {
          const result = await output(context, query.limit);
          const session = state.snapshot().session ?? result.data.session;
          if (session.status === 'finished' && state.snapshot().cursor >= session.output_sequence)
            return { data: session, logId: result.logId };
          if (result.data.next_sequence >= result.data.session.output_sequence) {
            try {
              await waitForPoll(interval, context.signal);
            } catch {
              throw new ApiError(
                'cancelled',
                'cancelled',
                '输出轮询等待已取消',
                null,
                result.logId,
              );
            }
          }
        }
      });
    },
    send(bytes: readonly number[], signal: AbortSignal) {
      const copied = copyBytes(bytes);
      const context = state.begin('input', signal);
      const selected = identity(context);
      return run(context, async () => {
        const result = await read(context, (requestSignal) =>
          gateway.send(selected.id, copied, requestSignal),
        );
        const data = decodeReceipt(result.data, selected.id, result.logId);
        state.update(context, {}, result.logId);
        return { data, logId: result.logId };
      });
    },
    eof(signal: AbortSignal) {
      const context = state.begin('eof', signal);
      const selected = identity(context);
      return run(context, async () => {
        const result = await read(context, (requestSignal) =>
          gateway.eof(selected.id, requestSignal),
        );
        const data = decodeReceipt(result.data, selected.id, result.logId);
        state.update(context, { inputState: 'eof' }, result.logId);
        return { data, logId: result.logId };
      });
    },
    cancel(signal: AbortSignal) {
      const context = state.begin('cancel', signal);
      const selected = identity(context);
      return run(context, async () => {
        const result = await read(context, (requestSignal) =>
          gateway.cancel(selected.id, requestSignal),
        );
        const data = decodeInfo(result.data, result.logId, selected);
        if (data.status !== 'stopping' && data.status !== 'finished')
          throw new ApiError(
            'protocol',
            'invalid_session_cancel',
            '停止请求未返回Stopping或Finished',
            null,
            result.logId,
          );
        state.observe(context, data, result.logId);
        return { data, logId: result.logId };
      });
    },
    remove(signal: AbortSignal) {
      const context = state.begin('remove', signal);
      const selected = identity(context);
      return run(context, async () => {
        const result = await read(context, (requestSignal) =>
          gateway.remove(selected.id, requestSignal),
        );
        const data = decodeRemoved(result.data, selected.id, result.logId);
        state.update(
          context,
          {
            session: null,
            chunks: Object.freeze([]),
            cursor: 0,
            inputState: 'unknown',
            records: cloneFrozen(
              state.snapshot().records.filter((record) => record.id !== selected.id),
            ),
          },
          result.logId,
        );
        return { data, logId: result.logId };
      });
    },
    snapshot: state.snapshot,
    subscribe: state.subscribe,
    clear: state.clear,
    dispose: state.dispose,
  };
}
