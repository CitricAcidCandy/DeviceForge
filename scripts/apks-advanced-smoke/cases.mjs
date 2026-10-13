import assert from 'node:assert/strict';
import { advancedPrivate, advancedSpec, apkEntries, apks, basicPrivate, basicSpec, extractOperation, installOperation, serial } from './contracts.mjs';
import { callKeys, emptyScratch, finished, release, started } from './fixtures.mjs';
import { download, upload } from './artifacts.mjs';
import { record, submit } from './jobs.mjs';

export async function extraction(context, { caseId, advanced = false, alias = false, transport = 'http', empty = false, all = false } = {}) {
  const deviceSpec = advanced ? advancedSpec : empty ? { ...basicSpec, device_features: [], gl_extensions: [], codename: null, device_tier: null } : basicSpec;
  const input = { artifact_id: context.source.id, device_spec: deviceSpec,
    ...(advanced ? { modules: ['base', 'feature_1'], instant: true } : empty ? { modules: null, instant: false } : all ? { modules: ['ALL'] } : {}) };
  const previous = await callKeys(context.tool);
  const entry = await submit(context, { caseId, operation: alias ? 'android.package.extract_splits' : extractOperation, input, transport });
  const call = await started(context, previous, { pluginId: 'android-packages', command: 'extract-apks', inputBytes: apks,
    privateBytes: advanced ? advancedPrivate : basicPrivate, modules: input.modules, instant: input.instant });
  assert.equal((await context.host.client.job(entry.job_id)).status, 'running');
  await release(call);
  const value = await record(context, entry);
  const expected = { device_spec: advanced ? advancedSpec : basicSpec, apk_entries: apkEntries };
  if (alias) {
    assert.deepEqual(Object.keys(value.result).sort(), ['artifact', 'source_artifact_id', 'device_spec', 'apk_entries'].sort());
    assert.equal(value.result.source_artifact_id, context.source.id);
    assert.deepEqual(value.result.device_spec, expected.device_spec);
    assert.deepEqual(value.result.apk_entries, apkEntries);
    entry.artifact = value.result.artifact;
  } else {
    assert.deepEqual(Object.keys(value.result).sort(), ['artifacts', 'result']);
    assert.deepEqual(value.result.result, expected);
    assert.equal(value.result.artifacts.length, 1);
    entry.artifact = value.result.artifacts[0];
  }
  await download(context, entry.artifact);
  await finished(context, call);
  context.report.checks.push({ name: caseId + ' 固定argv/私有JSON/产物及原字节', passed: true });
  return entry;
}

export async function discover(context) {
  const previous = await callKeys(context.tool);
  const entry = await submit(context, { caseId: 'Android发现建立设备动作资格', operation: 'plugin.android-device.discover', input: {} });
  const call = await started(context, previous, { pluginId: 'android-device', command: 'discover' });
  await release(call);
  await record(context, entry);
  await finished(context, call);
  const providers = await context.host.client.json('/api/v2/device-providers');
  assert.equal(providers.length, 1);
  context.provider = providers[0];
  const directories = await context.host.client.json('/api/v2/devices');
  assert.deepEqual(await context.host.client.tool('deviceforge.list_devices', {}), directories);
  assert.equal(directories.length, 1);
  const directory = directories[0];
  assert.deepEqual(directory.provider, context.provider);
  assert.equal(directory.discovery_job_id, entry.job_id);
  assert.equal(directory.devices.length, 1);
  const device = directory.devices[0];
  assert.deepEqual(device.reference, { provider_id: context.provider.id, generation: context.provider.generation, local_id: serial });
  assert.equal(device.state, 'online');
  assert.equal(device.raw_state, 'device');
  assert.equal(device.model, '公开APKS夹具');
  assert.ok(device.capabilities.some(value => value.id === 'app.install_apks' && value.version === 1 && value.available));
  context.report.device_directory = directory;
  context.report.checks.push({ name: '公开提供者代次与在线设备资格', passed: true });
}

export async function installation(context, { caseId, modules, transport = 'http', capability = false, prepared } = {}) {
  const business = prepared ?? { artifact_id: context.source.id, ...(modules !== undefined ? { modules } : {}) };
  const input = capability ? { provider_id: context.provider.id, generation: context.provider.generation,
    device_id: serial, capability: 'app.install_apks', version: 1, input: business } : { device_id: serial, input: business };
  const previous = await callKeys(context.tool);
  const entry = await submit(context, { caseId, operation: installOperation, input, transport, capability });
  const call = await started(context, previous, { pluginId: 'android-device', command: 'install-apks', inputBytes: apks,
    modules, deviceId: serial });
  await release(call);
  const value = await record(context, entry);
  assert.deepEqual(value.result, { result: { artifact_id: context.source.id, device_id: serial, installed: true }, artifacts: [] });
  await finished(context, call);
  context.report.checks.push({ name: caseId + ' 嵌套modules/固定argv/稳定授权副本', passed: true });
}

export async function inputRules(context) {
  const before = await callKeys(context.tool), jobs = await context.host.client.json('/api/v2/jobs?limit=100');
  const invalid = [
    [extractOperation, { artifact_id: context.source.id, device_spec: basicSpec, modules: [] }],
    [extractOperation, { artifact_id: context.source.id, device_spec: basicSpec, modules: ['base', 'base'] }],
    [extractOperation, { artifact_id: context.source.id, device_spec: basicSpec, modules: ['--module'] }],
    [extractOperation, { artifact_id: context.source.id, device_spec: basicSpec, instant: null }],
    [extractOperation, { artifact_id: context.source.id, device_spec: { ...basicSpec, device_features: null } }],
    [extractOperation, { artifact_id: context.source.id, device_spec: { ...basicSpec, device_tier: 2 } }],
    [installOperation, { device_id: serial, input: { artifact_id: context.source.id }, modules: ['base'] }],
    [installOperation, { device_id: serial, input: { artifact_id: context.source.id, instant: true } }],
    ['android.package.extract_splits', { artifact_id: context.source.id, device_spec: advancedSpec }],
  ];
  for (const [operation, input] of invalid) {
    await context.host.client.post('/api/v2/jobs', { operation, input }, { status: 400, code: 'invalid_input' });
    await context.host.client.tool(operation, input, 'invalid_input');
  }
  assert.deepEqual(await callKeys(context.tool), before);
  assert.deepEqual(await context.host.client.json('/api/v2/jobs?limit=100'), jobs);
  context.report.checks.push({ name: '九类非法字段HTTP/MCP准入拒绝，旧alias未扩写且零Job零工具', passed: true });
  const longFeatures = Array.from({ length: 256 }, (_, index) => 'F' + String(index).padStart(3, '0') + 'x'.repeat(156));
  const longGl = Array.from({ length: 52 }, (_, index) => 'G' + String(index).padStart(3, '0') + 'y'.repeat(156));
  const stringBytes = [...basicSpec.supported_abis, ...basicSpec.supported_locales, ...longFeatures, ...longGl]
    .reduce((total, value) => total + Buffer.byteLength(value), 0);
  assert.ok(stringBytes > 48 * 1024);
  assert.ok([...longFeatures, ...longGl].every(value => Buffer.byteLength(value) === 160 && /^[A-Za-z0-9_.:-]+$/.test(value)));
  assert.equal(new Set(longFeatures).size, 256);
  assert.equal(new Set(longGl).size, 52);
  context.report.cumulative_spec_rule = { features: 256, gl_extensions: 52, element_bytes: 160, string_bytes: stringBytes, maximum_bytes: 48 * 1024 };
  for (const [caseId, operation, input, expectedError] of [
    ['提取ALL混用运行规则', extractOperation, { artifact_id: context.source.id, device_spec: basicSpec, modules: ['ALL', 'base'] }, 'APKS模块选择无效'],
    ['安装ALL混用运行规则', installOperation, { device_id: serial, input: { artifact_id: context.source.id, modules: ['ALL', 'base'] } }, 'APKS模块选择无效'],
    ['设备字符串累计48KiB限额', extractOperation, { artifact_id: context.source.id, device_spec: { ...basicSpec, device_features: longFeatures, gl_extensions: longGl } }, '设备规格列表或数值无效'],
  ]) {
    const previous = await callKeys(context.tool);
    const entry = await submit(context, { caseId, operation, input, transport: 'mcp', expectedStatus: 'failed' });
    const job = await record(context, entry);
    assert.equal(job.result, null);
    assert.equal(job.error, '依赖执行失败：输入无效：' + expectedError);
    assert.deepEqual(await callKeys(context.tool), previous);
    await emptyScratch(context);
    context.report.checks.push({ name: caseId + ' 业务失败且零Java', passed: true });
  }
  const wrong = await upload(context, '结构APKS显示为zip.zip', apks);
  const previous = await callKeys(context.tool);
  const entry = await submit(context, { caseId: '安装显示名资格不接受zip', operation: installOperation,
    input: { device_id: serial, input: { artifact_id: wrong.id } }, expectedStatus: 'failed' });
  const failed = await record(context, entry);
  assert.equal(failed.result, null);
  assert.match(failed.error, /APKS|apks/);
  assert.deepEqual(await callKeys(context.tool), previous);
  await emptyScratch(context);
  context.report.checks.push({ name: '输入显示名资格拒绝且零Java', passed: true });
}
