import assert from 'node:assert/strict';
import test from 'node:test';
import { createPackageAnalysis } from '../src/features/package-analysis/index.ts';
import { ApiError } from '../src/services/api/index.ts';
import type { JobGateway, JsonData } from '../src/shared/jobs/index.ts';
import { deferred, signal } from './fixtures.ts';

const source = '12345678-1234-1234-1234-123456789abc';
const published = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const spec = {
  supported_abis: ['arm64-v8a'],
  supported_locales: ['zh-CN'],
  screen_density: 420,
  sdk_version: 35,
};
const rule = { name: 'SDK', package_path: 'com.example.sdk', class_name: 'Entry' };
function output(result: JsonData, filename?: string, size = 2, sha256 = 'a'.repeat(64)): JsonData {
  return {
    result,
    artifacts:
      filename === undefined
        ? []
        : [{ id: published, filename, media_type: 'application/zip', size, sha256, created_at: 1 }],
  };
}
function built(mode: string = 'default', changes: Record<string, JsonData> = {}): JsonData {
  return output(
    {
      mode,
      apk_count: mode === 'universal' ? 1 : 2,
      universal_entry: mode === 'universal' ? 'universal.apk' : null,
      ...changes,
    },
    'built.apks',
  );
}
function decoded(changes: Record<string, JsonData> = {}): JsonData {
  return output({ files: 2, unpacked_size: 12, ...changes }, 'decoded.zip');
}
function findings(changes: Record<string, JsonData> = {}): JsonData {
  return output({
    artifact_id: source,
    findings: [
      {
        rule,
        package_found: true,
        class_found: true,
        evidence: ['smali/com/example/sdk/Entry.smali'],
        ...changes,
      },
    ],
  });
}
function splits(changes: Record<string, JsonData> = {}): JsonData {
  return output(
    { device_spec: spec, apk_entries: ['base.apk', 'splits/config.apk'], ...changes },
    'selected-apks.zip',
  );
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
      throw new Error('不得自动取消服务器任务');
    },
  };
}

test('构建default和universal沿真实模式，保留可空和默认模式的universal条目', async () => {
  const seen: JsonData[] = [];
  const packages = createPackageAnalysis(
    gateway((operation, input) => {
      assert.equal(operation, 'plugin.android-packages.build_apks');
      seen.push(input);
      const mode =
        input !== null &&
        typeof input === 'object' &&
        !Array.isArray(input) &&
        typeof input.mode === 'string'
          ? input.mode
          : '';
      return seen.length === 3 ? built(mode, { universal_entry: 'universal.apk' }) : built(mode);
    }),
  );
  assert.equal(
    (await packages.buildApks({ artifact_id: source, mode: 'default' }, signal())).data.result
      .universal_entry,
    null,
  );
  assert.equal(
    (await packages.buildApks({ artifact_id: source, mode: 'universal' }, signal())).data.result
      .apk_count,
    1,
  );
  assert.equal(
    (await packages.buildApks({ artifact_id: source, mode: 'default' }, signal())).data.result
      .universal_entry,
    'universal.apk',
  );
  assert.deepEqual(seen[0], { artifact_id: source, mode: 'default' });
  packages.dispose();
});

test('反编译和离线分包消费发布ZIP，规格保持公开snake_case', async () => {
  const seen: { operation: string; input: JsonData }[] = [];
  const packages = createPackageAnalysis(
    gateway((operation, input) => {
      seen.push({ operation, input });
      return operation.endsWith('.decode') ? decoded() : splits();
    }),
  );
  assert.equal((await packages.decode({ artifact_id: source }, signal())).data.result.files, 2);
  const extracted = await packages.extractSplits(
    { artifact_id: source, device_spec: spec },
    signal(),
  );
  assert.deepEqual(extracted.data.result.device_spec, spec);
  assert.deepEqual(extracted.data.result.apk_entries, ['base.apk', 'splits/config.apk']);
  assert.deepEqual(seen[1], {
    operation: 'plugin.android-packages.extract_splits',
    input: { artifact_id: source, device_spec: spec },
  });
  packages.dispose();
});

test('SDK结果逐规则保留顺序、显式null和路径证据，不将路径命中称为版本识别', async () => {
  const rules = [rule, { name: '未指定类', package_path: 'com.missing' }];
  const packages = createPackageAnalysis(
    gateway(() =>
      output({
        artifact_id: source,
        findings: [
          {
            rule,
            package_found: true,
            class_found: true,
            evidence: ['smali/com/example/sdk/Entry.smali'],
          },
          {
            rule: { ...rules[1], class_name: null },
            package_found: false,
            class_found: null,
            evidence: [],
          },
        ],
      }),
    ),
  );
  const result = await packages.scanSdks({ artifact_id: source, rules }, signal());
  assert.equal(result.data.findings[1]?.class_found, null);
  assert.equal(result.data.findings[1]?.rule.name, '未指定类');
  packages.dispose();
});

test('SDK名称按UTF-8和Rust空白规则校验，不误删BOM名称', async () => {
  const packages = createPackageAnalysis(
    gateway((_operation, input) => {
      if (
        input === null ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        !Array.isArray(input.rules)
      )
        throw new Error('预期规则输入');
      return output({
        artifact_id: source,
        findings: input.rules.map((entry) => ({
          rule: entry,
          package_found: false,
          class_found: null,
          evidence: [],
        })),
      });
    }),
  );
  for (const name of ['中'.repeat(33) + 'a', '\uFEFF']) {
    await packages.scanSdks(
      { artifact_id: source, rules: [{ name, package_path: 'com.sdk', class_name: null }] },
      signal(),
    );
  }
  for (const name of ['中'.repeat(34), '\u00A0', 'bad\u0085'])
    assert.throws(
      () =>
        packages.scanSdks(
          { artifact_id: source, rules: [{ name, package_path: 'com.sdk' }] },
          signal(),
        ),
      ApiError,
    );
  packages.dispose();
});

test('SDK非法或重复规则、控制字符、类名和未知字段在提交前拒绝', () => {
  let submissions = 0;
  const packages = createPackageAnalysis(
    gateway(() => {
      submissions++;
      return findings();
    }),
  );
  for (const rules of [
    [],
    [rule, rule],
    [{ ...rule, package_path: '../com/sdk' }],
    [{ ...rule, class_name: 'Entry.Name' }],
    [{ ...rule, extra: true }],
    [{ ...rule, name: ' ' }],
  ]) {
    assert.throws(() => packages.scanSdks({ artifact_id: source, rules }, signal()), ApiError);
  }
  assert.equal(submissions, 0);
  packages.dispose();
});

test('设备规格的列表、唯一性、ASCII标识与数值界限沿真实合同', () => {
  let submissions = 0;
  const packages = createPackageAnalysis(
    gateway(() => {
      submissions++;
      return splits();
    }),
  );
  for (const changes of [
    { supported_abis: [] },
    { supported_abis: ['arm64-v8a', 'arm64-v8a'] },
    { supported_locales: ['zh.CN'] },
    { supported_locales: [] },
    { screen_density: 0 },
    { screen_density: 1.5 },
    { sdk_version: 10001 },
    { sdk_version: NaN },
    { extra: 'override' },
  ])
    assert.throws(
      () =>
        packages.extractSplits(
          { artifact_id: source, device_spec: { ...spec, ...changes } },
          signal(),
        ),
      ApiError,
    );
  const extra: { artifact_id: string; mode: 'default'; keystore: string } = {
    artifact_id: source,
    mode: 'default',
    keystore: 'secret',
  };
  assert.throws(() => packages.buildApks(extra, signal()), ApiError);
  assert.equal(submissions, 0);
  packages.dispose();
});

test('规格建立深副本，调用者修改数组不改变在途请求', async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  let submitted: JsonData | undefined;
  const packages = createPackageAnalysis({
    ...gateway(() => splits()),
    submit: async (operation, input) => {
      submitted = input;
      entered.resolve();
      await release.promise;
      return {
        data: { id: 'package-job', operation, status: 'succeeded', result: splits(), error: null },
        logId: 'copy-log',
      };
    },
  });
  const mutable = { ...spec, supported_abis: ['arm64-v8a'], supported_locales: ['zh-CN'] };
  const waiting = packages.extractSplits({ artifact_id: source, device_spec: mutable }, signal());
  await entered.promise;
  mutable.supported_abis.push('x86');
  mutable.sdk_version = 1;
  assert.deepEqual(submitted, { artifact_id: source, device_spec: spec });
  release.resolve();
  await waiting;
  packages.dispose();
});

test('SDK规则建立深副本，调用者修改类名不改变原结果关联', async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  let submitted: JsonData | undefined;
  const packages = createPackageAnalysis({
    ...gateway(() => findings()),
    submit: async (operation, input) => {
      submitted = input;
      entered.resolve();
      await release.promise;
      return {
        data: {
          id: 'package-job',
          operation,
          status: 'succeeded',
          result: findings(),
          error: null,
        },
        logId: 'rule-copy-log',
      };
    },
  });
  const mutable = { ...rule };
  const rules = [mutable];
  const waiting = packages.scanSdks({ artifact_id: source, rules }, signal());
  await entered.promise;
  mutable.class_name = 'Changed';
  rules.push({ name: 'second', package_path: 'com.other', class_name: 'Other' });
  assert.deepEqual(submitted, { artifact_id: source, rules: [rule] });
  release.resolve();
  assert.equal((await waiting).data.findings[0]?.rule.class_name, 'Entry');
  packages.dispose();
});

test('构建模式、APK数量和universal条目不一致明确失败并保留日志', async () => {
  for (const changes of [
    { mode: 'default' },
    { apk_count: 2 },
    { universal_entry: null },
    { universal_entry: 'nested/universal.apk' },
    { apk_count: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const packages = createPackageAnalysis(gateway(() => built('universal', changes)));
    await assert.rejects(
      packages.buildApks({ artifact_id: source, mode: 'universal' }, signal()),
      (error: unknown) => error instanceof ApiError && error.logId === 'submit-log',
    );
    packages.dispose();
  }
});

test('反编译文件数量和累计展开大小须满足公开核心边界', async () => {
  for (const changes of [
    { files: -1 },
    { files: 10001 },
    { files: 1.5 },
    { unpacked_size: 64 * 1024 * 1024 + 1 },
  ]) {
    const packages = createPackageAnalysis(gateway(() => decoded(changes)));
    await assert.rejects(packages.decode({ artifact_id: source }, signal()), ApiError);
    packages.dispose();
  }
});

test('SDK来源、逐规则对应、类命中和证据集合不兼容时拒绝', async () => {
  const bad: JsonData[] = [
    output({ artifact_id: published, findings: [] }),
    findings({ rule: { ...rule, name: 'wrong' } }),
    findings({ class_found: null }),
    findings({ package_found: false }),
    findings({ evidence: ['smali/com/other/Entry.smali'] }),
    findings({
      evidence: ['smali/com/example/sdk/Entry.smali', 'smali/com/example/sdk/Entry.smali'],
    }),
    findings({
      evidence: Array.from(
        { length: 11 },
        (_unused, index) => `smali/com/example/sdk/Entry${index}.smali`,
      ),
    }),
    output({ artifact_id: source, findings: [] }),
  ];
  for (const value of bad) {
    const packages = createPackageAnalysis(gateway(() => value));
    await assert.rejects(
      packages.scanSdks({ artifact_id: source, rules: [rule] }, signal()),
      ApiError,
    );
    packages.dispose();
  }
});

test('离线分包返回规格必须精确匹配，APK条目非空安全且唯一', async () => {
  for (const changes of [
    { device_spec: { ...spec, sdk_version: 34 } },
    { apk_entries: [] },
    { apk_entries: ['base.apk', 'base.apk'] },
    { apk_entries: ['../base.apk'] },
    { apk_entries: ['base.txt'] },
    { apk_entries: ['base.APK'] },
  ]) {
    const packages = createPackageAnalysis(gateway(() => splits(changes)));
    await assert.rejects(
      packages.extractSplits({ artifact_id: source, device_spec: spec }, signal()),
      ApiError,
    );
    packages.dispose();
  }
});

test('后四项恢复只查询原Job，操作票据不匹配在网关前拒绝', async () => {
  let reads = 0;
  const packages = createPackageAnalysis({
    ...gateway(() => {
      throw new Error('恢复不得提交');
    }),
    getJob: async (id) => {
      reads++;
      const result =
        id === 'build_apks'
          ? built()
          : id === 'decode'
            ? decoded()
            : id === 'scan_sdks'
              ? findings()
              : splits();
      return {
        data: {
          id,
          operation: `plugin.android-packages.${id}`,
          status: 'succeeded',
          result,
          error: null,
        },
        logId: 'resume-log',
      };
    },
  });
  const ticket = (action: string) => ({
    id: action,
    operation: `plugin.android-packages.${action}`,
    submitLogId: 'old-log',
  });
  await packages.resumeBuildApks(
    ticket('build_apks'),
    { artifact_id: source, mode: 'default' },
    signal(),
  );
  await packages.resumeDecode(ticket('decode'), { artifact_id: source }, signal());
  await packages.resumeScanSdks(
    ticket('scan_sdks'),
    { artifact_id: source, rules: [rule] },
    signal(),
  );
  await packages.resumeExtractSplits(
    ticket('extract_splits'),
    { artifact_id: source, device_spec: spec },
    signal(),
  );
  await packages.queryJob(ticket('build_apks'), signal());
  assert.throws(
    () => packages.resumeDecode(ticket('build_apks'), { artifact_id: source }, signal()),
    ApiError,
  );
  assert.equal(reads, 5);
  packages.dispose();
});

test('三类新产物通过指定能力下载原字节并核对宿主摘要', async () => {
  const bytes = new Uint8Array([3, 4]);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const packages = createPackageAnalysis(
    gateway((operation) =>
      operation.endsWith('.build_apks')
        ? output(
            { mode: 'default', apk_count: 2, universal_entry: null },
            'built.apks',
            bytes.length,
            digest,
          )
        : operation.endsWith('.decode')
          ? output({ files: 2, unpacked_size: 12 }, 'decoded.zip', bytes.length, digest)
          : output(
              { device_spec: spec, apk_entries: ['base.apk'] },
              'selected-apks.zip',
              bytes.length,
              digest,
            ),
    ),
    {},
    {
      download: async (id) => {
        assert.equal(id, published);
        return { data: new Blob([bytes]), logId: 'download-log' };
      },
    },
  );
  const builtResult = await packages.buildApks({ artifact_id: source, mode: 'default' }, signal());
  const decodedResult = await packages.decode({ artifact_id: source }, signal());
  const splitResult = await packages.extractSplits(
    { artifact_id: source, device_spec: spec },
    signal(),
  );
  for (const downloaded of [
    await packages.downloadBuilt(builtResult.data, signal()),
    await packages.downloadDecoded(decodedResult.data, signal()),
    await packages.downloadSplits(splitResult.data, signal()),
  ]) {
    assert.deepEqual(new Uint8Array(await downloaded.data.arrayBuffer()), bytes);
    assert.equal(downloaded.logId, 'download-log');
  }
  packages.dispose();
});
