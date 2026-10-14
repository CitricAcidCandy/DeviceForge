import assert from 'node:assert/strict';
import test from 'node:test';
import { createPackageAnalysis } from '../src/features/package-analysis/index.ts';
import { ApiError } from '../src/services/api/index.ts';
import type { ApiResult } from '../src/services/api/index.ts';
import { JobWaitFailure } from '../src/shared/jobs/index.ts';
import type { JobGateway, JsonData, TaskRecord } from '../src/shared/jobs/index.ts';
import { deferred, signal } from './fixtures.ts';

const source = '12345678-1234-1234-1234-123456789abc';
const published = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
function envelope(result: JsonData, artifacts: JsonData[] = []): JsonData {
  return { result, artifacts };
}
function manifest(changes: Record<string, JsonData> = {}): JsonData {
  return {
    artifact_id: source,
    format: 'apk',
    module: null,
    package_name: 'com.example.test',
    version_code: '0001',
    version_name: '设备 & 测试',
    min_sdk: null,
    target_sdk: '35',
    application_label: null,
    debuggable: null,
    permissions: ['android.permission.INTERNET'],
    xml: '<manifest package="com.example.test"/>',
    ...changes,
  };
}
function signature(changes: Record<string, JsonData> = {}): JsonData {
  return {
    artifact_id: source,
    verified: true,
    signers: [{ number: 1, distinguished_name: null, certificate_sha256: 'a'.repeat(64) }],
    schemes: [
      { scheme: 'v2', verified: true },
      { scheme: 'v3', verified: false },
    ],
    report: 'Verifies\n签名验证报告',
    ...changes,
  };
}
function artifact(size = 2, sha256 = 'a'.repeat(64)) {
  return {
    id: published,
    filename: 'extracted.apk',
    media_type: 'application/zip',
    size,
    sha256,
    created_at: 1,
  };
}
function extracted(entry = 'universal.apk', size = 2, sha256 = 'a'.repeat(64)): JsonData {
  return envelope({ entry }, [artifact(size, sha256)]);
}
function gateway(response: (operation: string, input: JsonData) => JsonData): JobGateway {
  return {
    submit: async (operation, input) => ({
      data: {
        id: 'package-job',
        operation,
        status: 'succeeded',
        result: response(operation, input),
        error: null,
      },
      logId: 'submit-log',
    }),
    getJob: async () => {
      throw new Error('已完成任务不得重查');
    },
    cancelJob: async () => {
      throw new Error('等待取消不得请求服务器取消');
    },
  };
}

test('清单读取仅提交产物和可选模块，保留版本字符串、XML和显式null', async () => {
  const seen: { operation: string; input: JsonData }[] = [];
  const packages = createPackageAnalysis(
    gateway((operation, input) => {
      seen.push({ operation, input });
      return envelope(manifest());
    }),
  );
  const output = await packages.manifest({ artifact_id: source.toUpperCase() }, signal());
  assert.equal(output.data.version_code, '0001');
  assert.equal(output.data.module, null);
  assert.equal(output.data.debuggable, null);
  assert.equal(output.data.xml, '<manifest package="com.example.test"/>');
  assert.equal(output.logId, 'submit-log');
  assert.deepEqual(seen, [
    { operation: 'plugin.android-packages.manifest', input: { artifact_id: source } },
  ]);
  packages.dispose();
});

test('AAB默认模块和显式模块须与请求一致，APK不能伪造模块结果', async () => {
  const packages = createPackageAnalysis(
    gateway((_operation, input) =>
      envelope(
        manifest({
          format: 'aab',
          module:
            typeof input === 'object' && input !== null && !Array.isArray(input)
              ? (input.module ?? 'base')
              : 'base',
        }),
      ),
    ),
  );
  assert.equal((await packages.manifest({ artifact_id: source }, signal())).data.module, 'base');
  assert.equal(
    (await packages.manifest({ artifact_id: source, module: 'feature_1' }, signal())).data.module,
    'feature_1',
  );
  packages.dispose();
  for (const value of [
    manifest({ format: 'aab', module: 'wrong' }),
    manifest(),
    manifest({ module: 'feature_1' }),
  ]) {
    const invalid = createPackageAnalysis(gateway(() => envelope(value)));
    await assert.rejects(
      invalid.manifest({ artifact_id: source, module: 'feature_1' }, signal()),
      ApiError,
    );
    invalid.dispose();
  }
});

test('签名保留全部方案、证书和可空DN，不从报告文本伪造验证结果', async () => {
  const packages = createPackageAnalysis(gateway(() => envelope(signature())));
  const output = await packages.signature({ artifact_id: source }, signal());
  assert.equal(output.data.verified, true);
  assert.equal(output.data.signers[0]?.distinguished_name, null);
  assert.deepEqual(output.data.schemes, [
    { scheme: 'v2', verified: true },
    { scheme: 'v3', verified: false },
  ]);
  assert.equal(output.data.report, 'Verifies\n签名验证报告');
  packages.dispose();
});

test('精确提取沿直接贡献且保留条目大小写，产物按固定名唯一匹配', async () => {
  const seen: JsonData[] = [];
  const packages = createPackageAnalysis(
    gateway((operation, input) => {
      assert.equal(operation, 'plugin.android-packages.extract_apk');
      seen.push(input);
      return extracted('splits/设备.APK');
    }),
  );
  const output = await packages.extractApk(
    { artifact_id: source, entry: 'splits/设备.APK' },
    signal(),
  );
  assert.equal(output.data.result.entry, 'splits/设备.APK');
  assert.equal(output.data.artifacts[0]?.id, published);
  assert.deepEqual(seen, [{ artifact_id: source, entry: 'splits/设备.APK' }]);
  packages.dispose();
});

test('路径、未知字段、非法模块及不安全APK条目在提交前拒绝', () => {
  let submissions = 0;
  const packages = createPackageAnalysis(
    gateway(() => {
      submissions++;
      return envelope(manifest());
    }),
  );
  assert.throws(() => packages.signature({ artifact_id: 'C:/input.apk' }, signal()), ApiError);
  const extra = { artifact_id: source, executable: 'tool' };
  assert.throws(() => packages.signature(extra, signal()), ApiError);
  for (const module of ['', '1base', 'a-b', '中文', 'a'.repeat(81)])
    assert.throws(() => packages.manifest({ artifact_id: source, module }, signal()), ApiError);
  for (const entry of [
    '../base.apk',
    'base/../part.apk',
    '/base.apk',
    'base//part.apk',
    'base\\part.apk',
    'C:base.apk',
    'base.txt',
    'base\u0085.apk',
    'base.APK',
  ]) {
    assert.throws(() => packages.extractApk({ artifact_id: source, entry }, signal()), ApiError);
  }
  assert.equal(submissions, 0);
  packages.dispose();
});

test('APK条目的500字节UTF-8边界沿真实插件规则', async () => {
  const entry = '中'.repeat(165) + 'a.apk';
  const packages = createPackageAnalysis(gateway(() => extracted(entry)));
  await packages.extractApk({ artifact_id: source, entry }, signal());
  assert.throws(
    () => packages.extractApk({ artifact_id: source, entry: entry + 'a.apk' }, signal()),
    ApiError,
  );
  packages.dispose();
});

test('直接target拒绝旧alias的未包装DTO以及非空清单产物', async () => {
  for (const response of [manifest(), envelope(manifest(), [artifact()])]) {
    const packages = createPackageAnalysis(gateway(() => response));
    await assert.rejects(
      packages.manifest({ artifact_id: source }, signal()),
      (error: unknown) => error instanceof ApiError && error.logId === 'submit-log',
    );
    packages.dispose();
  }
});

test('清单来源、可空字段和权限类型不兼容时保留真实日志拒绝', async () => {
  for (const changes of [
    { artifact_id: published },
    { format: 'hap' },
    { min_sdk: 24 },
    { debuggable: 'false' },
    { permissions: [1] },
  ]) {
    const packages = createPackageAnalysis(gateway(() => envelope(manifest(changes))));
    await assert.rejects(
      packages.manifest({ artifact_id: source }, signal()),
      (error: unknown) => error instanceof ApiError && error.logId === 'submit-log',
    );
    packages.dispose();
  }
  const value = manifest();
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('测试清单应为对象');
  delete value.min_sdk;
  const missing = createPackageAnalysis(gateway(() => envelope(value)));
  await assert.rejects(missing.manifest({ artifact_id: source }, signal()), ApiError);
  missing.dispose();
});

test('签名来源、验证状态、证书与方案集合不能矛盾或畸形', async () => {
  for (const changes of [
    { artifact_id: published },
    { verified: false },
    { signers: [] },
    { signers: [{ number: 2, distinguished_name: null, certificate_sha256: 'a'.repeat(64) }] },
    { signers: [{ number: 1, certificate_sha256: 'a'.repeat(64) }] },
    { signers: [{ number: 1, distinguished_name: null, certificate_sha256: 'broken' }] },
    { schemes: [{ scheme: 'v2', verified: false }] },
    {
      schemes: [
        { scheme: 'v2', verified: true },
        { scheme: 'v2', verified: true },
      ],
    },
  ]) {
    const packages = createPackageAnalysis(gateway(() => envelope(signature(changes))));
    await assert.rejects(packages.signature({ artifact_id: source }, signal()), ApiError);
    packages.dispose();
  }
});

test('提取条目与唯一产物名称、媒体类型、大小必须匹配真实合同', async () => {
  for (const value of [
    extracted('other.apk'),
    envelope({ entry: 'universal.apk' }),
    envelope({ entry: 'universal.apk' }, [artifact(), { ...artifact(), id: source }]),
    envelope({ entry: 'universal.apk' }, [{ ...artifact(), filename: 'wrong.apk' }]),
    envelope({ entry: 'universal.apk' }, [
      { ...artifact(), media_type: 'application/octet-stream' },
    ]),
    extracted('universal.apk', 64 * 1024 * 1024 + 1),
  ]) {
    const packages = createPackageAnalysis(gateway(() => value));
    await assert.rejects(
      packages.extractApk({ artifact_id: source, entry: 'universal.apk' }, signal()),
      ApiError,
    );
    packages.dispose();
  }
});

test('建立输入副本后调用者修改不会改变请求或提取结果关联', async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  let sent: JsonData | undefined;
  const packages = createPackageAnalysis({
    ...gateway(() => extracted()),
    submit: async (operation, input) => {
      sent = input;
      entered.resolve();
      await release.promise;
      return {
        data: {
          id: 'package-job',
          operation,
          status: 'succeeded',
          result: extracted(),
          error: null,
        },
        logId: 'copy-log',
      };
    },
  });
  const input = { artifact_id: source, entry: 'universal.apk' };
  const waiting = packages.extractApk(input, signal());
  await entered.promise;
  input.entry = 'changed.apk';
  input.artifact_id = published;
  assert.deepEqual(sent, { artifact_id: source, entry: 'universal.apk' });
  release.resolve();
  assert.equal((await waiting).data.result.entry, 'universal.apk');
  packages.dispose();
});

test('取消等待后恢复原提取Job，不重发且晚到结果不能交付', async () => {
  const entered = deferred<void>();
  const blocked = deferred<ApiResult<TaskRecord>>();
  let submits = 0;
  let resume = false;
  const operation = 'plugin.android-packages.extract_apk';
  const terminal: ApiResult<TaskRecord> = {
    data: { id: 'package-job', operation, status: 'succeeded', result: extracted(), error: null },
    logId: 'get-log',
  };
  const packages = createPackageAnalysis(
    {
      ...gateway(() => extracted()),
      submit: async () => {
        submits++;
        return {
          data: { id: 'package-job', operation, status: 'running', result: null, error: null },
          logId: 'submit-log',
        };
      },
      getJob: async () => {
        entered.resolve();
        return resume ? terminal : blocked.promise;
      },
    },
    { pollIntervalMs: 0 },
  );
  const input = { artifact_id: source, entry: 'universal.apk' };
  const controller = new AbortController();
  const waiting = packages.extractApk(input, controller.signal);
  const rejected = assert.rejects(
    waiting,
    (error: unknown) =>
      error instanceof JobWaitFailure &&
      error.job.id === 'package-job' &&
      error.submitLogId === 'submit-log',
  );
  await entered.promise;
  controller.abort();
  await rejected;
  resume = true;
  assert.equal(
    (
      await packages.resumeExtractApk(
        { id: 'package-job', operation, submitLogId: 'submit-log' },
        input,
        signal(),
      )
    ).logId,
    'get-log',
  );
  blocked.resolve(terminal);
  assert.equal(submits, 1);
  packages.dispose();
});

test('清单签名恢复、查询和显式取消沿原操作，错误票据在网关前拒绝', async () => {
  let reads = 0;
  let cancels = 0;
  const packages = createPackageAnalysis({
    ...gateway(() => envelope(manifest())),
    getJob: async (id) => {
      reads++;
      return {
        data: {
          id,
          operation: `plugin.android-packages.${id}`,
          status: 'succeeded',
          result: envelope(id === 'manifest' ? manifest() : signature()),
          error: null,
        },
        logId: 'read-log',
      };
    },
    cancelJob: async (id) => {
      cancels++;
      return {
        data: {
          id,
          operation: `plugin.android-packages.${id}`,
          status: 'succeeded',
          result: envelope(signature()),
          error: null,
        },
        logId: 'cancel-log',
      };
    },
  });
  const ticket = (action: string) => ({
    id: action,
    operation: `plugin.android-packages.${action}`,
    submitLogId: 'old-log',
  });
  await packages.resumeManifest(ticket('manifest'), { artifact_id: source }, signal());
  await packages.resumeSignature(ticket('signature'), { artifact_id: source }, signal());
  await packages.queryJob(ticket('signature'), signal());
  await packages.cancel(ticket('signature'), signal());
  assert.equal(reads, 3);
  assert.equal(cancels, 1);
  assert.throws(
    () => packages.resumeManifest(ticket('signature'), { artifact_id: source }, signal()),
    ApiError,
  );
  const foreign = { ...ticket('signature'), operation: 'plugin.msgpack.decode' };
  assert.throws(() => packages.queryJob(foreign, signal()), ApiError);
  assert.throws(() => packages.cancel(foreign, signal()), ApiError);
  packages.dispose();
});

test('提取下载核对原字节大小摘要与真实下载日志，销毁撤销忽略信号的下载', async () => {
  const bytes = new Uint8Array([0, 255, 7]);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const packages = createPackageAnalysis(
    gateway(() => extracted('universal.apk', bytes.length, hash)),
    {},
    {
      download: async (id) => {
        assert.equal(id, published);
        return { data: new Blob([bytes]), logId: 'download-log' };
      },
    },
  );
  const output = await packages.extractApk(
    { artifact_id: source, entry: 'universal.apk' },
    signal(),
  );
  const download = await packages.download(output.data, signal());
  assert.deepEqual(new Uint8Array(await download.data.arrayBuffer()), bytes);
  assert.equal(download.logId, 'download-log');
  packages.dispose();
  const absent = createPackageAnalysis(gateway(() => extracted()));
  assert.throws(() => absent.download(output.data, signal()), ApiError);
  absent.dispose();
  const entered = deferred<void>();
  const blocked = deferred<ApiResult<Blob>>();
  const closing = createPackageAnalysis(
    gateway(() => extracted()),
    {},
    {
      download: async () => {
        entered.resolve();
        return blocked.promise;
      },
    },
  );
  const waiting = closing.download(output.data, signal());
  const rejected = assert.rejects(
    waiting,
    (error: unknown) => error instanceof ApiError && error.kind === 'cancelled',
  );
  await entered.promise;
  closing.dispose();
  await rejected;
  blocked.resolve({ data: new Blob([bytes]), logId: 'late-log' });
});
