import assert from 'node:assert/strict';
import test from 'node:test';
import { createInteractiveSessions } from '../src/features/interactive-sessions/index.ts';
import { terminalInput } from '../src/features/interactive-sessions/utils/terminal.ts';
import { createTerminalInputQueue, inputMessages } from '../src/pages/terminal/input-queue.ts';
import { createTerminalOutputCursor } from '../src/pages/terminal/output-cursor.ts';
import { ApiError } from '../src/services/api/index.ts';
import type { SessionGateway, SessionInfo, SessionOpenInput } from '../src/services/api/index.ts';
import { deferred } from './fixtures.ts';

const id = '12345678-1234-1234-1234-123456789abc';
const signal = () => new AbortController().signal;
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const info: SessionInfo = {
  id,
  operation: 'plugin.terminal.open',
  plugin_id: 'terminal',
  generation: 'terminal-generation',
  created_at: 1,
  status: 'opening',
  output_sequence: 0,
  completion: null,
};

function gateway(opened: SessionOpenInput[], inputs: number[][]): SessionGateway {
  return {
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
    open: async (input) => {
      opened.push(input);
      return { logId: 'open', data: info };
    },
    send: async (selected, bytes) => {
      inputs.push([...bytes]);
      return { logId: 'input', data: { id: selected, accepted: true } };
    },
    get: async () => ({ logId: 'query', data: info }),
    list: async () => ({ logId: 'list', data: [] }),
    output: async () => ({
      logId: 'output',
      data: { session: info, chunks: [], next_sequence: 0 },
    }),
    eof: async () => ({ logId: 'eof', data: { id, accepted: true } }),
    cancel: async () => ({ logId: 'cancel', data: { ...info, status: 'stopping' } }),
    release: async () => ({ logId: 'release', data: { ...info, status: 'stopping' } }),
    remove: async () => ({ logId: 'remove', data: { id } }),
  };
}

test('PTY门面发送版本、尺寸和原始控制字符，旧管道打开保持兼容', async () => {
  const opened: SessionOpenInput[] = [];
  const inputs: number[][] = [];
  const sessions = createInteractiveSessions(gateway(opened, inputs));
  await sessions.refreshDefinitions(signal());
  await sessions.openPtyTerminal('powershell', { cols: 100, rows: 25 }, signal());
  await sessions.sendTerminalInput('\u001b[A\t\u0003中文\r', signal());
  await sessions.resizeTerminal({ cols: 80, rows: 30 }, signal());
  assert.deepEqual(opened[0], {
    operation: 'plugin.terminal.open',
    input: {
      profile: 'powershell',
      terminal: { protocol: 'deviceforge.terminal.v1', cols: 100, rows: 25 },
    },
  });
  assert.deepEqual(
    inputs.map((bytes) => JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)))),
    [
      { type: 'input', text: '\u001b[A\t\u0003中文\r' },
      { type: 'resize', cols: 80, rows: 30 },
    ],
  );
  await sessions.openTerminal('powershell', signal());
  assert.deepEqual(opened[1]?.input, { profile: 'powershell' });
  sessions.dispose();
});

test('PTY尺寸、协议、未知字段及超限编码在网络调用前拒绝', async () => {
  const opened: SessionOpenInput[] = [];
  const sessions = createInteractiveSessions(gateway(opened, []));
  await sessions.refreshDefinitions(signal());
  for (const size of [
    { cols: 19, rows: 30 },
    { cols: 100, rows: 201 },
    { cols: 20.5, rows: 5 },
  ])
    assert.throws(() => sessions.openPtyTerminal('powershell', size, signal()), ApiError);
  for (const terminal of [
    { protocol: 'other', cols: 80, rows: 20 },
    { protocol: 'deviceforge.terminal.v1', cols: 80, rows: 20, extra: 1 },
    null,
  ])
    assert.throws(
      () =>
        sessions.open(
          {
            operation: 'plugin.terminal.open',
            input: {
              profile: 'powershell',
              terminal,
            },
          },
          signal(),
        ),
      ApiError,
    );
  assert.throws(() => terminalInput('\u0000'.repeat(2000)), ApiError);
  assert.equal(opened.length, 0);
  sessions.dispose();
});

test('大段中文粘贴按编码后的消息上限分块，完整保留包围粘贴控制序列', () => {
  const text = '\u001b[200~' + '中文😀\\\u0000\n'.repeat(4000) + '\u001b[201~';
  const messages = inputMessages(text);
  assert.ok(messages.length > 1);
  assert.equal(
    messages.map((message) => (message.type === 'input' ? message.text : '')).join(''),
    text,
  );
  for (const message of messages) {
    assert.ok(new TextEncoder().encode(JSON.stringify(message)).length <= 8192);
    if (message.type === 'input') assert.equal(/[\uD800-\uDFFF]/u.test(message.text), false);
  }
});

test('输入与缩放共用串行队列，等待收据且只合并连续缩放', async () => {
  const sent: unknown[] = [];
  const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
  const queue = createTerminalInputQueue(
    async (message) => {
      const gate = gates[sent.length];
      sent.push(message);
      await gate?.promise;
    },
    (error) => assert.fail(String(error)),
  );
  queue.input('a');
  queue.resize({ cols: 80, rows: 20 });
  queue.resize({ cols: 100, rows: 30 });
  queue.input('\u0003');
  assert.deepEqual(sent, [{ type: 'input', text: 'a' }]);
  gates[0]?.resolve();
  await flush();
  assert.deepEqual(sent[1], { type: 'resize', cols: 100, rows: 30 });
  gates[1]?.resolve();
  await flush();
  assert.deepEqual(sent[2], { type: 'input', text: '\u0003' });
  gates[2]?.resolve();
  await flush();
  queue.dispose();
});

test('网络结果未确认后停止队列、不重放并保留原始日志错误', async () => {
  const gate = deferred<void>();
  const error = new ApiError('network', 'uncertain', '收据失联', null, 'terminal-input-log');
  const sent: unknown[] = [];
  const failures: unknown[] = [];
  const queue = createTerminalInputQueue(
    async (message) => {
      sent.push(message);
      await gate.promise;
    },
    (failure) => failures.push(failure),
  );
  queue.input('first');
  queue.input('second');
  gate.reject(error);
  await flush();
  queue.input('third');
  assert.equal(sent.length, 1);
  assert.deepEqual(failures, [error]);
  queue.dispose();
});

test('输入容量及销毁中止在途等待并丢弃尚未发送内容', async () => {
  const failures: unknown[] = [];
  const active: AbortSignal[] = [];
  let calls = 0;
  const gate = deferred<void>();
  const queue = createTerminalInputQueue(
    async (_message, request) => {
      active.push(request);
      calls++;
      await gate.promise;
    },
    (failure) => failures.push(failure),
  );
  queue.input('first');
  queue.input('a'.repeat(256 * 1024 + 1));
  assert.equal(calls, 1);
  assert.equal(failures.length, 1);
  assert.equal(active[0]?.aborted, true);
  queue.dispose();
  gate.resolve();
  await flush();
  assert.equal(calls, 1);
});

test('输出按序号只写一次，ANSI和跨块UTF8保持原字节', () => {
  const cursor = createTerminalOutputCursor();
  const bytes = [...new TextEncoder().encode('\u001b[2J中文')];
  const chunks = [
    { sequence: 1, stream: 'stdout' as const, bytes: bytes.slice(0, 6) },
    { sequence: 2, stream: 'stdout' as const, bytes: bytes.slice(6) },
  ];
  const written: number[] = [];
  cursor.append(chunks.slice(0, 1), (chunk) => written.push(...chunk));
  cursor.append(chunks, (chunk) => written.push(...chunk));
  cursor.append(chunks, (chunk) => written.push(...chunk));
  assert.deepEqual(written, bytes);
});
