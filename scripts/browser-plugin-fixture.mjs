import { npmTgz } from '../backend/scripts/online-plugins/fixtures.mjs';
import { readFile } from 'node:fs/promises';

// 仅验收夹具与报告采集共享此键，不进入生产宿主接口。
export const deviceObservationKey = 'deviceforge.browser-plugin-smoke.device-observations';
export const artifactObservationKey = 'deviceforge.browser-plugin-smoke.artifact-contexts';

// 使用交付给插件开发者的真实独立示例，不在验收页手写提供者对象。
export async function deviceProviderFixture() {
  const directory = new URL('../backend/examples/device-provider-node/', import.meta.url);
  const files = await Promise.all(['package.json', 'plugin.json', 'index.mjs', 'README.md'].map(async path => ({
    path, bytes: await readFile(new URL(path, directory)),
  })));
  return { id: 'device_node_example', archive: npmTgz(files) };
}

// 插件依赖和界面内容全部来自真实上传包，测试页不直接登记模块对象。
export function browserRuntimeFixture() {
  const id = 'browser_runtime_probe';
  const descriptor = { name: 'deviceforge-browser-runtime-probe', version: '1.0.0', type: 'module',
    deviceforge: { kind: 'browser', manifest: 'plugin.json',
      entrypoints: { any: { runtime: 'browser', path: 'dist/index.js' } } } };
  const shared = `// 每个运行路径应执行独立的相对依赖模块。
export const dependencyRun = crypto.randomUUID();
export function render(target, text) {
  const label = target.ownerDocument.createElement('span');
  label.textContent = text; target.append(label);
  return () => label.remove();
}
`;
  const module = `import {dependencyRun, render} from './shared.js';
const settings = await fetch(new URL('./settings.json', import.meta.url)).then(response => response.json());
// 只在专用验收页面保留公开回调收到的上下文，不访问宿主私有实现。
function observeArtifacts(kind, context) {
  globalThis[Symbol.for('${artifactObservationKey}')]?.push({kind,context,dependencyRun});
}
export default {
  id: '${id}', version: '1.0.0', apiVersion: 2,
  panels: [{id:'${id}.panel', title:'在线面板', async mount(target, context) {
    observeArtifacts('panel',context); return render(target, settings.panel);
  }}],
  async activate(context) {
    observeArtifacts('plugin',context);
    context.extensions.setState('${id}.ready', true);
    context.extensions.register({commands:[{id:'${id}.dynamic',title:'动态命令',async execute(input, current, signal) {
      const reply = await current.listOperations(signal);
      return {data:{ready:current.extensions.getState('${id}.ready'),dependencyRun},logId:reply.logId};
    }}]});
  },
  contributions: {
    components:[{id:'${id}.component',title:'替换组件',slot:'toolbar',mode:'replace',async mount(target) {return render(target, settings.component);}}],
    modules:[{id:'${id}.module',title:'新增模块',route:'/probe',async mount(target, context) {
      observeArtifacts('module',context); return render(target, settings.module);
    }}],
    commands:[{id:'${id}.command',title:'服务对接',async execute(input, context, signal) {
      const reply=await context.listOperations(signal); return {data:{dependencyRun,count:reply.data.length},logId:reply.logId};
    }},{id:'${id}.devices',title:'公开设备能力对接',async execute(input, context, signal) {
      if(!context.devices) throw new Error('宿主缺少公开设备能力');
      const providers=await context.devices.refreshProviders(signal);
      const provider=providers.data.find(item=>item.id==='device_node_example');
      if(!provider) throw new Error('模拟设备提供者未加载');
      if(provider.definition.apiVersion!==2 || provider.definition.capabilities.find(cap=>cap.id==='device.echo')?.executionTimeoutMs!==120000
        || provider.definition.capabilities.find(cap=>cap.id==='provider.describe')?.executionTimeoutMs!==undefined)
        throw new Error('公开设备 API 2 预算元数据映射失败');
      const directory=await context.devices.refreshProvider(provider.id,provider.generation,signal);
      const device=directory.data.devices.find(item=>item.reference.localId==='demo-device');
      if(!device) throw new Error('模拟设备未被发现');
      const reply=await context.devices.invoke({providerId:provider.id,generation:provider.generation,
        deviceId:device.reference.localId,capability:'device.echo',version:1,input:{source:'browser-plugin'}},signal);
      const deviceDefinition={providerId:provider.id,generation:provider.generation,
        apiVersion:provider.definition.apiVersion,
        capabilities:provider.definition.capabilities.map(capability=>({id:capability.id,version:capability.version,
          executionTimeoutMs:capability.executionTimeoutMs??null,
          executionTimeoutOmitted:capability.executionTimeoutMs===undefined}))};
      // 验收页面不转发命令的额外返回字段，通过测试专属通道保留实际设备声明。
      globalThis[Symbol.for('${deviceObservationKey}')]?.push(deviceDefinition);
      return {data:{jobId:reply.data.id,reference:device.reference,deviceDefinition},logId:reply.logId};
    }}],
    services:[{id:'${id}.service',version:'1',async invoke(input, context, signal) {
      return context.extensions.executeCommand('${id}.command',input,signal);
    }}],
    beforeTaskSubmit:[{id:'${id}.hook',priority:1,async transform(submission) {
      if(submission.operation!=='plugin.online_echo_v2.echo') return submission;
      return {operation:submission.operation,input:{...submission.input,value:submission.input.value+1}};
    }}]
  }
};
`;
  const files = [
    { path: 'package.json', bytes: JSON.stringify(descriptor) },
    { path: 'plugin.json', bytes: JSON.stringify({ id, version: '1.0.0', api_version: 2 }) },
    { path: 'dist/index.js', bytes: module },
    { path: 'dist/shared.js', bytes: shared },
    { path: 'dist/settings.json', bytes: JSON.stringify({ panel: '在线面板已挂载', component: '在线组件替换宿主', module: '在线模块已挂载' }) },
  ];
  return { id, archive: npmTgz(files) };
}

// 函数源码作为独立浏览器模块发送；本文件不会在 Node 中执行浏览器验收。
export function browserArtifactsHarness() {
  return "import { createFrontendRuntime } from '/__production_host__';\n"
    + 'const artifactObservationKey = ' + JSON.stringify(artifactObservationKey) + ';\n'
    + 'export ' + verifyArtifacts.toString() + '\n';
}

async function verifyArtifacts() {
  function check(value, message) { if (!value) throw new Error(message); }
  function deferred() {
    let resolve; const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  }
  async function bounded(promise, message) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 5000);
      })]);
    } finally { clearTimeout(timer); }
  }
  async function sha256(bytes) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
  }
  function equalBytes(actual, expected, label) {
    check(actual.length === expected.length && actual.every((value, index) => value === expected[index]), label);
  }
  function cancelled(error, code) {
    check(error?.kind === 'cancelled' && error.code === code && error.status === null,
      '撤销必须返回精确公开取消错误：' + code);
    return { kind: error.kind, code: error.code, status: error.status, logId: error.logId };
  }
  const evidence = { passed: false, checks: [], requests: [], payloads: [], revocations: [], revokedCalls: [], transportStartedCount: 0,
    scope: '真实已安装浏览器包的公开 HostContext.artifacts；传输门闩延迟真实响应交付，不证明服务器回滚、副作用停止或完整资源清理' };
  const key = Symbol.for(artifactObservationKey); const contexts = [];
  globalThis[key] = contexts;
  const signal = AbortSignal.timeout(20000);
  const panel = document.createElement('section'); const module = document.createElement('section');
  document.body.append(panel, module);
  let gate = null; let runtime; let installedId;
  const gates = [];
  // 每个请求仍使用真实 fetch；只在服务成功响应已读取后暂停交付给生产客户端。
  async function transport(input, init) {
    const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const artifact = url.pathname === '/api/v2/artifacts' || /^\/api\/v2\/artifacts\/[^/]+\/content$/.test(url.pathname);
    const held = artifact && gate?.path === url.pathname && gate.method === method ? gate : null;
    if (held) { gate = null; held.requestSignal = init?.signal; }
    if (artifact) ++evidence.transportStartedCount;
    const response = await fetch(input, init);
    if (artifact) {
      const wire = { method, path: url.pathname, status: response.status,
        logId: response.headers.get('x-deviceforge-log-id'), responseObservedAt: performance.now() };
      evidence.requests.push(wire);
      // 观测层不把真实 HTTP 拒绝改写成传输异常；精确错误仍由生产客户端消费。
      if (!response.ok) {
        const envelope = await response.clone().json();
        wire.errorCode = envelope.error?.code ?? null;
        wire.bodyLogId = envelope.log_id ?? null;
        return response;
      }
      if (method === 'POST') {
        const envelope = await response.clone().json();
        check(envelope.log_id === wire.logId, '上传响应正文与响应头日志 ID 不一致');
        wire.artifactId = envelope.data?.id;
        if (held) held.serverMetadata = envelope.data;
      } else {
        const bytes = new Uint8Array(await response.clone().arrayBuffer());
        wire.bytes = bytes.length; wire.sha256 = await sha256(bytes);
      }
      if (held) {
        held.wire = wire; held.ready.resolve();
        await held.release.promise;
        wire.deliveredAt = performance.now(); held.returned.resolve();
      }
    }
    return response;
  }
  function hold(method, path) {
    check(gate === null, '不能重叠设置产物传输门闩');
    const current = { method, path, ready: deferred(), release: deferred(), returned: deferred() };
    gate = current; gates.push(current); return current;
  }
  function context(kind) {
    const observed = contexts.findLast(item => item.kind === kind);
    check(observed?.context.apiVersion === 2 && observed.context.artifacts, '真实插件回调缺少公开产物入口：' + kind);
    return observed;
  }
  async function download(access, uploaded, expected, label) {
    const begin = evidence.requests.length;
    const reply = await access.download(uploaded.id, signal);
    const wire = evidence.requests[begin];
    check(wire?.method === 'GET' && wire.status === 200 && wire.path === '/api/v2/artifacts/' + uploaded.id + '/content', '公开下载没有对应真实请求');
    check(typeof wire.logId === 'string' && wire.logId.trim(), '真实下载响应缺少日志 ID');
    check(reply.data instanceof Blob && reply.logId === wire.logId, '公开下载未保留 Blob 和真实响应日志');
    const bytes = new Uint8Array(await reply.data.arrayBuffer());
    equalBytes(bytes, expected, label + '原始 Blob 字节变化');
    check(reply.data.type === uploaded.mediaType && await sha256(bytes) === uploaded.sha256.toLowerCase(), '下载媒体类型或摘要变化');
    return { artifactId: uploaded.id, logId: reply.logId, bytes: bytes.length, sha256: wire.sha256 };
  }
  async function oldReference(access, id, scope) {
    const count = evidence.transportStartedCount;
    for (const [method, request] of [['upload', () => access.upload('旧作用域.bin', new Blob([Uint8Array.of(0)]), signal)],
      ['download', () => access.download(id, signal)]]) {
      let error;
      try { await request(); } catch (failure) { error = failure; }
      const rejected = cancelled(error, 'plugin_unloaded');
      check(error.logId === null, '零传输撤销不能伪造响应日志');
      evidence.revokedCalls.push({ scope, method, error: rejected });
    }
    check(evidence.transportStartedCount === count, '旧作用域上传或下载仍发起传输');
  }
  async function revokeWithResponse(label, current, request, revoke) {
    let fulfilled = false;
    // 在撤销前就观察成功/失败，既不吞失败，也不留下未处理的拒绝 Promise。
    const outcome = request().then(() => { fulfilled = true; return { success: true }; },
      error => ({ success: false, error, settledAt: performance.now() }));
    await bounded(Promise.race([current.ready.promise, outcome.then(result => {
      if (result.success) throw new Error(label + '未经过响应门闩就返回成功');
      throw result.error;
    })]), label + '未取得真实服务响应');
    check(current.wire.status === (current.method === 'POST' ? 201 : 200)
      && typeof current.wire.logId === 'string' && current.wire.logId.trim(), label + '未取得精确成功状态及真实日志');
    check(current.requestSignal && !current.requestSignal.aborted, label + '响应门闩前已取消');
    await bounded(revoke(), label + '撤销没有完成');
    check(current.requestSignal.aborted, label + '没有传递作用域取消信号');
    const result = await bounded(outcome, label + '没有结束公开等待');
    check(!result.success && !fulfilled, label + '错误交付撤销后的成功结果');
    const error = cancelled(result.error, 'cancelled');
    // 此处客户端尚未接收被门闩扣住的响应，不能把已观测的服务器日志伪装成公共错误日志。
    check(error.logId === null, label + '取消错误错误地宣称已经接收响应日志');
    const releasedAt = performance.now();
    check(result.settledAt <= releasedAt, label + '只在放行响应后才取消');
    current.release.resolve();
    await bounded(current.returned.promise, label + '真实晚响应没有放行');
    await Promise.resolve();
    check(!fulfilled, label + '真实晚响应复活了旧调用');
    evidence.revocations.push({ scope: label, error, realResponse: current.wire,
      signalAborted: true, rejectedAt: result.settledAt, releasedAt, lateSuccessDelivered: fulfilled });
  }
  try {
    runtime = createFrontendRuntime({ baseUrl: location.origin, transport,
      panelTarget: () => panel, moduleTarget: () => module,
      esmImporter: async (url, current) => { current.throwIfAborted(); return import(/* @vite-ignore */ url); },
      packageEntryResolver: (info, runId) => '/api/v2/browser-plugins/' + encodeURIComponent(info.id) + '/runs/' + runId + '/assets/' + info.entryPath });
    const archive = await fetch('/__fixture__/browser.tgz', { signal });
    check(archive.ok, '产物验收浏览器夹具读取失败');
    const installed = await runtime.pluginPackages.upload('browser', await archive.blob(), 'application/gzip', signal);
    installedId = installed.data.id;
    const first = await runtime.pluginPackages.enable('browser', installedId, signal);
    await runtime.webPlugins.mount(installedId, installedId + '.panel');
    await runtime.extensions.mountModule(installedId + '.module');
    const owner = context('plugin'); const sibling = context('panel'); const child = context('module');
    check(owner.context !== child.context && sibling.context !== child.context, '挂载没有独立公开上下文');
    evidence.plugin = { id: installedId, apiVersion: owner.context.apiVersion, generation: first.data.generation, dependencyRun: owner.dependencyRun,
      uploadLogId: installed.logId, enableLogId: first.logId };
    const payloads = [
      // 固定 MessagePack bin8 包含 NUL 和非法 UTF-8 字节，符合真实服务的二进制产物资格。
      { kind: 'binary', filename: '公开二进制.msgpack', bytes: Uint8Array.of(196, 6, 0, 255, 192, 128, 0, 254), mediaType: 'application/msgpack' },
      { kind: 'json', filename: '公开原文.json', bytes: new TextEncoder().encode('{"log_id":"产物正文不是响应日志","data":{"value":1}}'), mediaType: 'application/json' },
    ];
    for (const payload of payloads) {
      const begin = evidence.requests.length;
      const uploaded = await owner.context.artifacts.upload(payload.filename, new Blob([payload.bytes], { type: payload.mediaType }), signal);
      const wire = evidence.requests[begin]; const meta = uploaded.data;
      check(wire?.method === 'POST' && wire.status === 201 && meta.id === wire.artifactId && uploaded.logId === wire.logId, '公开上传与真实响应身份或日志不一致');
      check(typeof wire.logId === 'string' && wire.logId.trim(), '真实上传响应缺少日志 ID');
      check(meta.filename === payload.filename && meta.size === payload.bytes.length && Object.isFrozen(meta), '产物公开元数据没有正确映射');
      check(meta.sha256.toLowerCase() === await sha256(payload.bytes) && Number.isFinite(meta.createdAt), '公开产物摘要或时间无效');
      const downloaded = await download(owner.context.artifacts, meta, payload.bytes, payload.kind);
      evidence.payloads.push({ kind: payload.kind, inputBlobMediaType: payload.mediaType,
        metadata: meta, uploadLogId: uploaded.logId, download: downloaded });
    }
    evidence.checks.push('公开二进制与封套样JSON上传下载保留原Blob字节、摘要和真实响应logId');
    const original = evidence.payloads[0].metadata; const bytes = payloads[0].bytes;
    const childUpload = hold('POST', '/api/v2/artifacts');
    await revokeWithResponse('mount_unmount', childUpload,
      () => child.context.artifacts.upload('挂载撤销前已上传.msgpack', new Blob([bytes], { type: 'application/msgpack' }), signal),
      () => runtime.extensions.unmount(installedId + '.module'));
    check(child.context.signal.aborted && !owner.context.signal.aborted && !sibling.context.signal.aborted,
      '挂载子作用域退出错误地撤销插件或兄弟作用域');
    check(module.childElementCount === 0 && panel.textContent === '在线面板已挂载', '挂载退出未收敛本模块DOM或破坏兄弟面板');
    check(runtime.extensions.catalog().modules.some(item => item.id === installedId + '.module'), '挂载退出错误地删除模块登记');
    await oldReference(child.context.artifacts, original.id, 'unmounted_module');
    evidence.mountScope = { childAborted: child.context.signal.aborted, parentAborted: owner.context.signal.aborted,
      siblingAborted: sibling.context.signal.aborted, moduleDomEmpty: true, registrationRetained: true };
    evidence.siblingDownload = await download(sibling.context.artifacts, original, bytes, '未退出兄弟作用域');
    // 服务已完成该上传；本地取消只撤销等待，另用仍有效兄弟作用域核对真实已保存的字节。
    const committed = childUpload.serverMetadata;
    check(committed && committed.size === bytes.length && committed.sha256.toLowerCase() === original.sha256.toLowerCase(),
      '门闩上传缺少真实已提交产物元数据');
    evidence.cancelledUploadStillReadable = await download(sibling.context.artifacts,
      { id: committed.id, mediaType: committed.media_type, sha256: committed.sha256 }, bytes, '已提交但撤销等待的上传');
    await runtime.extensions.mountModule(installedId + '.module');
    const remounted = context('module');
    check(remounted.context !== child.context && !remounted.context.signal.aborted, '重挂载复用了已撤销上下文');
    evidence.remountedDownload = await download(remounted.context.artifacts, original, bytes, '新挂载作用域');
    evidence.checks.push('模块退出只撤销子作用域、旧上传下载零传输，兄弟与重挂载继续可用');
    const ownerDownload = hold('GET', '/api/v2/artifacts/' + original.id + '/content');
    await revokeWithResponse('plugin_disable', ownerDownload,
      () => owner.context.artifacts.download(original.id, signal),
      () => runtime.pluginPackages.disable('browser', installedId, signal));
    check(owner.context.signal.aborted && sibling.context.signal.aborted && remounted.context.signal.aborted,
      '插件撤销没有传播到所有挂载子作用域');
    check(panel.childElementCount === 0 && module.childElementCount === 0, '插件撤销后DOM仍保留');
    for (const observed of [owner, sibling, remounted]) await oldReference(observed.context.artifacts, original.id, 'disabled_' + observed.kind);
    const next = await runtime.pluginPackages.enable('browser', installedId, signal);
    const fresh = context('plugin');
    check(next.data.generation > first.data.generation && fresh.context !== owner.context
      && fresh.dependencyRun !== owner.dependencyRun && !fresh.context.signal.aborted, '重载没有独立的新代公开上下文');
    evidence.reload = { generation: next.data.generation, dependencyRun: fresh.dependencyRun,
      download: await download(fresh.context.artifacts, original, bytes, '新代插件') };
    await oldReference(owner.context.artifacts, original.id, 'old_generation_after_reload');
    evidence.checks.push('真实响应先到再撤销，拒绝晚交付；插件卸载旧引用零传输且新代可下载');
    await runtime.pluginPackages.remove('browser', installedId, signal);
    installedId = undefined;
    check(runtime.webPlugins.snapshot().length === 0 && (await runtime.pluginPackages.refresh('browser', signal)).data.length === 0,
      '产物验收后浏览器运行或部署仍残留');
    await runtime.dispose();
    evidence.cleanup = { browserDeploymentsEmpty: true, pluginRunsEmpty: true, runtimeDisposed: true };
    evidence.passed = true;
  } catch (error) {
    evidence.error = error.message;
    evidence.failure = { kind: error.kind ?? null, code: error.code ?? null,
      status: error.status ?? null, logId: error.logId ?? null };
  }
  finally {
    for (const current of gates) current.release.resolve();
    if (runtime && installedId) {
      try { await runtime.pluginPackages.remove('browser', installedId, AbortSignal.timeout(5000)); }
      catch (error) { evidence.packageCleanupError = error.message; evidence.passed = false; }
    }
    if (runtime) {
      try { await runtime.dispose(); }
      catch (error) { evidence.cleanupError = error.message; evidence.passed = false; }
    }
    delete globalThis[key]; panel.remove(); module.remove();
  }
  return evidence;
}
