import assert from 'node:assert/strict';
import test from 'node:test';
import { createMsgpack } from '../src/features/msgpack/index.ts';
import type { MsgpackFilter } from '../src/features/msgpack/index.ts';
import { ApiError } from '../src/services/api/index.ts';
import type { ApiResult } from '../src/services/api/index.ts';
import { JobWaitFailure } from '../src/shared/jobs/index.ts';
import type { JobGateway, JsonData, TaskRecord } from '../src/shared/jobs/index.ts';
import { deferred, signal } from './fixtures.ts';

const source = '12345678-1234-1234-1234-123456789abc';
const published = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
function artifact(filename = 'converted.msgpack', size = 2, sha256 = 'a'.repeat(64)) {
  return { id: published, filename, media_type: filename.endsWith('.json') ? 'application/json' : 'application/msgpack', size, sha256, created_at: 1 };
}
function converted(filename = 'converted.msgpack', size = 2, sha256 = 'a'.repeat(64)): JsonData {
  return { result: { format_version: 1, source_artifact_id: source, filename, size }, artifacts: [artifact(filename, size, sha256)] };
}
function page(overrides: Record<string, JsonData> = {}): JsonData {
  return { result: { format_version: 1, source_artifact_id: source, total: 4, matched: 3, offset: 1, records: [{ id: 2 }], next_offset: 2, ...overrides }, artifacts: [] };
}
function gateway(respond: (operation: string, input: JsonData) => JsonData): JobGateway {
  return {
    submit: async (operation, input) => ({ data: { id: 'msgpack-job', operation, status: 'succeeded', result: respond(operation, input), error: null }, logId: 'submit-log' }),
    getJob: async () => { throw new Error('已完成任务不得重查'); },
    cancelJob: async () => { throw new Error('等待取消不得发服务端取消'); },
  };
}

test('编解码仅提交规范产物ID，接受唯一宿主产物并保留来源和日志', async () => {
  const seen: { operation: string; input: JsonData }[] = [];
  const msgpack = createMsgpack(gateway((operation, input) => { seen.push({ operation, input }); return converted(operation.endsWith('.decode') ? 'converted.json' : 'converted.msgpack'); }));
  assert.equal((await msgpack.encode({ artifact_id: source.toUpperCase() }, signal())).data.result.filename, 'converted.msgpack');
  const decoded = await msgpack.decode({ artifact_id: source }, signal());
  assert.equal(decoded.data.artifacts[0]?.media_type, 'application/json');
  assert.equal(decoded.submitLogId, 'submit-log');
  assert.deepEqual(seen, [
    { operation: 'plugin.msgpack.encode', input: { artifact_id: source } },
    { operation: 'plugin.msgpack.decode', input: { artifact_id: source } },
  ]);
  msgpack.dispose();
});

test('分页和四种筛选沿公开操作发送，字段中的点号保持单层文本', async () => {
  const seen: JsonData[] = [];
  const msgpack = createMsgpack(gateway((_operation, input) => { seen.push(input); return page(); }));
  const filters: MsgpackFilter[] = [
    { field: 'name.part', operator: 'equals', value: null },
    { field: 'name', operator: 'contains', value: ' 设备 ' },
    { field: 'size', operator: 'greater', value: 1.5 },
    { field: 'size', operator: 'less', value: 0 },
  ];
  for (const filter of filters) {
    const result = await msgpack.page({ artifact_id: source, offset: 1, limit: 1, filter }, signal());
    assert.equal(result.data.next_offset, 2);
  }
  assert.deepEqual(seen[0], { artifact_id: source, offset: 1, limit: 1, filter: { field: 'name.part', operator: 'equals', value: null } });
  msgpack.dispose();
});

test('默认分页与匹配末尾空页合法，按ID读取保留重复匹配数', async () => {
  const seen: JsonData[] = [];
  const msgpack = createMsgpack(gateway((_operation, input) => {
    seen.push(input);
    return seen.length === 1 ? page({ offset: 0, records: [{ id: 1 }, { id: 2 }, { id: 3 }], next_offset: null })
      : seen.length === 2 ? page({ offset: 3, records: [], next_offset: null })
        : page({ offset: 0, matched: 2, records: [{ id: 'same' }], next_offset: 1 });
  }));
  assert.equal((await msgpack.page({ artifact_id: source }, signal())).data.records.length, 3);
  assert.equal((await msgpack.page({ artifact_id: source, offset: 3 }, signal())).data.records.length, 0);
  assert.equal((await msgpack.byId({ artifact_id: source, id: 'same' }, signal())).data.matched, 2);
  assert.deepEqual(seen[2], { artifact_id: source, offset: 0, limit: 1, filter: { field: 'id', operator: 'equals', value: 'same' } });
  msgpack.dispose();
});

test('非法产物身份、额外路径、分页越界和非JSON数据在提交前拒绝', () => {
  let submits = 0;
  const msgpack = createMsgpack(gateway(() => { submits++; return page(); }));
  assert.throws(() => msgpack.encode({ artifact_id: 'C:/data/input.json' }, signal()), ApiError);
  const input = { artifact_id: source, output_path: 'C:/secret' };
  assert.throws(() => msgpack.decode(input, signal()), ApiError);
  for (const offset of [-1, 0.5, 100001, NaN]) assert.throws(() => msgpack.page({ artifact_id: source, offset }, signal()), ApiError);
  for (const limit of [0, 101, 1.5, Infinity]) assert.throws(() => msgpack.page({ artifact_id: source, limit }, signal()), ApiError);
  assert.throws(() => msgpack.byId({ artifact_id: source, id: Number.MAX_SAFE_INTEGER + 1 }, signal()), ApiError);
  assert.throws(() => msgpack.page({ artifact_id: source, filter: { field: 'value', operator: 'equals', value: { broken: NaN } } }, signal()), ApiError);
  assert.equal(submits, 0);
  msgpack.dispose();
});

test('UTF-8筛选字段恰好100字节可用，超限和控制字符拒绝', async () => {
  const msgpack = createMsgpack(gateway(() => page({ offset: 0, records: [{ id: 1 }, { id: 2 }, { id: 3 }], next_offset: null })));
  const field = '中'.repeat(33) + 'a';
  await msgpack.page({ artifact_id: source, filter: { field, operator: 'equals', value: null } }, signal());
  for (const name of ['', field + 'a', 'id\n', 'id\u0085']) assert.throws(() => msgpack.page({ artifact_id: source, filter: { field: name, operator: 'equals', value: null } }, signal()), ApiError);
  msgpack.dispose();
});

test('来源、固定文件名、媒体类型、产物数量或大小不一致拒绝且保留日志', async () => {
  const result = { format_version: 1, source_artifact_id: source, filename: 'converted.msgpack', size: 2 };
  const malformed: JsonData[] = [
    { result: { ...result, source_artifact_id: published }, artifacts: [artifact()] },
    { result: { ...result, filename: 'converted.json' }, artifacts: [artifact('converted.json')] },
    { result: { ...result, size: 3 }, artifacts: [artifact()] },
    { result, artifacts: [] }, { result, artifacts: [artifact(), artifact()] },
    { result, artifacts: [{ ...artifact(), media_type: 'application/octet-stream' }] },
    { result: { ...result, size: 16 * 1024 * 1024 + 1 }, artifacts: [artifact('converted.msgpack', 16 * 1024 * 1024 + 1)] },
  ];
  for (const value of malformed) {
    const msgpack = createMsgpack(gateway(() => value));
    await assert.rejects(msgpack.encode({ artifact_id: source }, signal()), (error: unknown) => error instanceof ApiError && error.logId === 'submit-log');
    msgpack.dispose();
  }
});

test('分页来源、数量、偏移和下一页几何不一致不能作为成功结果', async () => {
  for (const changes of [
    { source_artifact_id: published }, { offset: 0 }, { total: 2 }, { matched: 5 },
    { offset: 4 }, { records: [] }, { records: [{ id: 1 }, { id: 2 }] },
    { next_offset: 3 }, { next_offset: null }, { total: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const msgpack = createMsgpack(gateway(() => page(changes)));
    await assert.rejects(msgpack.page({ artifact_id: source, offset: 1, limit: 1 }, signal()), (error: unknown) => error instanceof ApiError && error.logId === 'submit-log');
    msgpack.dispose();
  }
  const forbidden = createMsgpack(gateway(() => ({ result: { format_version: 1, source_artifact_id: source, total: 0, matched: 0, offset: 0, records: [], next_offset: null }, artifacts: [artifact()] })));
  await assert.rejects(forbidden.page({ artifact_id: source }, signal()), ApiError);
  forbidden.dispose();
});

test('分页接受原始JSON记录和安全整数边界，宽整数结果明确拒绝', async () => {
  const records: JsonData[] = [null, { exact: Number.MAX_SAFE_INTEGER, negative: Number.MIN_SAFE_INTEGER, fraction: 1.5 }, '记录'];
  const msgpack = createMsgpack(gateway(() => page({ offset: 0, records, next_offset: null })));
  assert.deepEqual((await msgpack.page({ artifact_id: source }, signal())).data.records, records);
  msgpack.dispose();
  for (const value of [Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1]) {
    const invalid = createMsgpack(gateway(() => page({ records: [{ nested: [value] }] })));
    await assert.rejects(invalid.page({ artifact_id: source, offset: 1, limit: 1 }, signal()), ApiError);
    invalid.dispose();
  }
});

test('分页输入建立副本，调用者修改筛选值或偏移不改在途请求', async () => {
  const entered = deferred<void>();
  const gate = deferred<void>();
  let submitted: JsonData | undefined;
  const msgpack = createMsgpack({ ...gateway(() => page()), submit: async (operation, input) => {
    submitted = input; entered.resolve(); await gate.promise;
    return { data: { id: 'msgpack-job', operation, status: 'succeeded', result: page(), error: null }, logId: 'input-copy-log' };
  } });
  const filter: { field: string; operator: 'equals'; value: JsonData } = { field: 'id', operator: 'equals', value: { nested: [1] } };
  const input = { artifact_id: source, offset: 1, limit: 1, filter };
  const waiting = msgpack.page(input, signal());
  await entered.promise;
  input.offset = 9;
  filter.value = 'changed';
  assert.deepEqual(submitted, { artifact_id: source, offset: 1, limit: 1, filter: { field: 'id', operator: 'equals', value: { nested: [1] } } });
  gate.resolve();
  assert.equal((await waiting).data.offset, 1);
  msgpack.dispose();
});

test('取消查询等待可恢复原Job，不重发且晚到结果不交付', async () => {
  const entered = deferred<void>();
  const blocked = deferred<ApiResult<TaskRecord>>();
  let submits = 0;
  let recovered = false;
  const operation = 'plugin.msgpack.query';
  const terminal: ApiResult<TaskRecord> = { data: { id: 'msgpack-job', operation, status: 'succeeded', result: page(), error: null }, logId: 'query-log' };
  const msgpack = createMsgpack({ ...gateway(() => page()),
    submit: async () => { submits++; return { data: { id: 'msgpack-job', operation, status: 'running', result: null, error: null }, logId: 'submit-log' }; },
    getJob: async () => { entered.resolve(); return recovered ? terminal : blocked.promise; },
  }, { pollIntervalMs: 0 });
  const input = { artifact_id: source, offset: 1, limit: 1 };
  const controller = new AbortController();
  const waiting = msgpack.page(input, controller.signal);
  const rejected = assert.rejects(waiting, (error: unknown) => error instanceof JobWaitFailure && error.job.id === 'msgpack-job' && error.submitLogId === 'submit-log');
  await entered.promise;
  controller.abort();
  await rejected;
  recovered = true;
  const ticket = { id: 'msgpack-job', operation, submitLogId: 'submit-log' };
  assert.equal((await msgpack.queryJob(ticket, signal())).data.status, 'succeeded');
  assert.equal((await msgpack.resumePage(ticket, input, signal())).logId, 'query-log');
  blocked.resolve(terminal);
  assert.equal(submits, 1);
  msgpack.dispose();
});

test('三操作恢复只读原任务，错误操作票据不能查询或取消', async () => {
  let submits = 0;
  let cancels = 0;
  const msgpack = createMsgpack({ ...gateway(() => { submits++; return converted(); }),
    getJob: async (id) => ({ data: { id, operation: `plugin.msgpack.${id}`, status: 'succeeded', error: null, result: id === 'query' ? page({ offset: 0, matched: 2, records: [{ id: 1 }], next_offset: 1 }) : converted(id === 'decode' ? 'converted.json' : 'converted.msgpack') }, logId: 'resume-log' }),
    cancelJob: async (id) => { cancels++; return { data: { id, operation: 'plugin.msgpack.encode', status: 'succeeded', result: converted(), error: null }, logId: 'cancel-log' }; },
  });
  const ticket = (action: string) => ({ id: action, operation: `plugin.msgpack.${action}`, submitLogId: 'old-submit-log' });
  await msgpack.resumeEncode(ticket('encode'), { artifact_id: source }, signal());
  await msgpack.resumeDecode(ticket('decode'), { artifact_id: source }, signal());
  assert.equal((await msgpack.resumeById(ticket('query'), { artifact_id: source, id: 1 }, signal())).data.matched, 2);
  assert.equal((await msgpack.cancel(ticket('encode'), signal())).data.status, 'succeeded');
  assert.equal(cancels, 1);
  assert.equal(submits, 0);
  const foreign = { ...ticket('encode'), operation: 'plugin.settings.get' };
  assert.throws(() => msgpack.queryJob(foreign, signal()), ApiError);
  assert.throws(() => msgpack.cancel(foreign, signal()), ApiError);
  assert.throws(() => msgpack.resumeDecode(ticket('encode'), { artifact_id: source }, signal()), ApiError);
  msgpack.dispose();
});

test('下载保留原字节并核对宿主大小摘要，不解析JSON或宽整数', async () => {
  const bytes = new TextEncoder().encode('{"integer":18446744073709551615}');
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const seen: string[] = [];
  const msgpack = createMsgpack(gateway(() => converted('converted.json', bytes.length, digest)), {}, { download: async (id) => { seen.push(id); return { data: new Blob([bytes]), logId: 'download-log' }; } });
  const output = await msgpack.decode({ artifact_id: source }, signal());
  const downloaded = await msgpack.download(output.data, signal());
  assert.deepEqual(new Uint8Array(await downloaded.data.arrayBuffer()), bytes);
  assert.equal(downloaded.logId, 'download-log');
  assert.deepEqual(seen, [published]);
  msgpack.dispose();
});

test('下载缺能力或摘要不符失败，销毁撤销忽略信号的在途下载', async () => {
  const plain = createMsgpack(gateway(() => converted()));
  const output = await plain.encode({ artifact_id: source }, signal());
  assert.throws(() => plain.download(output.data, signal()), ApiError);
  plain.dispose();
  const wrong = createMsgpack(gateway(() => converted()), {}, { download: async () => ({ data: new Blob([new Uint8Array([1, 2])]), logId: 'wrong-bytes-log' }) });
  await assert.rejects(wrong.download(output.data, signal()), (error: unknown) => error instanceof ApiError && error.code === 'artifact_digest_mismatch' && error.logId === 'wrong-bytes-log');
  wrong.dispose();
  const entered = deferred<void>();
  const blocked = deferred<ApiResult<Blob>>();
  const closing = createMsgpack(gateway(() => converted()), {}, { download: async () => { entered.resolve(); return blocked.promise; } });
  const waiting = closing.download(output.data, signal());
  const rejected = assert.rejects(waiting, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
  await entered.promise;
  closing.dispose();
  await rejected;
  blocked.resolve({ data: new Blob([new Uint8Array([1, 2])]), logId: 'late-download-log' });
});
