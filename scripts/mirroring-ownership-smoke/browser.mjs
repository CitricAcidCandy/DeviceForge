import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../../frontend/node_modules/vite/dist/node/index.js';

async function browserCase(baseUrl, deviceId) {
  const api = await import('/src/services/api/index.ts');
  const feature = await import('/src/features/mirroring-streaming/index.ts');
  const client = api.createApiClient({ baseUrl, transport: (input, init) => fetch(input, init) });
  const evidence = { checks: [], clients: [], transitions: [], clipboard: [], failure: null };
  globalThis.__ownershipEvidence = evidence;
  const participants = [];
  const signal = () => AbortSignal.timeout(15000);
  const check = (name, passed, detail) => {
    evidence.checks.push({ name, passed, detail });
    if (!passed) throw new Error(name);
  };
  const until = async (predicate, label, milliseconds = 15000) => {
    const end = performance.now() + milliseconds;
    while (!(await predicate())) {
      if (performance.now() >= end) throw new Error(label);
      await new Promise((done) => setTimeout(done, 25));
    }
  };
  const helper = async (action, value) => {
    const response = await fetch('/__ownership_helper/' + action, {
      method: 'POST', body: JSON.stringify(value ?? {}), headers: { 'content-type': 'application/json' },
    });
    if (!response.ok) throw new Error('夹具观测失败：' + await response.text());
    return response.json();
  };
  const ownership = (index) => {
    const snapshot = participants[index].mirroring.snapshot();
    if (!snapshot.ownership) throw new Error('第' + (index + 1) + '个客户端所有权已失效：' + JSON.stringify(snapshot.errors));
    return snapshot.ownership;
  };
  const raw = (index, message) => participants[index].channel.send(JSON.stringify(message) + '\n');
  const key = (code, action = 'down') => ({ type: 'key', action, keycode: code });
  const control = (index, revision, command) => raw(index, {
    version: 1, epoch: 1, type: 'control', control_revision: revision, command,
  });
  const state = () => participants.map((entry) => entry.mirroring.snapshot().ownership);
  const clipboard = async (owner, text) => {
    const before = participants.map((entry) => entry.clipboard.length);
    await helper('clipboard', { text });
    await until(() => participants[owner].clipboard.some((entry) => entry.text === text), '当前控制者未收到设备剪贴板');
    await new Promise((done) => setTimeout(done, 350));
    check('设备复制只回传当前控制者', participants.every((entry, index) =>
      index === owner || entry.clipboard.length === before[index]), { owner, text, counts: participants.map((entry) => entry.clipboard.length) });
    evidence.clipboard.push({ owner, text, counts: participants.map((entry) => entry.clipboard.length) });
  };
  try {
    for (const allowed of [true, true, false]) {
      const entry = { channel: null, peer: null, clipboard: [], messages: [], seenClipboard: null, mirroring: null, video: null };
      entry.mirroring = feature.createHttpWebRtcMirroring(client, {
        pollIntervalMs: 25,
        peerConnectionFactory: () => {
          const peer = new RTCPeerConnection();
          entry.peer = peer;
          peer.addEventListener('datachannel', (event) => {
            entry.channel = event.channel;
            event.channel.addEventListener('message', (message) => {
              try { entry.messages.push(JSON.parse(String(message.data))); } catch {}
            });
          });
          return peer;
        },
      });
      entry.unsubscribe = entry.mirroring.subscribe((snapshot) => {
        if (snapshot.session?.completion && !entry.terminalSession) {
          entry.terminalSession = snapshot.session;
          (evidence.terminalSessions ??= []).push(snapshot.session);
        }
        if (snapshot.clipboard && snapshot.clipboard !== entry.seenClipboard) {
          entry.seenClipboard = snapshot.clipboard;
          entry.clipboard.push({ ...snapshot.clipboard });
        }
      });
      participants.push(entry);
      await entry.mirroring.refreshDefinitions(signal());
      const opened = await entry.mirroring.open({ device_id: deviceId, audio: false,
        control: allowed, clipboard_autosync: allowed, reconnect_attempts: 0 }, AbortSignal.timeout(35000));
      await until(() => entry.channel?.readyState === 'open' && entry.mirroring.snapshot().ownership !== null,
        '真实控制通道或所有权状态未就绪');
      evidence.clients.push({ id: opened.data.id, allowed, ownership: entry.mirroring.snapshot().ownership });
      const video = document.createElement('video');
      video.autoplay = true; video.muted = true; video.playsInline = true;
      document.body.append(video); entry.video = video;
      video.srcObject = entry.mirroring.snapshot().stream;
      await video.play();
      await until(() => video.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames >= 3,
        '三会话真实视频解码不足', 20000);
    }
    check('三会话唯一控制者及只读观看者', ownership(0).hasControl && !ownership(1).hasControl &&
      !ownership(2).canControl && !ownership(2).hasControl, state());
    check('本机客户端主控由服务端确认', participants.every((_, index) => ownership(index).isMaster), state());
    const initialRevision = ownership(0).controlRevision;
    await participants[0].mirroring.sendControl(key(29), signal());
    await participants[0].mirroring.sendControl(key(29, 'up'), signal());
    await until(async () => (await helper('bytes')).controllerBytes >= 28, '初始控制字节未到设备');
    await clipboard(0, '主控复制-甲');
    await participants[1].mirroring.requestControl(signal());
    await until(() => ownership(0).requests.some((entry) => entry.clientId === ownership(1).clientId), '接管申请未通知当前控制者');
    await participants[0].mirroring.respondControl(ownership(1).clientId, false, signal());
    await until(() => ownership(0).requests.length === 0 && ownership(0).hasControl, '拒绝申请后状态错误');
    check('拒绝移交保留原控制者', ownership(0).hasControl && !ownership(1).hasControl, state());
    await participants[1].mirroring.requestControl(signal());
    await until(() => ownership(0).requests.length === 1, '第二次申请未出现');
    await participants[0].mirroring.respondControl(ownership(1).clientId, true, signal());
    await until(() => !ownership(0).hasControl && ownership(1).hasControl && !ownership(1).transitioning,
      '同意移交没有完成旧连接清理');
    evidence.transitions.push({ kind: 'approved', states: state() });
    await clipboard(1, '接管者复制-乙');
    const baseline = await helper('bytes');
    control(0, initialRevision, key(131));
    control(2, ownership(1).controlRevision, key(132));
    control(1, initialRevision, key(133));
    await new Promise((done) => setTimeout(done, 450));
    const rejected = await helper('bytes');
    check('失权只读及旧代输入均为零字节', rejected.controllerBytes === baseline.controllerBytes,
      { before: baseline, after: rejected });
    const deniedId = crypto.randomUUID();
    raw(2, { version: 1, epoch: 1, type: 'control_request', request_id: deniedId });
    await until(() => participants[2].messages.some((message) => message.request_id === deniedId), '只读申请没有服务端回执');
    check('只读申请由服务端拒绝', participants[2].messages.some((message) =>
      message.type === 'control_result' && message.request_id === deniedId && message.ok === false), state());
    await participants[1].mirroring.sendControl(key(30), signal());
    await participants[1].mirroring.sendControl(key(30, 'up'), signal());
    await until(async () => (await helper('bytes')).controllerBytes >= baseline.controllerBytes + 28,
      '接管者控制字节未到设备');
    const transferredRevision = ownership(1).controlRevision;
    await participants[0].mirroring.reclaimControl(signal());
    await until(() => ownership(0).hasControl && !ownership(1).hasControl && !ownership(0).transitioning,
      '主控抢回没有完成');
    evidence.transitions.push({ kind: 'reclaimed', states: state() });
    await clipboard(0, '抢回后复制-丙');
    const reclaimBaseline = await helper('bytes');
    control(1, transferredRevision, key(134));
    await new Promise((done) => setTimeout(done, 350));
    check('抢回后旧控制者输入为零字节', (await helper('bytes')).controllerBytes === reclaimBaseline.controllerBytes,
      reclaimBaseline);
    await participants[0].mirroring.sendControl(key(31), signal());
    await participants[0].mirroring.sendControl(key(31, 'up'), signal());
    await until(async () => (await helper('bytes')).controllerBytes >= reclaimBaseline.controllerBytes + 28,
      '主控抢回后输入未到设备');
    evidence.finalBytes = await helper('bytes');
    check('恰好三组合法按键且无越权字节', evidence.finalBytes.controllerBytes === 84, evidence.finalBytes);
    evidence.passed = true;
  } catch (error) {
    evidence.failure = { name: error.name, message: error.message, stack: error.stack,
      snapshots: participants.map((entry) => ({ ...entry.mirroring.snapshot(), stream: null })),
      messages: participants.map((entry) => entry.messages.slice(-12)) };
    evidence.passed = false;
  } finally {
    evidence.released = [];
    for (const entry of [...participants].reverse()) {
      try {
        const released = await entry.mirroring.release(AbortSignal.timeout(20000));
        evidence.released.push({ id: released.data.id, status: released.data.status });
      } catch (error) { evidence.passed = false; evidence.released.push({ error: String(error) }); }
      try { await entry.mirroring.dispose(); } catch (error) { evidence.passed = false; }
      entry.unsubscribe?.(); entry.video?.remove();
    }
  }
  return evidence;
}

async function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let sequence = 0;
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP连接超时')), 10000);
    socket.addEventListener('open', () => { clearTimeout(timer); done(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP连接失败')); }, { once: true });
  });
  socket.addEventListener('message', (message) => {
    let value;
    try { value = JSON.parse(String(message.data)); } catch { return; }
    const task = pending.get(value.id);
    if (!task) return;
    pending.delete(value.id); clearTimeout(task.timer);
    if (value.error) task.reject(new Error(JSON.stringify(value.error))); else task.resolve(value.result ?? {});
  });
  socket.addEventListener('close', () => {
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('CDP连接关闭')); }
    pending.clear();
  });
  return {
    call(method, params = {}, timeout = 15000) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP超时 ' + method)); }, timeout);
        pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => socket.close(),
  };
}

async function bytesFor(plan) {
  let directories = [];
  try { directories = await readdir(join(plan, 'sessions')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const sessions = [];
  for (const id of directories) {
    const path = join(plan, 'sessions', id);
    let mode;
    try { mode = await readFile(join(path, 'mode'), 'utf8'); } catch { continue; }
    let control = Buffer.alloc(0);
    try { control = await readFile(join(path, 'control.bin')); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    sessions.push({ id, mode, bytes: control.length, hex: control.toString('hex') });
  }
  return { controllerBytes: sessions.filter((entry) => entry.mode === 'control')
    .reduce((total, entry) => total + entry.bytes, 0), sessions };
}

function endpoint(child) {
  return new Promise((done, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('浏览器CDP端点未就绪')), 15000);
    const data = (bytes) => {
      text = (text + bytes.toString()).slice(-32768);
      const url = text.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9/._-]+)/)?.[1];
      if (url) { clearTimeout(timer); done(url); }
    };
    child.stderr.on('data', data); child.stdout.on('data', data);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('浏览器就绪前退出')); });
  });
}

export async function runOwnershipBrowser({ root, baseUrl, deviceId, directory, plan, executable }) {
  let browserPath;
  for (const path of [executable, process.env.DEVICEFORGE_TEST_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(Boolean)) {
    try { await access(path); browserPath = path; break; } catch {}
  }
  assert.ok(browserPath, '未找到浏览器');
  const report = { passed: false, executable: browserPath, baseUrl, deviceId };
  let server;
  let child;
  let browser;
  let page;
  let closed;
  let clipboardSequence = 0n;
  try {
    server = await createServer({ root: join(root, 'frontend'), configFile: false,
      appType: 'custom', logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
    server.middlewares.use('/__ownership_probe', (_request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>控制权联调探针</title><body></body></html>');
    });
    server.middlewares.use('/__ownership_helper', async (request, response) => {
      try {
        let value = '';
        for await (const chunk of request) { value += chunk; assert.ok(value.length <= 4096); }
        if (request.url === '/clipboard') {
          const { text } = JSON.parse(value);
          assert.equal(typeof text, 'string');
          assert.ok(Buffer.byteLength(text) <= 1024);
          const prefix = Buffer.alloc(8); prefix.writeBigUInt64BE(++clipboardSequence);
          const pending = join(plan, 'clipboard.pending');
          await writeFile(pending, Buffer.concat([prefix, Buffer.from(text)]));
          // Windows 读取方短暂占用目标时，保留同一完整帧并有界重试原子替换。
          for (let attempt = 1; ; attempt++) {
            try { await rename(pending, join(plan, 'clipboard-message')); break; }
            catch (error) {
              if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 40) throw error;
              (report.fixtureRetries ??= []).push({ operation: 'clipboard_replace', code: error.code,
                attempt, delayMs: 25 });
              await delay(25);
            }
          }
        } else assert.equal(request.url, '/bytes');
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(await bytesFor(plan)));
      } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: error.message, code: error.code })); }
    });
    await server.listen();
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== 'string');
    const pageUrl = 'http://127.0.0.1:' + address.port + '/__ownership_probe';
    child = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run',
      '--no-default-browser-check', '--disable-background-networking',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      '--user-data-dir=' + join(directory, 'edge-profile'), 'about:blank'],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    report.pid = child.pid;
    closed = new Promise((done) => child.once('close', (code, signal) => done({ code, signal })));
    const ws = await endpoint(child);
    browser = await connect(ws);
    const target = new URL(ws); target.protocol = 'http:'; target.pathname = '/json/new';
    target.search = '?' + encodeURIComponent(pageUrl);
    const targetResponse = await fetch(target, { method: 'PUT', signal: AbortSignal.timeout(10000) });
    assert.ok(targetResponse.ok);
    const targetInfo = await targetResponse.json();
    page = await connect(targetInfo.webSocketDebuggerUrl);
    await page.call('Runtime.enable');
    const readyDeadline = Date.now() + 10000;
    while (true) {
      const ready = await page.call('Runtime.evaluate', {
        expression: '({url:location.href,state:document.readyState})', returnByValue: true,
      });
      if (ready.result?.value?.url === pageUrl && ready.result?.value?.state !== 'loading') break;
      assert.ok(Date.now() < readyDeadline, '浏览器页面未就绪');
      await delay(30);
    }
    try {
      const result = await page.call('Runtime.evaluate', {
        expression: `(async()=>(${browserCase.toString()})(${JSON.stringify(baseUrl)},${JSON.stringify(deviceId)}))()`,
        awaitPromise: true, returnByValue: true,
      }, 140000);
      assert.equal(result.exceptionDetails, undefined, '浏览器探针执行异常');
      report.result = result.result?.value;
      report.passed = report.result?.passed === true;
    } catch (error) {
      const progress = await page.call('Runtime.evaluate', { expression: 'globalThis.__ownershipEvidence', returnByValue: true }, 3000).catch(() => null);
      report.progress = progress?.result?.value;
      throw error;
    }
  } catch (error) { report.failure = { name: error.name, message: error.message }; }
  finally {
    page?.close();
    if (browser) { await browser.call('Browser.close', {}, 5000).catch(() => {}); browser.close(); }
    if (child) {
      await Promise.race([closed, delay(5000)]);
      if (child.exitCode === null && child.signalCode === null) {
        const terminator = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        await new Promise((done) => terminator.once('close', done));
        report.forcedTreeTermination = true;
        await Promise.race([closed, delay(3000)]);
      }
      report.exit = { code: child.exitCode, signal: child.signalCode };
      report.exited = child.exitCode !== null || child.signalCode !== null;
      if (!report.exited) report.passed = false;
    }
    if (server) {
      server.httpServer?.closeAllConnections?.();
      await server.close().catch((error) => { report.serverCleanupError = error.message; report.passed = false; });
    }
  }
  return report;
}
