import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';

type Json = Record<string, unknown>;
function object(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function browserCase(deviceId: string, audio: boolean) {
  const object = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
  const api = await import('../src/services/api/index.ts');
  const feature = await import('../src/features/mirroring-streaming/index.ts');
  const client = api.createApiClient({ baseUrl: location.origin, transport: (input, init) => fetch(input, init) });
  const peers: RTCPeerConnection[] = [];
  const mirroring = feature.createHttpWebRtcMirroring(client, {
    peerConnectionFactory: () => { const peer = new RTCPeerConnection(); peers.push(peer); return peer; },
  });
  const video = document.createElement('video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  document.body.append(video);
  const checks: Json[] = [];
  const evidence: Json = { checks, deviceId };
  let observedSession: ReturnType<typeof mirroring.snapshot>['session'] = null;
  const unsubscribe = mirroring.subscribe((snapshot) => {
    if (snapshot.session) observedSession = snapshot.session;
  });
  Reflect.set(globalThis, '__deviceforgeWebRtcEvidence', evidence);
  const check = (name: string, passed: boolean, detail: unknown) => {
    checks.push({ name, passed, detail });
    if (!passed) throw new Error(name);
  };
  const until = async (predicate: () => boolean | Promise<boolean>, name: string, timeoutMs = 10000) => {
    const deadline = performance.now() + timeoutMs;
    while (!(await predicate())) {
      if (performance.now() > deadline) throw new Error(name);
      await new Promise((done) => setTimeout(done, 30));
    }
  };
  try {
    evidence.location = location.href;
    try {
      const health = await fetch('/api/v2/health');
      evidence.health = { status: health.status, text: (await health.text()).slice(0, 500) };
    } catch (error) {
      evidence.health = { error: String(error) };
    }
    const definitions = await mirroring.refreshDefinitions(AbortSignal.timeout(10000));
    check('同插件WebRTC会话贡献', definitions.data.sessions.some((item) => item.id === 'plugin.mirroring.open_webrtc'), definitions.data.sessions.map((item) => item.id));
    const opened = await mirroring.open({ device_id: deviceId, audio, control: true, reconnect_attempts: 0 }, AbortSignal.timeout(30000));
    evidence.opened = { id: opened.data.id, operation: opened.data.operation, logId: opened.logId };
    check('完整SDP收据', typeof mirroring.snapshot().logs.answer === 'string', mirroring.snapshot().logs.answer);
    await until(() => mirroring.snapshot().status === 'streaming', 'ICE媒体连接未进入streaming');
    await until(() => (mirroring.snapshot().stream?.getVideoTracks().length ?? 0) > 0, '未收到真实视频track');
    const stream = mirroring.snapshot().stream;
    if (!stream) throw new Error('媒体流缺失');
    video.srcObject = stream;
    const playTimeout = setTimeout(() => video.dispatchEvent(new Event('error')), 5000);
    try {
      await Promise.race([
        video.play(),
        new Promise<never>((_, reject) => video.addEventListener('error', () => reject(new Error('浏览器video.play超时或媒体错误')), { once: true })),
      ]);
    } finally { clearTimeout(playTimeout); }
    await until(() => video.videoWidth > 0 && video.videoHeight > 0, '真实浏览器未解码视频尺寸');
    const track = stream.getVideoTracks()[0];
    await until(() => video.getVideoPlaybackQuality().totalVideoFrames >= 15,
      '持续视频帧不足15帧', 20000);
    const quality = video.getVideoPlaybackQuality();
    evidence.video = { width: video.videoWidth, height: video.videoHeight, totalFrames: quality.totalVideoFrames, droppedFrames: quality.droppedVideoFrames };
    check('持续解码至少15帧', video.videoWidth > 0 && video.videoHeight > 0 && quality.totalVideoFrames >= 15, evidence.video);
    if (audio) await until(async () => {
      const stats = await peers.at(-1)?.getStats();
      let samples = 0;
      stats?.forEach((item) => {
        if (item.type === 'inbound-rtp' && item.kind === 'audio') samples = Number(item.totalSamplesReceived ?? 0);
      });
      return samples > 0;
    }, 'Opus音频解码样本为零', 20000);
    const stats = await peers.at(-1)?.getStats();
    const candidatePairs: Json[] = [];
    evidence.transport = candidatePairs;
    stats?.forEach((item) => {
      if (item.type === 'candidate-pair' && item.state === 'succeeded') {
        const local = stats.get(item.localCandidateId);
        const remote = stats.get(item.remoteCandidateId);
        candidatePairs.push({ id: item.id, localProtocol: local?.protocol, remoteProtocol: remote?.protocol, localType: local?.candidateType, remoteType: remote?.candidateType, currentRoundTripTime: item.currentRoundTripTime });
      }
      if (item.type === 'inbound-rtp' && item.kind === 'video')
        evidence.inboundVideo = { framesDecoded: item.framesDecoded, jitterBufferDelay: item.jitterBufferDelay, jitterBufferEmittedCount: item.jitterBufferEmittedCount };
      if (item.type === 'inbound-rtp' && item.kind === 'audio')
        evidence.inboundAudio = { packetsReceived: item.packetsReceived, totalSamplesReceived: item.totalSamplesReceived, totalAudioEnergy: item.totalAudioEnergy };
    });
    check('ICE实际UDP候选对', candidatePairs.some((item) => item.localProtocol === 'udp' && item.remoteProtocol === 'udp'), candidatePairs);
    const inboundAudio = evidence.inboundAudio;
    if (audio) check('Opus实际解码', inboundAudio !== null && typeof inboundAudio === 'object' && Number(Reflect.get(inboundAudio, 'totalSamplesReceived')) > 0, inboundAudio);
    const before = quality.totalVideoFrames;
    const controls = [];
    for (const command of [
      { type: 'key' as const, action: 'down' as const, keycode: 0 },
      { type: 'key' as const, action: 'up' as const, keycode: 0 },
      { type: 'reset_video' as const },
    ]) controls.push(await mirroring.sendControl(command, AbortSignal.timeout(10000)));
    check('有序数据通道已发送控制', controls.every((item) => item.data.accepted === true), controls.map((item) => ({ accepted: item.data.accepted, logId: item.logId })));
    await until(() => video.getVideoPlaybackQuality().totalVideoFrames > before, '重置关键帧后无新增视频帧');
    const released = await mirroring.release(AbortSignal.timeout(20000));
    evidence.released = { id: released.data.id, status: released.data.status, cleanup: released.data.completion?.cleanup, processExited: released.data.completion?.process_exited, logId: released.logId };
    const terminal: { current: Json | null; removed: boolean } = { current: null, removed: false };
    const observations: Json[] = [];
    await until(async () => {
      const response = await fetch('/api/v2/sessions/' + encodeURIComponent(opened.data.id));
      const body: unknown = await response.json();
      const data = object(body) ? body.data : null;
      const observed = object(data) ? data : null;
      observations.push({ status: response.status, logId: object(body) ? body.log_id : null, sessionStatus: observed?.status, cleanup: object(observed?.completion) ? observed.completion.cleanup : null });
      if (response.status === 404) { terminal.removed = true; return true; }
      if (response.status !== 200 || observed?.status !== 'finished') return false;
      terminal.current = observed;
      return true;
    }, '服务端会话终态或移除证据缺失', 15000);
    evidence.terminal = { observations, session: terminal.current, removed: terminal.removed };
    const completion = terminal.current?.completion;
    check('服务端终态或已移除', terminal.removed ||
      (object(completion) && completion.cleanup === 'complete' && completion.process_exited === true), evidence.terminal);
    evidence.releaseReturnedOriginalIdentity = released.data.completion === undefined;
    check('本地轨道停止', track?.readyState === 'ended', track?.readyState);
    evidence.passed = true;
  } catch (error) {
    evidence.passed = false;
    evidence.error = error instanceof Error ? { name: error.name, message: error.message, code: Reflect.get(error, 'code'), kind: Reflect.get(error, 'kind'), logId: Reflect.get(error, 'logId') } : String(error);
    const snapshot = mirroring.snapshot();
    evidence.mirroringFailure = {
      session: snapshot.session, latestSession: observedSession, status: snapshot.status,
      opening: snapshot.opening, releasing: snapshot.releasing, controlReady: snapshot.controlReady,
      inputState: snapshot.inputState, cursor: snapshot.cursor, logs: snapshot.logs,
      errors: Object.fromEntries(Object.entries(snapshot.errors).map(([action, item]) => [action, {
        name: item.name, message: item.message, code: item.code, kind: item.kind,
        status: item.status, logId: item.logId,
      }])),
    };
    const identity = snapshot.session ?? observedSession;
    if (identity) {
      try {
        const response = await fetch('/api/v2/sessions/' + encodeURIComponent(identity.id), { signal: AbortSignal.timeout(3000) });
        evidence.failureSessionResponse = { status: response.status, body: await response.json() };
      } catch (reason) { evidence.failureSessionResponse = { error: String(reason) }; }
    }
    evidence.videoFailure = { width: video.videoWidth, height: video.videoHeight, readyState: video.readyState, networkState: video.networkState, error: video.error?.message, quality: video.getVideoPlaybackQuality(), tracks: mirroring.snapshot().stream?.getTracks().map((item) => ({ kind: item.kind, readyState: item.readyState, muted: item.muted })) };
    try {
      const peer = peers.at(-1);
      if (peer) {
        evidence.connection = { state: peer.connectionState, iceState: peer.iceConnectionState, signalingState: peer.signalingState };
        const inbound: Json[] = [];
        (await peer.getStats()).forEach((item) => {
          if (item.type === 'inbound-rtp') inbound.push({ kind: item.kind, packetsReceived: item.packetsReceived, bytesReceived: item.bytesReceived, framesReceived: item.framesReceived, framesDecoded: item.framesDecoded, totalSamplesReceived: item.totalSamplesReceived });
          if (item.type === 'codec') inbound.push({ type: 'codec', mimeType: item.mimeType, payloadType: item.payloadType });
        });
        evidence.inboundFailure = inbound;
        evidence.transceivers = peer.getTransceivers().map((item) => ({ mid: item.mid, direction: item.direction, currentDirection: item.currentDirection, kind: item.receiver.track.kind, trackState: item.receiver.track.readyState }));
        evidence.videoSdp = peer.currentRemoteDescription?.sdp.split(/\r?\n/).filter((line) => line.startsWith('m=video') || line.startsWith('a=rtpmap') || line.startsWith('a=fmtp')).slice(0, 20);
      }
    } catch (reason) { evidence.statsFailure = String(reason); }
    try {
      const definitions = await fetch('/api/v2/session-definitions');
      evidence.rawDefinitions = { status: definitions.status, text: (await definitions.text()).slice(0, 1500) };
    } catch (reason) { evidence.rawDefinitions = { error: String(reason) }; }
  } finally {
    try { await mirroring.dispose(); } catch (error) { evidence.disposeError = String(error); evidence.passed = false; }
    unsubscribe();
    video.srcObject = null;
    video.remove();
  }
  return evidence;
}

interface Protocol {
  call(method: string, parameters?: Json, timeout?: number): Promise<Json>;
  close(): void;
}
async function connect(url: string): Promise<Protocol> {
  const socket = new WebSocket(url);
  const pending = new Map<number, { resolve(value: Json): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let sequence = 0;
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP连接超时')), 10000);
    socket.addEventListener('open', () => { clearTimeout(timer); done(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP连接失败')); }, { once: true });
  });
  socket.addEventListener('message', (message) => {
    let value: unknown;
    try { value = JSON.parse(String(message.data)); } catch { return; }
    if (!object(value) || typeof value.id !== 'number') return;
    const task = pending.get(value.id);
    if (!task) return;
    pending.delete(value.id);
    clearTimeout(task.timer);
    if (value.error) task.reject(new Error(JSON.stringify(value.error)));
    else task.resolve(object(value.result) ? value.result : {});
  });
  socket.addEventListener('close', () => {
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('CDP连接关闭')); }
    pending.clear();
  });
  return {
    call(method, parameters = {}, timeout = 30000) {
      return new Promise((done, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} 超时`)); }, timeout);
        pending.set(id, { resolve: done, reject, timer });
        socket.send(JSON.stringify({ id, method, params: parameters }));
      });
    },
    close: () => socket.close(),
  };
}

function endpoint(child: ChildProcess): Promise<string> {
  return new Promise((done, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Edge调试端口未就绪')), 15000);
    const onData = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-32768);
      const match = output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9/._-]+)/);
      if (match?.[1]) { clearTimeout(timer); done(match[1]); }
    };
    child.stderr?.on('data', onData);
    child.stdout?.on('data', onData);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Edge在调试端口就绪前退出')); });
  });
}

async function runBrowser(baseUrl: string, deviceId: string, directory: string, smoke: boolean, audio: boolean, executable?: string): Promise<Json> {
  const candidates = [executable, process.env.DEVICEFORGE_TEST_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe']
    .filter((value): value is string => Boolean(value));
  let browserPath: string | undefined;
  for (const candidate of candidates) {
    try { await access(candidate); browserPath = candidate; break; } catch {}
  }
  if (!browserPath) throw new Error('未找到Edge，请传入--browser');
  const child = spawn(browserPath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--user-data-dir=' + join(directory, 'edge-profile'), 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let browser: Protocol | null = null;
  let page: Protocol | null = null;
  const report: Json = { executable: browserPath, pid: child.pid, baseUrl };
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const awaitExit = async (timeoutMs: number) => {
    if (exited()) return;
    await Promise.race([new Promise<void>((done) => child.once('exit', () => done())), delay(timeoutMs)]);
  };
  try {
    const ws = await endpoint(child);
    browser = await connect(ws);
    const target = new URL(ws);
    target.protocol = 'http:';
    target.pathname = '/json/new';
    const pageUrl = 'http://127.0.0.1:' + new URL(baseUrl).port + '/__webrtc_probe__';
    target.search = '?' + encodeURIComponent(pageUrl);
    const response = await fetch(target, { method: 'PUT', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('无法创建Edge探针标签');
    const targetInfo: unknown = await response.json();
    if (!object(targetInfo) || typeof targetInfo.webSocketDebuggerUrl !== 'string') throw new Error('Edge标签缺少CDP地址');
    page = await connect(targetInfo.webSocketDebuggerUrl);
    await page.call('Runtime.enable');
    const deadline = Date.now() + 10000;
    while (true) {
      const navigation = await page.call('Runtime.evaluate', { expression: '({url:location.href,state:document.readyState})', returnByValue: true });
      const value = object(navigation.result) ? navigation.result.value : null;
      if (object(value) && value.url === pageUrl && value.state !== 'loading') break;
      if (Date.now() > deadline) throw new Error('浏览器探针页面导航未就绪');
      await delay(50);
    }
    const expression = smoke
      ? '({userAgent:navigator.userAgent,webrtc:typeof RTCPeerConnection,secure:isSecureContext})'
      : `(async()=>(${browserCase.toString()})(${JSON.stringify(deviceId)},${audio}))()`;
    let evaluation: Json;
    try {
      evaluation = await page.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, 60000);
    } catch (error) {
      try {
        const progress = await page.call('Runtime.evaluate', { expression: 'globalThis.__deviceforgeWebRtcEvidence', returnByValue: true }, 5000);
        report.progress = object(progress.result) ? progress.result.value : null;
      } catch {}
      throw error;
    }
    if (object(evaluation.exceptionDetails)) throw new Error('浏览器探针异常：' + JSON.stringify(evaluation.exceptionDetails));
    report.result = object(evaluation.result) ? evaluation.result.value ?? null : null;
    return report;
  } finally {
    page?.close();
    if (browser) {
      try { await browser.call('Browser.close', {}, 5000); } catch {}
      browser.close();
    }
    await awaitExit(5000);
    if (!exited() && process.platform === 'win32' && child.pid) {
      const terminator = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      });
      report.browserTermination = 'owned-process-tree';
      await Promise.race([new Promise<void>((done) => terminator.once('exit', () => done())), delay(5000)]);
      await awaitExit(3000);
    }
    if (!exited()) {
      child.kill();
      report.browserTermination = 'direct-signal';
      await awaitExit(3000);
    }
    report.exit = { code: child.exitCode, signal: child.signalCode };
    report.exited = exited();
  }
}

function option(name: string): string | undefined {
  const value = process.argv.find((item) => item.startsWith(name + '='));
  return value?.slice(name.length + 1);
}

async function main(): Promise<void> {
  const baseUrl = option('--base-url');
  const deviceId = option('--device-id');
  const smoke = process.argv.includes('--browser-smoke');
  const audio = option('--audio') === 'true';
  if ((!baseUrl && !smoke) || (!deviceId && !smoke)) throw new Error('必须指定--base-url=<隔离宿主>和--device-id=<夹具设备>');
  const frontend = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const directory = join(resolve(frontend, '..'), 'artifacts', 'webrtc-browser-' + Date.now());
  await mkdir(directory, { recursive: true });
  const report: Json = { timestamp: new Date().toISOString(), passed: false, baseUrl, deviceId, smoke, audio };
  let server: Awaited<ReturnType<typeof createServer>> | null = null;
  try {
    server = await createServer({
      root: frontend,
      configFile: false,
      appType: 'custom',
      logLevel: 'error',
      server: {
        host: '127.0.0.1', port: 0, hmr: false,
        ...(baseUrl ? { proxy: { '/api': { target: baseUrl, changeOrigin: false } } } : {}),
      },
    });
    server.middlewares.use('/__webrtc_probe__', (_request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>WebRTC投屏探针</title><body>WebRTC投屏探针</body></html>');
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Vite探针端口不可用');
    const result = await runBrowser('http://127.0.0.1:' + address.port, deviceId ?? '', directory, smoke, audio, option('--browser'));
    report.browser = result;
    report.passed = object(result.result) && (smoke ? result.result.webrtc === 'function' : result.result.passed === true) && result.exited === true;
  } catch (error) {
    report.error = error instanceof Error ? { name: error.name, message: error.message } : String(error);
  } finally {
    if (server) {
      try {
        if (server.httpServer && 'closeAllConnections' in server.httpServer)
          server.httpServer.closeAllConnections();
        await server.close();
      } catch (error) { report.serverCleanupError = String(error); report.passed = false; }
    }
    report.completedAt = new Date().toISOString();
    const path = join(directory, 'report.json');
    await writeFile(path, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8' });
    console.log(JSON.stringify({ directory, passed: report.passed, browser: report.browser, error: report.error }));
    if (!report.passed) process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
