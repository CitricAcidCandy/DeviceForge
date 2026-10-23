import assert from 'node:assert/strict';
import test from 'node:test';
import { createInteractiveSessions } from '../src/features/interactive-sessions/index.ts';
import { createProductServices } from '../src/app/product/services.ts';
import { ApiError } from '../src/services/api/index.ts';
import type { SessionGateway, SessionInfo } from '../src/services/api/index.ts';
import { deferred, requestUrl, signal, success } from './fixtures.ts';

const currentId = '12345678-1234-1234-1234-123456789abc';
const oldId = '22345678-1234-1234-1234-123456789abc';
const doneId = '32345678-1234-1234-1234-123456789abc';
const otherId = '42345678-1234-1234-1234-123456789abc';
const session = (id: string, overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  operation: 'plugin.terminal.open',
  plugin_id: 'terminal',
  generation: 'terminal-generation',
  created_at: 1,
  status: 'opening',
  output_sequence: 0,
  completion: null,
  ...overrides,
});
const finished = session(doneId, {
  status: 'finished',
  completion: {
    cleanup: 'complete',
    process_exited: true,
    sequence: 1,
    outcome: null,
    failure: null,
  },
});
const other = session(otherId, { operation: 'plugin.example.open', plugin_id: 'example' });

function harness() {
  let records: SessionInfo[] = [session(oldId, { status: 'running' }), finished, other];
  const released: string[] = [];
  const removed: string[] = [];
  const activeInput = deferred<void>();
  const inputSignals: AbortSignal[] = [];
  const gateway: SessionGateway = {
    definitions: async () => ({
      logId: 'definitions',
      data: {
        revision: 1,
        sessions: [
          {
            id: 'plugin.terminal.open',
            title: '终端',
            input_schema: { type: 'object' },
            execution: { api_version: 1, source: 'declared', total_timeout_ms: 1000 },
          },
        ],
      },
    }),
    list: async () => ({ logId: 'records', data: records }),
    open: async () => ({ logId: 'open', data: session(currentId) }),
    get: async (id) => ({
      logId: 'record-detail',
      data: records.find((record) => record.id === id) ?? session(currentId),
    }),
    output: async () => ({
      logId: 'output',
      data: { session: session(currentId), chunks: [], next_sequence: 0 },
    }),
    send: async (id, _bytes, request) => {
      inputSignals.push(request);
      await activeInput.promise;
      return { logId: 'input', data: { id, accepted: true } };
    },
    release: async (id) => {
      released.push(id);
      const updated = session(id, { status: 'stopping' });
      records = records.map((record) => (record.id === id ? updated : record));
      return { logId: 'release-record', data: updated };
    },
    remove: async (id) => {
      removed.push(id);
      records = records.filter((record) => record.id !== id);
      return { logId: 'remove-record', data: { id } };
    },
    eof: async (id) => ({ logId: 'eof', data: { id, accepted: true } }),
    cancel: async (id) => ({ logId: 'cancel', data: session(id, { status: 'stopping' }) }),
  };
  return { gateway, released, removed, activeInput, inputSignals };
}

test('刷新前服务器记录可读取，关闭指定旧终端不改选或撤销当前输入', async () => {
  const testCase = harness();
  const sessions = createInteractiveSessions(testCase.gateway);
  await sessions.refreshRecords(signal());
  assert.deepEqual(
    sessions.snapshot().records.map((record) => record.id),
    [oldId, doneId, otherId],
  );
  await sessions.refreshDefinitions(signal());
  await sessions.openPtyTerminal('powershell', { cols: 80, rows: 24 }, signal());
  const sending = sessions.sendTerminalInput('codex\r', signal());
  await sessions.closeTerminalRecord(oldId, signal());
  assert.deepEqual(testCase.released, [oldId]);
  assert.equal(testCase.inputSignals[0]?.aborted, false);
  assert.equal(sessions.snapshot().session?.id, currentId);
  assert.equal(sessions.snapshot().inputState, 'writable');
  assert.equal(
    sessions.snapshot().records.find((record) => record.id === oldId)?.status,
    'stopping',
  );
  assert.equal(sessions.snapshot().logs.release_record, 'release-record');
  testCase.activeInput.resolve();
  await sending;
  await sessions.removeTerminalRecord(doneId, signal());
  assert.deepEqual(testCase.removed, [doneId]);
  assert.equal(sessions.snapshot().session?.id, currentId);
  assert.equal(
    sessions.snapshot().records.some((record) => record.id === doneId),
    false,
  );
  sessions.dispose();
});

test('记录操作先查真实归属，拒绝非终端、当前活动终端和未结束删除', async () => {
  const testCase = harness();
  const sessions = createInteractiveSessions(testCase.gateway);
  await sessions.refreshDefinitions(signal());
  await sessions.openPtyTerminal('powershell', { cols: 80, rows: 24 }, signal());
  for (const [id, remove, code] of [
    [otherId, false, 'not_terminal_record'],
    [currentId, false, 'current_terminal_record'],
    [oldId, true, 'session_not_finished'],
  ] as const)
    await assert.rejects(
      remove
        ? sessions.removeTerminalRecord(id, signal())
        : sessions.closeTerminalRecord(id, signal()),
      (error) =>
        error instanceof ApiError && error.code === code && error.logId === 'record-detail',
    );
  assert.deepEqual(testCase.released, []);
  assert.deepEqual(testCase.removed, []);
  sessions.dispose();
});

test('已选终端的释放在本地销毁前发起，clear与dispose不撤销独立信号', async () => {
  const testCase = harness();
  const gate = deferred<void>();
  const releasedSignals: AbortSignal[] = [];
  const sessions = createInteractiveSessions({
    ...testCase.gateway,
    release: async (id, request) => {
      releasedSignals.push(request);
      await gate.promise;
      return { logId: 'lifetime-release', data: session(id, { status: 'stopping' }) };
    },
  });
  await sessions.refreshDefinitions(signal());
  await sessions.openPtyTerminal('powershell', { cols: 80, rows: 24 }, signal());
  const releasing = sessions.releaseSelectedTerminal();
  assert.equal(sessions.releaseSelectedTerminal(), releasing);
  assert.equal(releasedSignals.length, 1);
  sessions.clear();
  sessions.dispose();
  assert.equal(releasedSignals[0]?.aborted, false);
  gate.resolve();
  const result = await releasing;
  assert.equal(result?.data.status, 'stopping');
  assert.equal(result?.logId, 'lifetime-release');
});

test('没有已选终端或已结束时不释放其他会话，释放失败保留日志', async () => {
  const testCase = harness();
  const sessions = createInteractiveSessions(testCase.gateway);
  assert.equal(await sessions.releaseSelectedTerminal(), null);
  await sessions.resume(otherId, signal());
  assert.equal(await sessions.releaseSelectedTerminal(), null);
  await sessions.resume(doneId, signal());
  assert.equal(await sessions.releaseSelectedTerminal(), null);
  assert.deepEqual(testCase.released, []);
  sessions.dispose();
  const failedSessions = createInteractiveSessions({
    ...testCase.gateway,
    release: async () => {
      throw new ApiError('network', 'lost_receipt', '释放收据失联', null, 'release-error-log');
    },
  });
  await failedSessions.refreshDefinitions(signal());
  await failedSessions.openPtyTerminal('powershell', { cols: 80, rows: 24 }, signal());
  await assert.rejects(
    failedSessions.releaseSelectedTerminal(),
    (error) => error instanceof ApiError && error.logId === 'release-error-log',
  );
  failedSessions.dispose();
});

test('产品销毁发起真实keepalive端点且本地销毁不撤销请求信号', async () => {
  const gate = deferred<Response>();
  const received = deferred<RequestInit>();
  let releases = 0;
  const services = createProductServices({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async (input, init) => {
      const path = requestUrl(input).pathname;
      if (path.endsWith('/session-definitions')) {
        const testCase = harness();
        return success((await testCase.gateway.definitions(signal())).data);
      }
      if (path === '/api/v2/sessions') return success(session(currentId), 'open');
      if (path.endsWith('/release')) {
        releases++;
        received.resolve(init ?? {});
        return gate.promise;
      }
      return success([]);
    },
  });
  await services.sessions.refreshDefinitions(signal());
  await services.sessions.openPtyTerminal('powershell', { cols: 80, rows: 24 }, signal());
  const closing = services.dispose();
  assert.equal(services.dispose(), closing);
  const request = await received.promise;
  assert.equal(request.keepalive, true);
  assert.equal(request.method, 'POST');
  assert.equal(request.signal?.aborted, false);
  assert.equal(services.sessions.snapshot().session, null);
  gate.resolve(success(session(currentId, { status: 'stopping' }), 'released', 202));
  await closing;
  assert.equal(releases, 1);
  assert.equal(request.signal?.aborted, false);
});
