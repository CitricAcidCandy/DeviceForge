import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { npmCommand, spawnManaged, stopManaged } from '../cli/src/processes.mjs';
import { inside } from '../cli/src/paths.mjs';
import { packFixture } from './cli-smoke-fixture.mjs';
import { installNativePlugins, verifyNativePlugins } from './cli-smoke-native.mjs';
import { verifyLiveInstallation } from './cli-smoke-lifecycle.mjs';
import { verifyNpxDeviceProvider } from './cli-smoke-devices.mjs';

const root = fileURLToPath(new URL('../',import.meta.url));
const temporary = await mkdtemp(join(tmpdir(),'deviceforge-npx-'));
const npm = npmCommand(); const npx = join(dirname(npm.prefix[0]),'npx-cli.js');
const environment = {...process.env,npm_config_cache:join(temporary,'cache')};
// 使用独立于数据目录的相对插件路径，验证安装、列举和 Rust 启动使用同一部署位置。
const pluginDirectory = join(temporary, '独立插件');
const cooperativeMarkers = join(temporary, '合作资源标记');
environment.APK_PLUGIN_DIR = relative(process.cwd(), pluginDirectory);
delete environment.APK_PERFORMANCE_PLUGIN;
const token = randomBytes(32).toString('hex'); environment.APK_API_TOKEN = token;
const runNpx = (args) => promisify(execFile)(process.execPath,[npx,'--yes',...args],{env:environment,windowsHide:true,maxBuffer:1024*1024,timeout:120000});
const logIdPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
async function port() {
  const server = createServer(); await new Promise((resolve) => server.listen(0,'127.0.0.1',resolve));
  const value = server.address().port; await new Promise((resolve) => server.close(resolve)); return value;
}
async function assertPortReleased(value) {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(value, '0.0.0.0', resolve);
    });
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}
async function assertJsonReply(response) {
  assert.equal(response.status, 200);
  const logId = response.headers.get('x-deviceforge-log-id');
  assert.match(logId, logIdPattern);
  const body = await response.json();
  assert.equal(body.log_id, logId);
  assert.ok(Object.hasOwn(body, 'data'));
  return body.data;
}
let running;
try {
  const fixture = await packFixture(temporary);
  const pack = await promisify(execFile)(npm.command,[...npm.prefix,'pack','--json','--pack-destination',temporary],{cwd:root,windowsHide:true,maxBuffer:1024*1024,timeout:120000});
  const packed = JSON.parse(pack.stdout);
  assert.ok(packed[0].files.some((item) => item.path === 'runtime/manifest.json'));
  assert.ok(!packed[0].files.some((item) => item.path.startsWith('backend/') || item.path.startsWith('frontend/node_modules/')));
  const archive = join(temporary,packed[0].filename); const dataDirectory = join(temporary,'运行数据');
  const prefix = ['--package',archive,'deviceforge'];
  const native = await installNativePlugins({ root, temporary, runNpx, prefix, dataDirectory, pluginDirectory, cooperativeMarkers });
  const listed = await runNpx([...prefix,'plugin','list','--data-dir',dataDirectory]);
  assert.deepEqual(JSON.parse(listed.stdout).map((plugin) => plugin.id).sort(), native.map((pkg) => pkg.id).sort());
  const webPort = await port(); const mcpPort = await port();
  // 不传 --ip，证明默认 0.0.0.0 的局域网监听；端口由命令行显式配置。
  running = spawnManaged(process.execPath,[npx,'--yes',...prefix,'start','--port',String(webPort),'--mcp-port',String(mcpPort),'--data-dir',dataDirectory],{env:environment,stdio:['ignore','pipe','pipe']});
  let output = ''; running.child.stdout.on('data',(bytes) => {output += bytes;}); running.child.stderr.on('data',() => {});
  const deadline = Date.now()+20000;
  while (!output.includes('DeviceForge 已启动') && Date.now()<deadline) {
    if (running.failure || running.child.exitCode !== null) throw new Error('npx 启动提前退出');
    await delay(50);
  }
  assert.match(output,/监听 0.0.0.0/); assert.ok(!output.includes(token));
  const addresses = ['127.0.0.1',...Object.values(networkInterfaces()).flat().filter(Boolean).filter((item) => !item.internal && item.family === 'IPv4').map((item) => item.address)];
  const headers = {authorization:`Bearer ${token}`,'content-type':'application/json'};
  await verifyLiveInstallation({ runNpx, prefix, fixture, dataDirectory, pluginDirectory,
    base: `http://127.0.0.1:${webPort}`, mcp: `http://127.0.0.1:${mcpPort}/mcp`, headers });
  for (const address of addresses) {
    const base = `http://${address}:${webPort}`; const mcp = `http://${address}:${mcpPort}/mcp`;
    assert.equal((await fetch(base,{signal:AbortSignal.timeout(3000)})).status,200);
    assert.equal((await fetch(`${base}/api/v1/health`)).status,401);
    const submit = await fetch(`${base}/api/v1/jobs`,{method:'POST',headers,body:JSON.stringify({operation:'plugin.npx_demo.echo',input:{message:'安装后可执行'}})});
    assert.equal(submit.status,202); const job = await submit.json();
    let result;
    for (let attempt=0;attempt<100;attempt+=1) {
      result = await (await fetch(`${base}/api/v1/jobs/${job.id}`,{headers})).json();
      if (result.status === 'succeeded' || result.status === 'failed') break;
      await delay(25);
    }
    assert.equal(result.status,'succeeded'); assert.equal(result.result.message,'npm 包依赖可用');
    const reply = await fetch(mcp,{method:'POST',headers:{...headers,accept:'application/json, text/event-stream',origin:base},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})});
    assert.equal(reply.status,200);
    const tools = (await reply.json()).result.tools;
    for (const name of ['plugin.npx_demo.echo', 'plugin.echo.echo', 'plugin.artifact_copy.copy', 'plugin.msgpack.encode', 'plugin.msgpack.decode', 'plugin.msgpack.query', 'plugin.performance_demo.sample', 'plugin.cooperative_demo.wait']) {
      assert.ok(tools.some((tool) => tool.name === name));
    }
    await verifyNativePlugins({ base, mcp, headers, cooperativeMarkers });
    assert.equal((await fetch(`http://${address}:${mcpPort}/api/v1/health`,{headers})).status,404);
  }
  // 正常停止先让 Rust 刷新日志，再核对 npx 包装进程与公开监听退出。
  const shutdown = await fetch(`http://127.0.0.1:${webPort}/api/v2/system/shutdown`, {method:'POST',headers,signal:AbortSignal.timeout(3000)});
  assert.equal(shutdown.status,200);
  const stopped = await Promise.race([running.closed,delay(10000).then(() => null)]);
  assert.ok(stopped, 'npx 应在优雅退出期限内结束');
  assert.equal(stopped.code,0); running = undefined;
  const logNames = (await readdir(join(dataDirectory,'logs'))).filter((name) => name.endsWith('.jsonl'));
  const logText = (await Promise.all(logNames.map((name) => readFile(join(dataDirectory,'logs',name),'utf8')))).join('');
  assert.ok(!logText.includes(token));
  const logRecords = logText.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(logRecords.some((record) => record.fields?.message === '宿主运行已结束'));
  assert.ok(logRecords.filter((record) => record.fields?.message === '合作插件取消清理已确认').length >= addresses.length * 2);
  assert.ok(!logRecords.some((record) => record.fields?.message === '合作插件资源未确认清理'));
  await assert.rejects(fetch(`http://127.0.0.1:${webPort}`,{signal:AbortSignal.timeout(1000)}));
  await assertPortReleased(webPort);
  await assertPortReleased(mcpPort);

  // 复用同一 tgz、数据和端口，验证用户不设置令牌时真正的 npx 默认路径。
  const anonymousEnvironment = { ...environment };
  delete anonymousEnvironment.APK_API_TOKEN;
  assert.equal(Object.hasOwn(anonymousEnvironment, 'APK_API_TOKEN'), false);
  running = spawnManaged(process.execPath,[npx,'--yes',...prefix,'start','--port',String(webPort),'--mcp-port',String(mcpPort),'--data-dir',dataDirectory],
    {env:anonymousEnvironment,stdio:['ignore','pipe','pipe']});
  let anonymousOutput = '';
  running.child.stdout.on('data',(bytes) => { anonymousOutput += bytes; });
  running.child.stderr.on('data',() => {});
  const anonymousDeadline = Date.now() + 20000;
  while (!anonymousOutput.includes('DeviceForge 已启动') && Date.now() < anonymousDeadline) {
    if (running.failure || running.child.exitCode !== null) throw new Error('默认免令牌 npx 启动提前退出');
    await delay(50);
  }
  assert.match(anonymousOutput,/DeviceForge 已启动/);
  assert.match(anonymousOutput,/监听 0.0.0.0/);
  assert.ok(!anonymousOutput.includes(token));
  const anonymousHeaders = { 'content-type': 'application/json' };
  assert.equal(Object.hasOwn(anonymousHeaders, 'authorization'), false);
  for (const address of addresses) {
    const base = `http://${address}:${webPort}`;
    await assertJsonReply(await fetch(`${base}/api/v2/health`, {signal:AbortSignal.timeout(3000)}));
    const operations = await assertJsonReply(await fetch(`${base}/api/v2/operations`, {signal:AbortSignal.timeout(3000)}));
    assert.ok(operations.some((item) => item.id === 'plugin.cooperative_demo.wait'));
    const reply = await fetch(`http://${address}:${mcpPort}/mcp`, {method:'POST',
      headers:{...anonymousHeaders,accept:'application/json, text/event-stream',origin:base},
      body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}}),signal:AbortSignal.timeout(3000)});
    assert.equal(reply.status,200);
    const logId = reply.headers.get('x-deviceforge-log-id');
    assert.match(logId,logIdPattern);
    const body = await reply.json();
    assert.equal(body.id,2);
    assert.equal(body.error,undefined);
    assert.equal(body.result._meta['deviceforge/log_id'],logId);
    assert.ok(body.result.tools.some((item) => item.name === 'plugin.cooperative_demo.wait'));
  }
  await verifyNpxDeviceProvider({ root, temporary, runNpx, prefix, dataDirectory,
    base: `http://127.0.0.1:${webPort}`, mcp: `http://127.0.0.1:${mcpPort}/mcp` });
  const anonymousShutdown = await assertJsonReply(await fetch(`http://127.0.0.1:${webPort}/api/v2/system/shutdown`,
    {method:'POST',headers:anonymousHeaders,signal:AbortSignal.timeout(3000)}));
  assert.equal(anonymousShutdown.stopping,true);
  const anonymousStopped = await Promise.race([running.closed,delay(10000).then(() => null)]);
  assert.ok(anonymousStopped, '默认免令牌 npx 应正常退出');
  assert.equal(anonymousStopped.code,0);
  running = undefined;
  await assertPortReleased(webPort);
  await assertPortReleased(mcpPort);
  const finalLogNames = (await readdir(join(dataDirectory,'logs'))).filter((name) => name.endsWith('.jsonl'));
  const finalLogText = (await Promise.all(finalLogNames.map((name) => readFile(join(dataDirectory,'logs',name),'utf8')))).join('');
  assert.ok(!finalLogText.includes(token));
  const finalLogRecords = finalLogText.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(finalLogRecords.filter((record) => record.fields?.message === '宿主运行已结束').length,2);
  console.log(`npx 打包运行验收通过：显式令牌授权与拒绝、同 tgz 默认免令牌 0.0.0.0 启动、无 Authorization HTTP/MCP 与日志 ID、启动后安装/加载/卸载/重载、Node 依赖与 ${native.length} 个 release 原生插件、公开设备示例实际安装/发现/HTTP与MCP能力调用/新旧代际、回显/产物复制/MessagePack/MCP/合成采样、合作任务/显式取消/卸载清理、相对插件目录、安装脚本禁用、${addresses.length} 个本机/局域网地址与两阶段正常退出/监听释放；未验证真实设备`);
} finally {
  await stopManaged(running);
  if (!inside(tmpdir(),temporary) || temporary === tmpdir()) throw new Error('测试清理路径越界');
  await rm(temporary,{recursive:true,force:true});
}
