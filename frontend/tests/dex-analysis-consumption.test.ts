import assert from 'node:assert/strict';
import test from 'node:test';
import { createDexAnalysis, createHttpDexAnalysis } from '../src/features/dex-analysis/index.ts';
import type { DexOperationReader, DexScanInput } from '../src/features/dex-analysis/index.ts';
import { ApiError, createApiClient } from '../src/services/api/index.ts';
import { JobWaitFailure } from '../src/shared/jobs/index.ts';
import type { ApiResult, OperationDto } from '../src/services/api/index.ts';
import type { JobGateway, TaskRecord } from '../src/shared/jobs/index.ts';
import { deferred, requestUrl, signal, success } from './fixtures.ts';

const artifact = '12345678-1234-1234-1234-123456789abc';
const other = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const inspectOperation = 'plugin.dex-analysis.inspect';
const scanOperation = 'plugin.dex-analysis.scan_sdks';
const rule = { name: '示例SDK', package_path: 'com.example.sdk', class_name: 'Entry$Inner' };
function result(changes: Record<string, unknown> = {}) {
  return {
    artifact_id: artifact,
    version: '040',
    file_size: 512,
    counts: { strings: 8, types: 5, prototypes: 1, fields: 2, methods: 3, defined_classes: 4 },
    integrity: { artifact_sha256: true, dex_sha1: true, dex_adler32: true },
    ...changes,
  };
}
function scanResult(changes: Record<string, unknown> = {}) {
  return result({
    findings: [
      { rule, package_found: true, class_found: true, evidence: ['com/example/sdk/Entry$Inner'] },
    ],
    ...changes,
  });
}
function completed(operation = inspectOperation, value: unknown = result()): TaskRecord {
  return {
    id: 'dex-job',
    operation,
    status: 'succeeded',
    result: { result: value, artifacts: [] },
    error: null,
  };
}
function gateway(changes: Partial<JobGateway> = {}): JobGateway {
  return {
    submit: async (operation) => ({
      data: completed(operation, operation === scanOperation ? scanResult() : result()),
      logId: 'submit-log',
    }),
    getJob: async () => ({ data: completed(), logId: 'query-log' }),
    cancelJob: async () => ({
      data: { id: 'dex-job', operation: inspectOperation, status: 'cancelled' },
      logId: 'cancel-log',
    }),
    ...changes,
  };
}
function operations(): OperationDto[] {
  return [inspectOperation, scanOperation].map((id) => ({
    id,
    title: 'DEX业务',
    input_schema: { type: 'object' },
    execution: { api_version: 1, source: 'declared', total_timeout_ms: 30000 },
  }));
}
function reader(changes: Partial<DexOperationReader> = {}): DexOperationReader {
  return { list: async () => ({ data: operations(), logId: 'operations-log' }), ...changes };
}
async function ready(changes: Partial<JobGateway> = {}) {
  const analysis = createDexAnalysis(gateway(changes), reader(), { pollIntervalMs: 0 });
  await analysis.refreshOperations(signal());
  return analysis;
}

test('HTTP工厂复用公开操作目录和Job端点，规范原产物ID并保留请求日志', async () => {
  const requests: { path: string; body: unknown }[] = [];
  const client = createApiClient({
    baseUrl: 'http://localhost:3000',
    transport: async (input, init) => {
      const url = requestUrl(input);
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      requests.push({ path: url.pathname, body });
      return url.pathname.endsWith('/operations')
        ? success(operations(), 'operations-log')
        : success(
            { ...completed(), created_at: 1, input: { artifact_id: artifact } },
            'submit-log',
            202,
          );
    },
  });
  const analysis = createHttpDexAnalysis(client);
  await analysis.refreshOperations(signal());
  const inspected = await analysis.inspect({ artifact_id: artifact.toUpperCase() }, signal());
  assert.equal(inspected.data.artifact_id, artifact);
  assert.equal(inspected.submitLogId, 'submit-log');
  assert.equal(inspected.logId, 'submit-log');
  assert.deepEqual(requests, [
    { path: '/api/v2/operations', body: null },
    {
      path: '/api/v2/jobs',
      body: { operation: inspectOperation, input: { artifact_id: artifact } },
    },
  ]);
  assert.equal(analysis.snapshot().logId, 'operations-log');
  analysis.dispose();
});

test('动态目录不存在不提交；刷新清旧观测且移除贡献后不回退内置操作', async () => {
  let submissions = 0;
  let available = true;
  const analysis = createDexAnalysis(
    gateway({
      submit: async (operation) => {
        submissions++;
        return { data: completed(operation), logId: 'submit-log' };
      },
    }),
    reader({
      list: async () => ({ data: available ? operations() : [], logId: 'operations-log' }),
    }),
  );
  assert.throws(() => analysis.inspect({ artifact_id: artifact }, signal()), ApiError);
  await analysis.refreshOperations(signal());
  await analysis.inspect({ artifact_id: artifact }, signal());
  available = false;
  await analysis.refreshOperations(signal());
  assert.throws(() => analysis.inspect({ artifact_id: artifact }, signal()), ApiError);
  assert.equal(submissions, 1);
  analysis.dispose();
});

test('inspect只接受产物ID，SDK规则严格未知字段、字节长度与唯一名称', async () => {
  let submissions = 0;
  const analysis = await ready({
    submit: async () => {
      submissions++;
      return { data: completed(), logId: 'submit-log' };
    },
  });
  for (const input of [
    { artifact_id: 'C:/classes.dex' },
    { artifact_id: artifact, path: 'C:/classes.dex' },
  ])
    assert.throws(() => analysis.inspect(input, signal()), ApiError);
  const inputs = [
    { artifact_id: artifact, rules: [] },
    { artifact_id: artifact, rules: Array.from({ length: 101 }, () => rule) },
    { artifact_id: artifact, rules: [rule, { ...rule }] },
    { artifact_id: artifact, rules: [{ ...rule, name: '中'.repeat(34) }] },
    { artifact_id: artifact, rules: [{ ...rule, name: '\u0085' }] },
    { artifact_id: artifact, rules: [{ ...rule, package_path: 'com/example' }] },
    { artifact_id: artifact, rules: [{ ...rule, class_name: 'Entry.Inner' }] },
    { artifact_id: artifact, rules: [{ ...rule, arbitrary: true }] },
  ];
  for (const input of inputs) assert.throws(() => analysis.scanSdks(input, signal()), ApiError);
  assert.equal(submissions, 0);
  analysis.dispose();
});

test('支持五个冻结版本并保留六项统计和三项完整性观测', async () => {
  for (const version of ['035', '037', '038', '039', '040']) {
    const value = result({ version });
    const analysis = await ready({
      submit: async () => ({ data: completed(inspectOperation, value), logId: 'submit-log' }),
    });
    const output = await analysis.inspect({ artifact_id: artifact }, signal());
    assert.deepEqual(output.data, value);
    assert.ok(Object.isFrozen(output.data.counts));
    assert.ok(Object.isFrozen(output.data.integrity));
    analysis.dispose();
  }
});

test('错来源、未支持版本、统计上限、完整性失败及未知结果字段严格拒绝', async () => {
  const badResults = [
    result({ artifact_id: other }),
    result({ version: '036' }),
    result({ version: '041' }),
    result({ file_size: 111 }),
    result({ file_size: 64 * 1024 * 1024 + 1 }),
    result({
      counts: {
        strings: 1000001,
        types: 0,
        prototypes: 0,
        fields: 0,
        methods: 0,
        defined_classes: 0,
      },
    }),
    result({
      counts: { strings: 8, types: 5, prototypes: 1, fields: 2, methods: 3, defined_classes: 6 },
    }),
    result({ integrity: { artifact_sha256: true, dex_sha1: false, dex_adler32: true } }),
    result({ private_path: 'C:/classes.dex' }),
  ];
  for (const value of badResults) {
    const analysis = await ready({
      submit: async () => ({ data: completed(inspectOperation, value), logId: 'bad-result-log' }),
    });
    await assert.rejects(
      analysis.inspect({ artifact_id: artifact }, signal()),
      (error: unknown) => error instanceof ApiError && error.logId === 'bad-result-log',
    );
    analysis.dispose();
  }
});

test('SDK按原规则顺序保留内部类证据，未指定类回显null', async () => {
  const rules = [rule, { name: '未安装', package_path: 'com.missing' }];
  const value = scanResult({
    findings: [
      { rule, package_found: true, class_found: true, evidence: ['com/example/sdk/Entry$Inner'] },
      {
        rule: { ...rules[1], class_name: null },
        package_found: false,
        class_found: null,
        evidence: [],
      },
    ],
  });
  const analysis = await ready({
    submit: async () => ({ data: completed(scanOperation, value), logId: 'scan-log' }),
  });
  const output = await analysis.scanSdks({ artifact_id: artifact, rules }, signal());
  assert.deepEqual(output.data, value);
  assert.ok(Object.isFrozen(output.data.findings[0]?.evidence));
  analysis.dispose();
});

test('证据包边界、指定类命中、排序唯一、数量和逐规则对应必须一致', async () => {
  const badFindings = [
    [{ rule, package_found: true, class_found: true, evidence: ['com/example/sdk2/Entry$Inner'] }],
    [{ rule, package_found: true, class_found: true, evidence: ['com/example/sdk/Other'] }],
    [{ rule, package_found: false, class_found: false, evidence: ['com/example/sdk/Other'] }],
    [
      {
        rule,
        package_found: true,
        class_found: false,
        evidence: ['com/example/sdk/Z', 'com/example/sdk/A'],
      },
    ],
    [
      {
        rule,
        package_found: true,
        class_found: true,
        evidence: ['com/example/sdk/Entry$Inner', 'com/example/sdk/Entry$Inner'],
      },
    ],
    [
      {
        rule: { ...rule, name: '错规则' },
        package_found: true,
        class_found: true,
        evidence: ['com/example/sdk/Entry$Inner'],
      },
    ],
    [
      {
        rule,
        package_found: true,
        class_found: true,
        evidence: Array.from({ length: 11 }, (_, index) => `com/example/sdk/A${index}`),
      },
    ],
    [],
  ];
  for (const findings of badFindings) {
    const analysis = await ready({
      submit: async () => ({
        data: completed(scanOperation, scanResult({ findings })),
        logId: 'bad-scan-log',
      }),
    });
    await assert.rejects(
      analysis.scanSdks({ artifact_id: artifact, rules: [rule] }, signal()),
      (error: unknown) => error instanceof ApiError && error.logId === 'bad-scan-log',
    );
    analysis.dispose();
  }
});

test('Unicode证据按Rust UTF-8顺序而非UTF-16顺序，040空间按实际版本准入', async () => {
  const unicodeRule = { name: '\ufeffSDK', package_path: 'com.example.sdk' };
  const evidence = ['com/example/sdk/\ue000', 'com/example/sdk/𐀀'];
  const analysis = await ready({
    submit: async () => ({
      data: completed(
        scanOperation,
        scanResult({
          findings: [
            {
              rule: { ...unicodeRule, class_name: null },
              package_found: true,
              class_found: null,
              evidence,
            },
          ],
        }),
      ),
      logId: 'scan-log',
    }),
  });
  const output = await analysis.scanSdks({ artifact_id: artifact, rules: [unicodeRule] }, signal());
  assert.deepEqual(output.data.findings[0]?.evidence, evidence);
  analysis.dispose();
  for (const version of ['039', '040']) {
    const space = await ready({
      submit: async () => ({
        data: completed(
          scanOperation,
          scanResult({
            version,
            findings: [
              {
                rule: { ...unicodeRule, class_name: null },
                package_found: true,
                class_found: null,
                evidence: ['com/example/sdk/A B'],
              },
            ],
          }),
        ),
        logId: 'space-log',
      }),
    });
    const request = space.scanSdks({ artifact_id: artifact, rules: [unicodeRule] }, signal());
    if (version === '040') await request;
    else await assert.rejects(request, ApiError);
    space.dispose();
  }
});

test('原规则副本冻结；请求开始后用户修改不影响发送及结果关联', async () => {
  const pending = deferred<ApiResult<TaskRecord>>();
  let sent: unknown;
  const analysis = await ready({
    submit: async (_operation, input) => {
      sent = input;
      return pending.promise;
    },
  });
  const mutable = { ...rule };
  const input: DexScanInput = { artifact_id: artifact, rules: [mutable] };
  const request = analysis.scanSdks(input, signal());
  mutable.name = '其他SDK';
  assert.deepEqual(sent, { artifact_id: artifact, rules: [rule] });
  assert.ok(Object.isFrozen(sent));
  assert.equal(input.rules[0]?.name, '其他SDK');
  pending.resolve({ data: completed(scanOperation, scanResult()), logId: 'submit-log' });
  await request;
  analysis.dispose();
});

test('历史恢复不依赖已卸载操作且不重提交，查询和取消只接受DEX票据', async () => {
  let submissions = 0;
  const analysis = createDexAnalysis(
    gateway({
      submit: async () => {
        submissions++;
        return { data: completed(), logId: 'submit-log' };
      },
    }),
    reader({ list: async () => ({ data: [], logId: 'operations-log' }) }),
  );
  const ticket = { id: 'dex-job', operation: inspectOperation, submitLogId: 'original-submit-log' };
  const restored = await analysis.resumeInspect(ticket, { artifact_id: artifact }, signal());
  assert.equal(restored.submitLogId, 'original-submit-log');
  assert.equal(restored.logId, 'query-log');
  await analysis.queryJob(ticket, signal());
  await analysis.cancel(ticket, signal());
  assert.equal(submissions, 0);
  const wrong = { ...ticket, operation: 'plugin.android-packages.scan_sdks' };
  assert.throws(() => analysis.resumeInspect(wrong, { artifact_id: artifact }, signal()), ApiError);
  assert.throws(() => analysis.queryJob(wrong, signal()), ApiError);
  assert.throws(() => analysis.cancel(wrong, signal()), ApiError);
  analysis.dispose();
});

test('等待取消保留任务恢复票据，不自动cancel；dispose拒绝晚结果及后续入口', async () => {
  const pending = deferred<ApiResult<TaskRecord>>();
  let cancels = 0;
  const analysis = await ready({
    submit: async () => ({
      data: { id: 'dex-job', operation: inspectOperation, status: 'running' },
      logId: 'submit-log',
    }),
    getJob: async () => pending.promise,
    cancelJob: async () => {
      cancels++;
      return { data: completed(), logId: 'cancel-log' };
    },
  });
  const controller = new AbortController();
  const request = analysis.inspect({ artifact_id: artifact }, controller.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(
    request,
    (error: unknown) =>
      error instanceof JobWaitFailure &&
      error.submitLogId === 'submit-log' &&
      error.job.id === 'dex-job',
  );
  pending.resolve({ data: completed(), logId: 'late-log' });
  assert.equal(cancels, 0);
  analysis.dispose();
  await assert.rejects(
    analysis.resumeInspect(
      { id: 'dex-job', operation: inspectOperation, submitLogId: null },
      { artifact_id: artifact },
      signal(),
    ),
  );
  assert.throws(() => analysis.refreshOperations(signal()), ApiError);
});

test('动态目录替代与销毁及时撤销忽略信号的等待，晚到不能复活贡献', async () => {
  const pending = deferred<ApiResult<readonly OperationDto[]>>();
  let calls = 0;
  const analysis = createDexAnalysis(
    gateway(),
    reader({
      list: async () =>
        ++calls === 1 ? pending.promise : { data: [], logId: 'new-directory-log' },
    }),
  );
  const old = analysis.refreshOperations(signal());
  await analysis.refreshOperations(signal());
  await assert.rejects(old, ApiError);
  pending.resolve({ data: operations(), logId: 'old-directory-log' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(analysis.snapshot().operations.length, 0);
  assert.equal(analysis.snapshot().logId, 'new-directory-log');
  analysis.dispose();
  const hanging = deferred<ApiResult<readonly OperationDto[]>>();
  const closing = createDexAnalysis(gateway(), reader({ list: async () => hanging.promise }));
  const reading = closing.refreshOperations(signal());
  closing.dispose();
  await assert.rejects(reading, ApiError);
  hanging.reject(new Error('晚目录拒绝'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closing.snapshot().operations.length, 0);
});

test('目录重复贡献或非对象模式拒绝，来源副本冻结且无关操作不进入本模块', async () => {
  const cyclic: { type: string; self?: unknown } = { type: 'object' };
  cyclic.self = cyclic;
  for (const definitions of [
    [operations()[0], operations()[0]].filter((entry) => entry !== undefined),
    [{ ...operations()[0], id: inspectOperation, title: 'DEX', input_schema: { type: 'array' } }],
    [{ id: inspectOperation, title: 'DEX', input_schema: cyclic }],
  ]) {
    const analysis = createDexAnalysis(
      gateway(),
      reader({ list: async () => ({ data: definitions, logId: 'invalid-catalog-log' }) }),
    );
    await assert.rejects(
      analysis.refreshOperations(signal()),
      (error: unknown) => error instanceof ApiError && error.logId === 'invalid-catalog-log',
    );
    assert.equal(analysis.snapshot().operations.length, 0);
    analysis.dispose();
  }
  const original = operations();
  const analysis = createDexAnalysis(
    gateway(),
    reader({
      list: async () => ({
        data: [
          ...original,
          { id: 'plugin.other.inspect', title: '其他', input_schema: { type: 'object' } },
        ],
        logId: 'operations-log',
      }),
    }),
  );
  await analysis.refreshOperations(signal());
  original.splice(0);
  assert.equal(analysis.snapshot().operations.length, 2);
  assert.ok(Object.isFrozen(analysis.snapshot().operations[0]?.input_schema));
  analysis.dispose();
});

test('只引用外部类型的扫描保留未命中，不把types数量当作已定义SDK存在', async () => {
  const noClass = { name: '外部引用', package_path: 'com.example.sdk' };
  const value = scanResult({
    counts: { strings: 8, types: 5, prototypes: 1, fields: 2, methods: 3, defined_classes: 0 },
    findings: [
      {
        rule: { ...noClass, class_name: null },
        package_found: false,
        class_found: null,
        evidence: [],
      },
    ],
  });
  const analysis = await ready({
    submit: async () => ({ data: completed(scanOperation, value), logId: 'scan-log' }),
  });
  const output = await analysis.scanSdks({ artifact_id: artifact, rules: [noClass] }, signal());
  assert.equal(output.data.findings[0]?.package_found, false);
  assert.equal(output.data.counts.types, 5);
  assert.equal(output.data.counts.defined_classes, 0);
  analysis.dispose();
});

test('扫描跨规则证据并集不能超过定义类数量，累计保守JSON预算不超512KiB', async () => {
  const rules = [
    { name: '一', package_path: 'com.example.sdk' },
    { name: '二', package_path: 'com.example.sdk' },
  ];
  const value = scanResult({
    counts: { strings: 8, types: 5, prototypes: 1, fields: 2, methods: 3, defined_classes: 1 },
    findings: rules.map((entry, index) => ({
      rule: { ...entry, class_name: null },
      package_found: true,
      class_found: null,
      evidence: [`com/example/sdk/A${index}`],
    })),
  });
  const analysis = await ready({
    submit: async () => ({ data: completed(scanOperation, value), logId: 'union-log' }),
  });
  await assert.rejects(
    analysis.scanSdks({ artifact_id: artifact, rules }, signal()),
    (error: unknown) => error instanceof ApiError && error.logId === 'union-log',
  );
  analysis.dispose();
  const evidence = Array.from(
    { length: 10 },
    (_, index) => `com/example/sdk/A${index}${'a'.repeat(4076)}`,
  );
  const largeRules = Array.from({ length: 3 }, (_, index) => ({
    name: `规则${index}`,
    package_path: 'com.example.sdk',
  }));
  const large = scanResult({
    file_size: 64 * 1024 * 1024,
    counts: { strings: 20, types: 10, prototypes: 1, fields: 2, methods: 3, defined_classes: 10 },
    findings: largeRules.map((entry) => ({
      rule: { ...entry, class_name: null },
      package_found: true,
      class_found: null,
      evidence,
    })),
  });
  const budget = await ready({
    submit: async () => ({ data: completed(scanOperation, large), logId: 'budget-log' }),
  });
  await assert.rejects(
    budget.scanSdks({ artifact_id: artifact, rules: largeRules }, signal()),
    (error: unknown) => error instanceof ApiError && error.logId === 'budget-log',
  );
  budget.dispose();
});

test('两贡献都拒绝非空发布产物与未包装结果，扫描恢复以原规则校对', async () => {
  const outputArtifact = {
    id: other,
    filename: 'private.json',
    media_type: 'application/json',
    size: 1,
    created_at: 1,
    sha256: 'a'.repeat(64),
  };
  for (const payload of [{ result: result(), artifacts: [outputArtifact] }, result()]) {
    const analysis = await ready({
      submit: async () => ({ data: { ...completed(), result: payload }, logId: 'wrapper-log' }),
    });
    await assert.rejects(
      analysis.inspect({ artifact_id: artifact }, signal()),
      (error: unknown) => error instanceof ApiError && error.logId === 'wrapper-log',
    );
    analysis.dispose();
  }
  const analysis = createDexAnalysis(
    gateway({
      getJob: async () => ({
        data: completed(scanOperation, scanResult()),
        logId: 'resume-scan-log',
      }),
    }),
    reader(),
  );
  const ticket = { id: 'dex-job', operation: scanOperation, submitLogId: 'original-log' };
  const restored = await analysis.resumeScanSdks(
    ticket,
    { artifact_id: artifact, rules: [rule] },
    signal(),
  );
  assert.equal(restored.submitLogId, 'original-log');
  assert.equal(restored.logId, 'resume-scan-log');
  await assert.rejects(
    analysis.resumeScanSdks(
      ticket,
      { artifact_id: artifact, rules: [{ ...rule, name: '其他' }] },
      signal(),
    ),
    ApiError,
  );
  analysis.dispose();
});
