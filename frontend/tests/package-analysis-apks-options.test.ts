import assert from 'node:assert/strict';
import test from 'node:test';
import { createPackageAnalysis, prepareApksInstallInput } from '../src/features/package-analysis/index.ts';
import type { PackageDeviceSpec } from '../src/features/package-analysis/index.ts';
import { ApiError } from '../src/services/api/index.ts';
import type { JobGateway, JsonData } from '../src/shared/jobs/index.ts';
import { deferred, signal } from './fixtures.ts';
import type { ApiResult } from '../src/services/api/index.ts';
import type { TaskRecord } from '../src/shared/jobs/index.ts';

const source = '12345678-1234-1234-1234-123456789abc';
const outputId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const spec = { supported_abis: ['arm64-v8a'], supported_locales: ['zh-CN'], screen_density: 480, sdk_version: 35 };
function output(deviceSpec: unknown) {
  return { result: { device_spec: deviceSpec, apk_entries: ['base.apk'] }, artifacts: [{ id: outputId, filename: 'selected-apks.zip', media_type: 'application/zip', size: 10, sha256: 'a'.repeat(64), created_at: 1 }] };
}
function job(value: unknown): TaskRecord { return { id: 'apks-job', operation: 'plugin.android-packages.extract_splits', status: 'succeeded', result: value }; }
function gateway(response: (input: JsonData) => unknown = () => output(spec)): JobGateway {
  return { submit: async (_operation, input) => ({ data: job(response(input)), logId: 'submit-log' }), getJob: async () => ({ data: job(output(spec)), logId: 'query-log' }), cancelJob: async () => ({ data: { id: 'apks-job', operation: 'plugin.android-packages.extract_splits', status: 'cancelled' }, logId: 'cancel-log' }) };
}

test('旧四维输入保持原形，高级维度、modules和instant位于实际插件输入位置', async () => {
  const seen: JsonData[] = [];
  const extended = { ...spec, device_features: ['android.hardware.camera', 'feature:one'], gl_extensions: ['GL_EXT_texture'], codename: 'Preview_1', device_tier: 'tier-2' };
  const packages = createPackageAnalysis(gateway((input) => { seen.push(input); return output(seen.length === 1 ? spec : extended); }));
  await packages.extractSplits({ artifact_id: source, device_spec: spec }, signal());
  const result = await packages.extractSplits({ artifact_id: source.toUpperCase(), device_spec: extended, modules: ['base', 'feature_1'], instant: true }, signal());
  assert.deepEqual(seen[0], { artifact_id: source, device_spec: spec });
  assert.deepEqual(seen[1], { artifact_id: source, device_spec: extended, modules: ['base', 'feature_1'], instant: true });
  assert.deepEqual(result.data.result.device_spec, extended);
  assert.equal(Object.hasOwn(result.data.result, 'modules'), false);
  assert.equal(Object.hasOwn(result.data.result, 'instant'), false);
  packages.dispose();
});

test('显式空高级数组与null代号档位匹配后端省略结果，null模块和false即时模式保留输入', async () => {
  let sent: unknown;
  const packages = createPackageAnalysis(gateway((input) => { sent = input; return output(spec); }));
  const empty = { ...spec, device_features: [], gl_extensions: [], codename: null, device_tier: null };
  const result = await packages.extractSplits({ artifact_id: source, device_spec: empty, modules: null, instant: false }, signal());
  assert.deepEqual(sent, { artifact_id: source, device_spec: empty, modules: null, instant: false });
  assert.deepEqual(result.data.result.device_spec, spec);
  packages.dispose();
});

test('高级规格拒绝非法类型、null数组、未知字段、重复、数量及标识越界', () => {
  let submissions = 0;
  const packages = createPackageAnalysis(gateway(() => { submissions++; return output(spec); }));
  const invalid: Record<string, JsonData>[] = [
    { device_features: null }, { gl_extensions: null }, { device_features: ['same', 'same'] },
    { gl_extensions: ['GL_EXT/unsafe'] }, { device_features: ['a'.repeat(161)] },
    { device_features: Array.from({ length: 257 }, (_, index) => `feature${index}`) },
    { codename: '' }, { codename: '有空白' }, { device_tier: 2 }, { device_tier: 'a'.repeat(81) },
    { server_path: 'C:/spec.json' },
  ];
  for (const changes of invalid) assert.throws(() => packages.extractSplits({ artifact_id: source, device_spec: { ...spec, ...changes } }, signal()), ApiError);
  assert.equal(submissions, 0); packages.dispose();
});

test('模块列表唯一有界且ALL必须单独选择，instant只接受布尔值', async () => {
  const seen: unknown[] = [];
  const packages = createPackageAnalysis(gateway((input) => { seen.push(input); return output(spec); }));
  const invalid: Record<string, JsonData>[] = [
    { modules: [] }, { modules: ['base', 'base'] }, { modules: ['ALL', 'base'] }, { modules: ['--module'] },
    { modules: ['1feature'] }, { modules: ['a'.repeat(81)] }, { modules: Array.from({ length: 129 }, (_, index) => `M${index}`) },
    { modules: 'ALL' }, { instant: null }, { instant: 1 }, { instant: 'true' }, { arbitrary: true },
  ];
  for (const changes of invalid) assert.throws(() => packages.extractSplits({ artifact_id: source, device_spec: spec, ...changes }, signal()), ApiError);
  await packages.extractSplits({ artifact_id: source, device_spec: spec, modules: ['ALL'] }, signal());
  assert.equal(seen.length, 1);
  packages.dispose();
});

test('规格累计文本48KiB按真实限额，恰好边界接受而超一字节拒绝', async () => {
  const features = Array.from({ length: 256 }, (_, index) => (`F${index}_`).padEnd(160, 'a'));
  const extensions = [...Array.from({ length: 50 }, (_, index) => (`G${index}_`).padEnd(160, 'a')), 'G'.repeat(30)];
  const boundary = { supported_abis: ['x'], supported_locales: ['y'], screen_density: 1, sdk_version: 1, device_features: features, gl_extensions: extensions, codename: 'C'.repeat(80), device_tier: 'T'.repeat(80) };
  const packages = createPackageAnalysis(gateway(() => output(boundary)));
  await packages.extractSplits({ artifact_id: source, device_spec: boundary }, signal());
  assert.throws(() => packages.extractSplits({ artifact_id: source, device_spec: { ...boundary, gl_extensions: [...extensions.slice(0, -1), 'G'.repeat(31)] } }, signal()), ApiError);
  packages.dispose();
});

test('高级返回规格逐字段及顺序核对，缺失有值字段、乱序或错值保留结果日志失败', async () => {
  const requested = { ...spec, device_features: ['one', 'two'], gl_extensions: ['GL_ONE'], codename: 'Preview', device_tier: 'tier-2' };
  const bad: unknown[] = [spec, { ...requested, device_features: ['two', 'one'] }, { ...requested, gl_extensions: ['GL_TWO'] }, { ...requested, codename: null }, { ...requested, device_tier: 'tier-3' }, { ...requested, device_tier: 2 }];
  for (const returned of bad) {
    const packages = createPackageAnalysis(gateway(() => output(returned)));
    await assert.rejects(packages.extractSplits({ artifact_id: source, device_spec: requested }, signal()), (error: unknown) => error instanceof ApiError && error.logId === 'submit-log');
    packages.dispose();
  }
});

test('高级输入复制数组；等待期间修改调用者数据不影响发送或结果关联', async () => {
  const pending = deferred<ApiResult<TaskRecord>>(); let sent: unknown;
  const features = ['camera']; const extensions = ['GL_EXT']; const modules = ['base'];
  const requested = { ...spec, device_features: features, gl_extensions: extensions };
  const original = structuredClone(requested);
  const packages = createPackageAnalysis({ ...gateway(), submit: async (_operation, input) => { sent = input; return pending.promise; } });
  const request = packages.extractSplits({ artifact_id: source, device_spec: requested, modules, instant: true }, signal());
  features.push('new'); extensions[0] = 'changed'; modules.push('feature');
  assert.deepEqual(sent, { artifact_id: source, device_spec: original, modules: ['base'], instant: true });
  pending.resolve({ data: job(output(original)), logId: 'submit-log' });
  await request; packages.dispose();
});

test('高级任务恢复沿原规格且不重提交，不补造结果未回显的modules或sourceID', async () => {
  let submissions = 0;
  const extended: PackageDeviceSpec = { ...spec, device_tier: 'tier-2' };
  const packages = createPackageAnalysis({ ...gateway(), submit: async () => { submissions++; return { data: job(output(extended)), logId: 'submit-log' }; }, getJob: async () => ({ data: job(output(extended)), logId: 'query-log' }) });
  const ticket = { id: 'apks-job', operation: 'plugin.android-packages.extract_splits', submitLogId: 'old-log' };
  const restored = await packages.resumeExtractSplits(ticket, { artifact_id: source, device_spec: extended, modules: ['ALL'], instant: true }, signal());
  assert.equal(restored.submitLogId, 'old-log'); assert.equal(restored.logId, 'query-log');
  assert.equal(Object.hasOwn(restored.data.result, 'source_artifact_id'), false);
  assert.equal(Object.hasOwn(restored.data.result, 'modules'), false);
  assert.equal(submissions, 0);
  packages.dispose();
});

test('安装助手只准备动作input中的artifact_id与modules，拒绝instant和device_spec', () => {
  const modules = ['base', 'feature'];
  const input = prepareApksInstallInput({ artifact_id: source.toUpperCase(), modules });
  modules.push('other');
  assert.deepEqual(input, { artifact_id: source, modules: ['base', 'feature'] });
  assert.deepEqual(prepareApksInstallInput({ artifact_id: source }), { artifact_id: source });
  assert.deepEqual(prepareApksInstallInput({ artifact_id: source, modules: null }), { artifact_id: source, modules: null });
  assert.ok(Object.isFrozen(input.modules));
  for (const changes of [{ instant: true }, { device_spec: spec }, { device_id: 'serial' }, { modules: ['ALL', 'base'] }]) assert.throws(() => prepareApksInstallInput({ artifact_id: source, ...changes }), ApiError);
});
