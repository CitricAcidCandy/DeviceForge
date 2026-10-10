import { spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { deployMessagePackPlugin, verifyMessagePack } from './msgpack-smoke.mjs';
import { deployAndroidPackages } from './android-packages-deployment.mjs';

const temporaryParent = resolve(tmpdir());
const temporary = await mkdtemp(join(temporaryParent, 'deviceforge-smoke-'));
if (dirname(resolve(temporary)) !== temporaryParent || !basename(temporary).startsWith('deviceforge-smoke-')) {
  throw new Error('模拟服务清理目录越过本次临时父目录');
}
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
const token = randomBytes(32).toString('hex');
const suffix = process.platform === 'win32' ? '.exe' : '';
const profile = process.argv.includes('--release') ? 'release' : 'debug';
const binary = resolve('target', profile, `apk-server${suffix}`);
const plugin = resolve('target', profile, `deviceforge-echo-plugin${suffix}`);
const pluginDirectory = join(temporary, 'plugins', 'echo');
await mkdir(pluginDirectory, { recursive: true });
await writeFile(join(pluginDirectory, 'manifest.json'), JSON.stringify({
  id: 'echo', version: '0.1.0', protocol_version: 1, executable: plugin, args: [],
  operations: [{ name: 'echo', title: '回显', input_schema: { type: 'object' } }],
}));
const artifactPlugin = resolve('target', profile, `deviceforge-artifact-copy-plugin${suffix}`);
const artifactPluginDirectory = join(temporary, 'plugins', 'artifact_copy');
await mkdir(artifactPluginDirectory, { recursive: true });
await writeFile(join(artifactPluginDirectory, 'manifest.json'), JSON.stringify({
  id: 'artifact_copy', version: '0.1.0', protocol_version: 2, executable: artifactPlugin, args: [],
  artifacts: { input_fields: ['artifact_id'], outputs: true },
  operations: [{ name: 'copy', title: '复制产物', input_schema: { type: 'object', properties: { artifact_id: { type: 'string', format: 'uuid' } }, required: ['artifact_id'], additionalProperties: false } }],
}));
const selectedPerformanceDemo = process.argv.includes('--performance-plugin');
await deployMessagePackPlugin(temporary, suffix, profile);
const performancePlugin = resolve('target', profile, `deviceforge-performance-demo-plugin${suffix}`);
const performancePluginDirectory = join(temporary, 'plugins', 'performance_demo');
await mkdir(performancePluginDirectory, { recursive: true });
await writeFile(join(performancePluginDirectory, 'manifest.json'), JSON.stringify({
  id: 'performance_demo', version: '0.1.0', protocol_version: 2, executable: performancePlugin, args: [],
  performance: { sample_operation: 'sample', fps: true },
  operations: [{ name: 'sample', title: '合成性能协议示例', input_schema: { type: 'object', properties: { device_id: { type: 'string' }, package: { type: 'string' } }, required: ['device_id', 'package'], additionalProperties: false } }],
}));
// 模拟工具仅部署在本次集成测试的临时目录，不依赖真机。
const deviceTool = join(temporary, `device-tool${suffix}`);
const packageTool = join(temporary, `package-tool${suffix}`);
try {
  await promisify(execFile)('rustc', [resolve('crates/infrastructure/src/device_artifacts/fixtures/device-tool.rs'), '-o', deviceTool], { windowsHide: true });
  await promisify(execFile)('rustc', [resolve('crates/infrastructure/src/package_tools/fixtures/package-tool.rs'), '-o', packageTool], { windowsHide: true });
} catch (error) {
  await rm(temporary, { recursive: true, force: true });
  throw error;
}
// 签名文件仅供模拟 bundletool 检查，不包含真实密钥或口令。
const signingFile = join(temporary, 'test-signing.txt');
await writeFile(signingFile, 'test-only');
const packageDeployment = await deployAndroidPackages(temporary, packageTool, signingFile, suffix, profile);
const environment = { ...process.env };
delete environment.APK_APKSIGNER_JAR;
delete environment.APK_PERFORMANCE_PLUGIN;
if (selectedPerformanceDemo) environment.APK_PERFORMANCE_PLUGIN = 'performance_demo';
const serverEnvironment = { ...environment, APK_API_TOKEN: token, APK_BIND: `127.0.0.1:${port}`, APK_DATA_DIR: join(temporary, 'data'), APK_PLUGIN_DIR: join(temporary, 'plugins'), APK_OPERATION_BINDINGS: packageDeployment.bindings, APK_ADB: deviceTool, APK_HDC: deviceTool, APK_APKANALYZER: packageTool, APK_APKSIGNER: packageTool, APK_JAVA: packageTool, APK_BUNDLETOOL_JAR: 'mock-bundletool.jar', APK_APKTOOL_JAR: 'mock-apktool.jar', APK_BUNDLE_KEYSTORE: signingFile, APK_BUNDLE_KEY_ALIAS: 'test-key', APK_BUNDLE_STORE_PASSWORD_FILE: signingFile, APK_BUNDLE_KEY_PASSWORD_FILE: signingFile };
// 宿主不再消费包业务签名环境；实际签名资格由独立插件旁置配置验证。
serverEnvironment.APK_BUNDLE_KEYSTORE = join(temporary, 'host-must-not-read-signing.jks');
delete serverEnvironment.APK_BUNDLE_KEY_PASSWORD_FILE;
const child = spawn(binary, [], {
  env: serverEnvironment,
  stdio: 'ignore', windowsHide: true,
});
let spawnFailure;
child.on('error', (error) => { spawnFailure = error; });
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const deadline = Date.now() + 15000;
try {
  let ready = false;
  while (Date.now() < deadline) {
    if (spawnFailure) throw spawnFailure;
    if (child.exitCode !== null) throw new Error('服务启动后提前退出');
    try { ready = (await fetch(`${base}/api/v1/health`, { headers, signal: AbortSignal.timeout(500) })).ok; } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, '服务应在期限内启动');
  if (selectedPerformanceDemo) {
    const listed = await (await fetch(`${base}/api/v2/plugins`, { headers })).json();
    assert.equal(listed.data.find((plugin) => plugin.id === 'performance_demo').protected, true);
    const rejected = await fetch(`${base}/api/v2/plugins/performance_demo/unload`, { method: 'POST', headers });
    assert.equal(rejected.status, 409);
    const body = await rejected.json();
    assert.equal(body.log_id, rejected.headers.get('x-deviceforge-log-id'));
  }
  assert.equal((await fetch(`${base}/api/v1/health`)).status, 401);
  const operations = await (await fetch(`${base}/api/v1/operations`, { headers })).json();
  assert.ok(operations.some((operation) => operation.id === 'plugin.echo.echo'));
  const submitted = await fetch(`${base}/api/v1/jobs`, { method: 'POST', headers, body: JSON.stringify({ operation: 'plugin.echo.echo', input: { message: '真实服务器插件验证' } }) });
  assert.equal(submitted.status, 202);
  const queued = await submitted.json();
  let job;
  while (Date.now() < deadline) {
    job = await (await fetch(`${base}/api/v1/jobs/${queued.id}`, { headers })).json();
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(job.status, 'succeeded');
  assert.deepEqual(job.result, { message: '真实服务器插件验证' });
  const events = await (await fetch(`${base}/api/v1/jobs/${queued.id}/events`, { headers })).json();
  assert.deepEqual(events.map((event) => event.status), ['queued', 'running', 'succeeded']);
  const archive = Buffer.from('UEsDBBQAAAAIAHaYSF3XonWNIQAAABgAAAATAAAAQW5kcm9pZE1hbmlmZXN0LnhtbHJJLctMTnXLL0pPVXixf8KLhT0vV/W8WN8IAAAA//8DAFBLAQIUABQAAAAIAHaYSF3XonWNIQAAABgAAAATAAAAAAAAAAAAAAAAAAAAAABBbmRyb2lkTWFuaWZlc3QueG1sUEsFBgAAAAABAAEAQQAAAFIAAAAAAA==', 'base64');
  const uploaded = await fetch(`${base}/api/v1/artifacts?filename=smoke.apk`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: archive,
  });
  assert.equal(uploaded.status, 201);
  const artifact = await uploaded.json();
  assert.equal(artifact.size, archive.length);
  assert.equal(artifact.sha256, createHash('sha256').update(archive).digest('hex'));
  const downloaded = await fetch(`${base}/api/v1/artifacts/${artifact.id}/content`, { headers });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), archive);
  const entries = await (await fetch(`${base}/api/v1/artifacts/${artifact.id}/entries`, { headers })).json();
  assert.equal(entries.entries[0].name, 'AndroidManifest.xml');
  assert.ok(operations.some((operation) => operation.id === 'artifact.inspect'));
  const deviceOperations = ['android.app.install', 'android.app.uninstall', 'android.screenshot', 'harmony.app.install', 'harmony.app.uninstall', 'android.input'];
  for (const id of deviceOperations) assert.ok(operations.some((operation) => operation.id === id));
  const mcpHeaders = { ...headers, accept: 'application/json, text/event-stream', host: `127.0.0.1:${port}` };
  const discovered = await fetch(`${base}/mcp`, { method: 'POST', headers: mcpHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  assert.equal(discovered.status, 200);
  const mcp = await discovered.json();
  for (const id of deviceOperations) assert.ok(mcp.result.tools.some((tool) => tool.name === id));
  async function finished(id) {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const job = await (await fetch(`${base}/api/v1/jobs/${id}`, { headers })).json();
      if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('设备任务未在期限内完成');
  }
  async function deviceJob(operation, input) {
    const response = await fetch(`${base}/api/v1/jobs`, { method: 'POST', headers, body: JSON.stringify({ operation, input }) });
    assert.equal(response.status, 202);
    return finished((await response.json()).id);
  }
  // 验证输入命令在共享任务层中的四种动作，以及设备端引用后的文本。
  for (const action of [
    { kind: 'tap', x: 17, y: 42 },
    { kind: 'swipe', x1: 0, y1: 20, x2: 30, y2: 40, duration_ms: 300 },
    { kind: 'keyevent', key_code: 4, long_press: true },
  ]) {
    const inputJob = await deviceJob('android.input', { device_id: 'input-ok', action });
    assert.equal(inputJob.status, 'succeeded');
    assert.deepEqual(inputJob.result, { device_id: 'input-ok', action: action.kind, dispatched: true });
  }
  const inputCall = await fetch(`${base}/mcp`, { method: 'POST', headers: mcpHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'android.input', arguments: { device_id: 'input-ok', action: { kind: 'text', text: "safe '$()' %s", enter: true } } } }) });
  assert.equal(inputCall.status, 200);
  const inputReply = await inputCall.json();
  assert.equal(inputReply.result.isError, false);
  const inputJob = await finished(inputReply.result.structuredContent.id);
  assert.equal(inputJob.status, 'succeeded');
  assert.equal(inputJob.result.dispatched, true);
  assert.equal(await readFile(join(temporary, 'input-observed'), 'utf8'), "tap:17,42\nswipe:0,20,30,40,300\nkeyevent:--longpress,4\ntext:safe '$()' %\ntext:s\nkeyevent:66\n");
  assert.equal((await deviceJob('android.input', { device_id: 'input-error', action: { kind: 'tap', x: 0, y: 0 } })).status, 'failed');
  const invalidInput = await fetch(`${base}/api/v1/jobs`, { method: 'POST', headers, body: JSON.stringify({ operation: 'android.input', input: { device_id: 'input-ok', action: { kind: 'tap', x: -1, y: 0 } } }) });
  assert.equal(invalidInput.status, 400);
  const performanceOps = ['start', 'inspect', 'pause', 'resume', 'stop', 'samples', 'list', 'capabilities'].map((name) => `android.performance.${name}`);
  for (const id of performanceOps) {
    assert.ok(operations.some((operation) => operation.id === id));
    assert.ok(mcp.result.tools.some((tool) => tool.name === id));
  }
  const performanceStart = await deviceJob('android.performance.start', { target: { device_id: 'perf.smoke', package: 'com.example.app' }, interval_ms: 1000, duration_secs: 30 });
  assert.equal(performanceStart.status, 'succeeded');
  const session_id = performanceStart.result.id;
  async function performanceJob(name, input) {
    const job = await deviceJob(`android.performance.${name}`, input);
    assert.equal(job.status, 'succeeded', job.error);
    return job.result;
  }
  async function performanceWait(minimum) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const session = await performanceJob('inspect', { session_id });
      assert.equal(session.state, 'running', session.error);
      if (session.samples >= minimum) return session;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('性能采样未产生预期样本');
  }
  await performanceWait(2);
  const performancePage = await performanceJob('samples', { session_id, after: 0, limit: 100 });
  assert.equal(performancePage.readings[0].cpu_share_percent, null);
  if (selectedPerformanceDemo) {
    assert.ok(Math.abs(performancePage.readings[1].cpu_share_percent - 10) < 0.2);
    assert.ok(Math.abs(performancePage.readings[1].cpu_core_percent - 20) < 0.4);
    assert.equal(performancePage.readings[0].fps, 60);
    assert.deepEqual(performancePage.readings[0].frame_window, { frames: 60, duration_ms: 1000, source: 'synthetic_demo' });
  } else {
    assert.equal(performancePage.readings[1].cpu_share_percent, 10);
    assert.equal(performancePage.readings[1].cpu_core_percent, 20);
    assert.equal(performancePage.readings[0].fps, undefined);
  }
  assert.equal(performancePage.readings[1].pss_kib, 2048);
  assert.equal(performancePage.readings[1].rss_kib, 4096);
  const performancePauseCall = await fetch(`${base}/mcp`, { method: 'POST', headers: mcpHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'android.performance.pause', arguments: { session_id } } }) });
  assert.equal(performancePauseCall.status, 200);
  const performancePauseReply = await performancePauseCall.json();
  assert.equal(performancePauseReply.result.isError, false);
  const performancePaused = await finished(performancePauseReply.result.structuredContent.id);
  assert.equal(performancePaused.status, 'succeeded');
  assert.equal(performancePaused.result.state, 'paused');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal((await performanceJob('inspect', { session_id })).samples, performancePaused.result.samples);
  await performanceJob('resume', { session_id });
  await performanceWait(performancePaused.result.samples + 1);
  const resumedPage = await performanceJob('samples', { session_id, after: performancePaused.result.samples, limit: 100 });
  assert.equal(resumedPage.readings[0].cpu_share_percent, null);
  assert.equal((await performanceJob('stop', { session_id })).state, 'stopped');
  const performanceList = await performanceJob('list', { after_id: null, limit: 100 });
  assert.ok(performanceList.sessions.some((session) => session.id === session_id && session.state === 'stopped'));
  const performanceCapabilities = await performanceJob('capabilities', {});
  assert.equal(performanceCapabilities.fps, selectedPerformanceDemo);
  assert.equal(performanceCapabilities.source, selectedPerformanceDemo ? 'plugin.performance_demo' : 'android_adb');
  const installed = await deviceJob('android.app.install', { device_id: 'ok', artifact_id: artifact.id });
  assert.equal(installed.status, 'succeeded');
  assert.equal(installed.result.artifact_id, artifact.id);
  assert.equal((await deviceJob('android.app.install', { device_id: 'stderr-failure', artifact_id: artifact.id })).status, 'failed');
  for (const operation of ['android.app.uninstall', 'harmony.app.uninstall']) {
    assert.equal((await deviceJob(operation, { device_id: 'ok', package: 'com.example.app' })).status, 'succeeded');
  }
  const hapResponse = await fetch(`${base}/api/v1/artifacts?filename=smoke.hap`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: archive,
  });
  assert.equal(hapResponse.status, 201);
  const hap = await hapResponse.json();
  assert.equal((await deviceJob('harmony.app.install', { device_id: 'ok', artifact_id: hap.id })).status, 'succeeded');
  const screenshotCall = await fetch(`${base}/mcp`, { method: 'POST', headers: mcpHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'android.screenshot', arguments: { device_id: 'ok' } } }) });
  assert.equal(screenshotCall.status, 200);
  const screenshotReply = await screenshotCall.json();
  assert.equal(screenshotReply.result.isError, false);
  const screenshot = await finished(screenshotReply.result.structuredContent.id);
  assert.equal(screenshot.status, 'succeeded');
  assert.equal(screenshot.result.media_type, 'image/png');
  const pngResponse = await fetch(`${base}/api/v1/artifacts/${screenshot.result.id}/content`, { headers });
  assert.equal(pngResponse.status, 200);
  const png = Buffer.from(await pngResponse.arrayBuffer());
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(createHash('sha256').update(png).digest('hex'), screenshot.result.sha256);
  // 构造单条目的存储 ZIP，覆盖 APKS 提取与安装的完整产物链路。
  function storedZip(name, content) {
    const filename = Buffer.from(name);
    let crc = 0xffffffff;
    for (const byte of content) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22); local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24); central.writeUInt16LE(filename.length, 28);
    const footer = Buffer.alloc(22);
    footer.writeUInt32LE(0x06054b50); footer.writeUInt16LE(1, 8); footer.writeUInt16LE(1, 10);
    footer.writeUInt32LE(central.length + filename.length, 12);
    footer.writeUInt32LE(local.length + filename.length + content.length, 16);
    return Buffer.concat([local, filename, content, central, filename, footer]);
  }
  const apksUpload = await fetch(`${base}/api/v1/artifacts?filename=smoke.apks`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: storedZip('universal.apk', archive),
  });
  assert.equal(apksUpload.status, 201);
  const apks = await apksUpload.json();
  const extracted = await deviceJob('android.package.extract_apk', { artifact_id: apks.id, entry: 'universal.apk' });
  assert.equal(extracted.status, 'succeeded');
  assert.equal(extracted.result.artifact.sha256, artifact.sha256);
  assert.equal((await deviceJob('android.app.install', { device_id: 'ok', artifact_id: extracted.result.artifact.id })).status, 'succeeded');
  const invalidModule = await fetch(`${base}/api/v1/jobs`, { method: 'POST', headers, body: JSON.stringify({ operation: 'android.package.manifest', input: { artifact_id: apks.id, module: '../bad' } }) });
  assert.equal(invalidModule.status, 400);
  const packageOperations = ['android.package.manifest', 'android.package.signature', 'android.package.extract_apk'];
  for (const id of packageOperations) {
    assert.ok(operations.some((operation) => operation.id === id));
    assert.ok(mcp.result.tools.some((tool) => tool.name === id));
  }
  const manifestJob = await deviceJob('android.package.manifest', { artifact_id: artifact.id });
  assert.equal(manifestJob.status, 'succeeded');
  assert.equal(manifestJob.result.package_name, 'com.example.app');
  assert.equal(manifestJob.result.version_name, '1 & 2');
  const signatureCall = await fetch(`${base}/mcp`, { method: 'POST', headers: mcpHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'android.package.signature', arguments: { artifact_id: artifact.id } } }) });
  assert.equal(signatureCall.status, 200);
  const signatureReply = await signatureCall.json();
  const signatureJob = await finished(signatureReply.result.structuredContent.id);
  assert.equal(signatureJob.status, 'succeeded');
  assert.equal(signatureJob.result.signers[0].certificate_sha256, 'ab'.repeat(32));
  const aabUpload = await fetch(`${base}/api/v1/artifacts?filename=smoke.aab`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: archive,
  });
  assert.equal(aabUpload.status, 201);
  const aab = await aabUpload.json();
  const aabJob = await deviceJob('android.package.manifest', { artifact_id: aab.id });
  assert.equal(aabJob.status, 'succeeded');
  assert.equal(aabJob.result.module, 'base');
  assert.ok(operations.some((operation) => operation.id === 'android.package.build_apks'));
  assert.ok(mcp.result.tools.some((tool) => tool.name === 'android.package.build_apks'));
  const rejectedBuild = await fetch(`${base}/api/v1/jobs`, { method: 'POST', headers, body: JSON.stringify({ operation: 'android.package.build_apks', input: { artifact_id: aab.id, mode: 'universal', keystore: 'request.jks' } }) });
  assert.equal(rejectedBuild.status, 400);
  const defaultBuild = await deviceJob('android.package.build_apks', { artifact_id: aab.id, mode: 'default' });
  assert.equal(defaultBuild.status, 'succeeded');
  assert.equal(defaultBuild.result.apk_count, 2);
  assert.equal(defaultBuild.result.universal_entry, null);
  const universalCall = await fetch(`${base}/mcp`, { method: 'POST', headers: mcpHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 32, method: 'tools/call', params: { name: 'android.package.build_apks', arguments: { artifact_id: aab.id, mode: 'universal' } } }) });
  assert.equal(universalCall.status, 200);
  const universalReply = await universalCall.json();
  const universalBuild = await finished(universalReply.result.structuredContent.id);
  assert.equal(universalBuild.status, 'succeeded');
  assert.equal(universalBuild.result.apk_count, 1);
  assert.equal(universalBuild.result.universal_entry, 'universal.apk');
  assert.equal(universalBuild.result.source_artifact_id, aab.id);
  const builtDownload = await fetch(`${base}/api/v1/artifacts/${universalBuild.result.artifact.id}/content`, { headers });
  assert.equal(builtDownload.status, 200);
  const builtBytes = Buffer.from(await builtDownload.arrayBuffer());
  assert.equal(createHash('sha256').update(builtBytes).digest('hex'), universalBuild.result.artifact.sha256);
  const universalApk = await deviceJob('android.package.extract_apk', { artifact_id: universalBuild.result.artifact.id, entry: universalBuild.result.universal_entry });
  assert.equal(universalApk.status, 'succeeded');
  assert.equal((await deviceJob('android.app.install', { device_id: 'ok', artifact_id: universalApk.result.artifact.id })).status, 'succeeded');
  for (const id of ['android.package.extract_splits', 'android.app.install_apks']) {
    assert.ok(operations.some((operation) => operation.id === id));
    assert.ok(mcp.result.tools.some((tool) => tool.name === id));
  }
  const deviceSpec = { supported_abis: ['arm64-v8a'], supported_locales: ['zh_CN'], screen_density: 480, sdk_version: 35 };
  const selected = await deviceJob('android.package.extract_splits', { artifact_id: defaultBuild.result.artifact.id, device_spec: deviceSpec });
  assert.equal(selected.status, 'succeeded');
  assert.deepEqual(selected.result.apk_entries, ['base-arm64.apk', 'base-master.apk']);
  assert.deepEqual(selected.result.device_spec, deviceSpec);
  const selectedDownload = await fetch(`${base}/api/v1/artifacts/${selected.result.artifact.id}/content`, { headers });
  assert.equal(selectedDownload.status, 200);
  assert.equal(createHash('sha256').update(Buffer.from(await selectedDownload.arrayBuffer())).digest('hex'), selected.result.artifact.sha256);
  const selectedEntries = await (await fetch(`${base}/api/v1/artifacts/${selected.result.artifact.id}/entries`, { headers })).json();
  assert.deepEqual(selectedEntries.entries.map((entry) => entry.name), selected.result.apk_entries);
  const installApksCall = await fetch(`${base}/mcp`, { method: 'POST', headers: mcpHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 35, method: 'tools/call', params: { name: 'android.app.install_apks', arguments: { artifact_id: defaultBuild.result.artifact.id, device_id: 'ok' } } }) });
  assert.equal(installApksCall.status, 200);
  const installApksReply = await installApksCall.json();
  const installedApks = await finished(installApksReply.result.structuredContent.id);
  assert.equal(installedApks.status, 'succeeded');
  assert.deepEqual(installedApks.result, { artifact_id: defaultBuild.result.artifact.id, device_id: 'ok', installed: true });
  const rejectedAdb = await fetch(`${base}/api/v1/jobs`, { method: 'POST', headers, body: JSON.stringify({ operation: 'android.app.install_apks', input: { artifact_id: defaultBuild.result.artifact.id, device_id: 'ok', adb: 'request-tool' } }) });
  assert.equal(rejectedAdb.status, 400);
  const failedApks = await deviceJob('android.app.install_apks', { artifact_id: defaultBuild.result.artifact.id, device_id: 'offline' });
  assert.equal(failedApks.status, 'failed');
  for (const id of ['android.package.decode', 'android.package.scan_sdks']) {
    assert.ok(operations.some((operation) => operation.id === id));
    assert.ok(mcp.result.tools.some((tool) => tool.name === id));
  }
  const decoded = await deviceJob('android.package.decode', { artifact_id: artifact.id });
  assert.equal(decoded.status, 'succeeded');
  assert.equal(decoded.result.files, 3);
  assert.equal(decoded.result.artifact.filename, 'decoded.zip');
  const scanCall = await fetch(`${base}/mcp`, { method: 'POST', headers: mcpHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
    name: 'android.package.scan_sdks', arguments: { artifact_id: decoded.result.artifact.id, rules: [
      { name: '测试 SDK', package_path: 'com.example.sdk', class_name: 'Entry$Inner' },
      { name: '缺失检测点', package_path: 'com.example.sdk', class_name: 'Missing' },
    ] },
  } }) });
  assert.equal(scanCall.status, 200);
  const scanReply = await scanCall.json();
  const scan = await finished(scanReply.result.structuredContent.id);
  assert.equal(scan.status, 'succeeded');
  assert.equal(scan.result.findings[0].class_found, true);
  assert.equal(scan.result.findings[1].package_found, true);
  assert.equal(scan.result.findings[1].class_found, false);
  const decodedContent = await fetch(`${base}/api/v1/artifacts/${decoded.result.artifact.id}/content`, { headers });
  assert.equal(decodedContent.status, 200);
  const decodedBytes = Buffer.from(await decodedContent.arrayBuffer());
  assert.equal(createHash('sha256').update(decodedBytes).digest('hex'), decoded.result.artifact.sha256);
  assert.ok(mcp.result.tools.some((tool) => tool.name === 'plugin.artifact_copy.copy'));
  const copied = await deviceJob('plugin.artifact_copy.copy', { artifact_id: artifact.id });
  assert.equal(copied.status, 'succeeded');
  assert.equal(copied.result.result.source_artifact_id, artifact.id);
  assert.equal(copied.result.artifacts.length, 1);
  assert.equal(copied.result.artifacts[0].sha256, artifact.sha256);
  assert.notEqual(copied.result.artifacts[0].id, artifact.id);
  const pluginCopyCall = await fetch(`${base}/mcp`, { method: 'POST', headers: mcpHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'plugin.artifact_copy.copy', arguments: { artifact_id: screenshot.result.id } } }) });
  assert.equal(pluginCopyCall.status, 200);
  const pluginCopyReply = await pluginCopyCall.json();
  const pngCopy = await finished(pluginCopyReply.result.structuredContent.id);
  assert.equal(pngCopy.status, 'succeeded');
  const pluginDownload = await fetch(`${base}/api/v1/artifacts/${pngCopy.result.artifacts[0].id}/content`, { headers });
  assert.equal(pluginDownload.status, 200);
  assert.deepEqual(Buffer.from(await pluginDownload.arrayBuffer()), png);
  await verifyMessagePack({ base, headers, mcpHeaders, operations, mcp, deviceJob, finished });
  console.log(selectedPerformanceDemo ? '性能采样插件与合成 FPS 窗口的真实服务验证通过' : '内置 ADB 性能端口的真实服务验证通过');
  console.log('真实 HTTP 服务、部署插件任务、持久化事件、产物上传下载、ZIP 预览、模拟设备安装卸载和 MCP 截图下载、APK / AAB manifest 、APK 签名、AAB 双模式构建、设备规格匹配提取、APKS 整包安装及 APK 提取再安装、反编译产物下载及 MCP SDK 检测与协议 2 插件产物读写、Android 输入与性能会话验证通过');
} finally {
  // 仅终止本脚本启动的进程，并仅清理本脚本创建的临时目录。
  if (child.exitCode === null && !spawnFailure) {
    const closed = new Promise((resolve) => child.once('close', resolve));
    child.kill();
    await closed;
  }
  await rm(temporary, { recursive: true, force: true });
}


