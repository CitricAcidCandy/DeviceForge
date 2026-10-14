import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import type { createBrowserMirroringSink } from '../src/features/mirroring-streaming/infrastructure/browser-sink.ts';

interface Check { readonly name: string; readonly passed: boolean; readonly detail: unknown }
interface BrowserResult { readonly passed: boolean; readonly checks: readonly Check[]; readonly capabilities: Record<string, unknown>; readonly video: Record<string, unknown>; readonly audio: Record<string, unknown> }
type SinkModule = { readonly createBrowserMirroringSink: typeof createBrowserMirroringSink };
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

// 本函数在真实浏览器中执行；所有编码、解码和音频节点均为原生对象。
async function probeBrowser(module: SinkModule): Promise<BrowserResult> {
  const checks: Check[] = [];
  const check = (name: string, passed: boolean, detail: unknown = null) => { checks.push({ name, passed, detail }); if (!passed) throw new Error(name); };
  const capabilities: Record<string, unknown> = { secureContext: isSecureContext, videoEncoder: typeof VideoEncoder !== 'undefined', videoDecoder: typeof VideoDecoder !== 'undefined', audioContext: typeof AudioContext !== 'undefined' };
  const video: Record<string, unknown> = {}; const audio: Record<string, unknown> = {};
  function wait(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
  async function until(predicate: () => boolean, label: string): Promise<void> { const deadline = performance.now() + 5000; while (!predicate()) { if (performance.now() > deadline) throw new Error(label); await wait(10); } }
  const errors: string[] = [];
  const frames: { width: number; height: number; timestamp: number; red: number; green: number; blue: number }[] = [];
  const delivered: VideoFrame[] = [];
  const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
  const drawing = canvas.getContext('2d'); if (!drawing) throw new Error('无法创建真实画布');
  let sink: ReturnType<typeof module.createBrowserMirroringSink> | null = null;
  let context: AudioContext | null = null;
  try {
    try {
    if (capabilities.videoEncoder && capabilities.videoDecoder) {
      let supported: VideoEncoderConfig | null = null;
      for (const codec of ['avc1.42001e', 'avc1.4d001e', 'avc1.64001e']) {
        const configuration: VideoEncoderConfig = { codec, width: 64, height: 64, bitrate: 300000, framerate: 30, latencyMode: 'realtime', avc: { format: 'annexb' } };
        try { if ((await VideoEncoder.isConfigSupported(configuration)).supported === true) { supported = configuration; break; } } catch { }
      }
      capabilities.h264EncoderConfiguration = supported;
      if (supported) {
        const encoded: { bytes: Uint8Array; timestamp: number; keyFrame: boolean }[] = [];
        const encoder = new VideoEncoder({ output: (chunk) => { const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes); encoded.push({ bytes, timestamp: chunk.timestamp, keyFrame: chunk.type === 'key' }); }, error: (error) => errors.push(error.message) });
        try {
          encoder.configure(supported);
          for (let index = 0; index < 3; ++index) {
            drawing.fillStyle = index === 0 ? '#e02020' : '#20d020'; drawing.fillRect(0, 0, 64, 64);
            const frame = new VideoFrame(canvas, { timestamp: index * 33333 }); encoder.encode(frame, { keyFrame: index === 0 }); frame.close();
          }
          await encoder.flush();
        } finally {
          if (encoder.state !== 'closed') encoder.close();
        }
        check('原生H264编码器输出关键帧与差分帧', encoded.length === 3 && encoded[0]?.keyFrame === true, encoded.map((entry) => ({ bytes: entry.bytes.length, timestamp: entry.timestamp, keyFrame: entry.keyFrame })));
        const first = encoded[0]; if (!first) throw new Error('原生编码器未输出首帧');
        const units: { start: number; end: number; type: number }[] = [];
        for (let offset = 0; offset + 3 < first.bytes.length; ++offset) {
          if (first.bytes[offset] !== 0 || first.bytes[offset + 1] !== 0) continue;
          const prefix = first.bytes[offset + 2] === 1 ? 3 : first.bytes[offset + 2] === 0 && first.bytes[offset + 3] === 1 ? 4 : 0;
          const nal = first.bytes[offset + prefix]; if (prefix === 0 || nal === undefined) continue;
          const previous = units.at(-1); if (previous) previous.end = offset;
          units.push({ start: offset, end: first.bytes.length, type: nal & 31 }); offset += prefix;
        }
        const configUnits = units.filter((unit) => unit.type === 7 || unit.type === 8);
        check('原生AnnexB关键帧包含真实SPS与PPS', configUnits.some((unit) => unit.type === 7) && configUnits.some((unit) => unit.type === 8), units.map((unit) => ({ type: unit.type, size: unit.end - unit.start })));
        const configurationBytes = new Uint8Array(configUnits.reduce((sum, unit) => sum + unit.end - unit.start, 0)); let configOffset = 0;
        for (const unit of configUnits) { const bytes = first.bytes.slice(unit.start, unit.end); configurationBytes.set(bytes, configOffset); configOffset += bytes.length; }
        const keyUnits = units.filter((unit) => unit.type !== 7 && unit.type !== 8);
        const keyBytes = new Uint8Array(keyUnits.reduce((sum, unit) => sum + unit.end - unit.start, 0)); let keyOffset = 0;
        for (const unit of keyUnits) { const bytes = first.bytes.slice(unit.start, unit.end); keyBytes.set(bytes, keyOffset); keyOffset += bytes.length; }
        const sps = configUnits.find((unit) => unit.type === 7); if (!sps) throw new Error('缺少SPS');
        const prefix = first.bytes[sps.start + 2] === 1 ? 3 : 4;
        const codec = 'avc1.' + Array.from(first.bytes.slice(sps.start + prefix + 1, sps.start + prefix + 4), (byte) => byte.toString(16).padStart(2, '0')).join('');
        const decoderSupport = await VideoDecoder.isConfigSupported({ codec, codedWidth: 64, codedHeight: 64, optimizeForLatency: true }); capabilities.h264DecoderSupport = decoderSupport;
        check('实际SPS派生配置被原生H264解码器支持', decoderSupport.supported === true, capabilities.h264DecoderSupport);
        sink = module.createBrowserMirroringSink({ videoOutput: (frame) => {
          drawing.drawImage(frame, 0, 0); const pixel = drawing.getImageData(32, 32, 1, 1).data;
          frames.push({ width: frame.displayWidth, height: frame.displayHeight, timestamp: frame.timestamp, red: pixel[0] ?? 0, green: pixel[1] ?? 0, blue: pixel[2] ?? 0 }); delivered.push(frame);
        }, error: (error) => errors.push(error.message) });
        const controller = new AbortController();
        await sink.packet({ kind: 'video_config', epoch: 1, timestampUs: 0, configuration: { codec: 'h264', format: 'annexb', width: 64, height: 64 } }, controller.signal);
        await sink.packet({ kind: 'video', epoch: 1, timestampUs: 0, keyFrame: false, configuration: true, bytes: configurationBytes }, controller.signal);
        const second = encoded[1]; if (!second) throw new Error('缺少真实差分帧');
        await sink.packet({ kind: 'video', epoch: 1, timestampUs: second.timestamp, keyFrame: false, configuration: false, bytes: second.bytes }, controller.signal);
        await wait(50); check('配置后真实差分帧在首关键帧前被忽略', frames.length === 0, frames.length);
        for (const [index, entry] of encoded.entries()) await sink.packet({ kind: 'video', epoch: 1, timestampUs: entry.timestamp, keyFrame: entry.keyFrame, configuration: false, bytes: index === 0 ? keyBytes : entry.bytes }, controller.signal);
        await until(() => frames.length === 3 || errors.length > 0, '真实H264视频解码未在5秒内交付');
        check('当前browser-sink实际解码H264并保持尺寸与PTS', frames.length === 3 && frames.every((frame) => frame.width === 64 && frame.height === 64) && frames.map((frame) => frame.timestamp).join(',') === '0,33333,66666', frames);
        const redFrame = frames[0]; const greenFrame = frames[1];
        check('原生解码像素与编码画布的红绿输入一致', redFrame !== undefined && greenFrame !== undefined && redFrame.red > 170 && redFrame.green < 70 && greenFrame.green > 150 && greenFrame.red < 100, frames);
        check('交付后原生VideoFrame全部关闭', delivered.every((frame) => frame.format === null), delivered.map((frame) => frame.format));
        sink.reset?.();
        let resetRejected = false;
        try { await sink.packet({ kind: 'video', epoch: 1, timestampUs: 999999, keyFrame: true, configuration: false, bytes: keyBytes }, controller.signal); } catch { resetRejected = true; }
        check('重置后旧画面配置与解码链失效', resetRejected);
        const nextController = new AbortController();
        await sink.packet({ kind: 'video_config', epoch: 2, timestampUs: 0, configuration: { codec: 'h264', format: 'annexb', width: 64, height: 64 } }, nextController.signal);
        await sink.packet({ kind: 'video', epoch: 2, timestampUs: 0, keyFrame: false, configuration: true, bytes: configurationBytes }, nextController.signal);
        await sink.packet({ kind: 'video', epoch: 2, timestampUs: 999999, keyFrame: true, configuration: false, bytes: keyBytes }, nextController.signal);
        await until(() => frames.length === 4 || errors.length > 0, '重连新代H264未交付');
        check('新连接代次重新配置后真实解码', frames.at(-1)?.timestamp === 999999, frames.at(-1));
        const beforeAbort = frames.length;
        await sink.packet({ kind: 'video', epoch: 2, timestampUs: 1000000, keyFrame: true, configuration: false, bytes: keyBytes }, nextController.signal);
        nextController.abort(); await wait(100);
        check('取消关闭真实解码器且不交付排队旧帧', frames.length === beforeAbort, { beforeAbort, afterAbort: frames.length });
        sink.dispose?.(); sink = null;
        check('原生编码和解码无异步错误', errors.length === 0, errors);
        video.frames = frames; video.encoded = encoded.map((entry) => ({ bytes: Array.from(entry.bytes), timestamp: entry.timestamp, keyFrame: entry.keyFrame }));
        video.spsPps = Array.from(configurationBytes); video.codec = codec; video.actualDecoded = true;
      } else { video.actualDecoded = false; video.reason = '当前真实Edge未提供可用H264 AnnexB编码配置'; }
    } else { video.actualDecoded = false; video.reason = '当前真实浏览器缺少WebCodecs编码或解码入口'; }
    } catch (error) { video.actualDecoded = false; video.failure = error instanceof Error ? error.message : '原生视频验证失败'; sink?.dispose?.(); sink = null; }
    if (capabilities.audioContext) {
      context = new AudioContext({ sampleRate: 48000 });
      capabilities.audioInitialState = context.state;
      const gain = context.createGain(); gain.gain.value = 0; gain.connect(context.destination);
      const analyser = context.createAnalyser(); analyser.fftSize = 2048; analyser.connect(gain);
      const sources: { node: AudioBufferSourceNode; starts: number; stops: number; disconnects: number; ended: boolean; buffer: number[][] | null }[] = [];
      const nativeCreate = context.createBufferSource.bind(context);
      context.createBufferSource = () => {
        const node = nativeCreate(); const observed: { node: AudioBufferSourceNode; starts: number; stops: number; disconnects: number; ended: boolean; buffer: number[][] | null } = { node, starts: 0, stops: 0, disconnects: 0, ended: false, buffer: null };
        const start = node.start.bind(node); const stop = node.stop.bind(node); const disconnect = node.disconnect.bind(node);
        node.start = (when = 0, offset = 0, duration?: number) => {
          ++observed.starts; observed.buffer = node.buffer ? [Array.from(node.buffer.getChannelData(0).slice(0, 8)), Array.from(node.buffer.getChannelData(1).slice(0, 8))] : null;
          if (duration === undefined) start(when, offset); else start(when, offset, duration);
        };
        node.stop = (when = 0) => { ++observed.stops; stop(when); };
        node.disconnect = () => { ++observed.disconnects; disconnect(); };
        node.addEventListener('ended', () => { observed.ended = true; }); sources.push(observed); return node;
      };
      await context.resume(); check('真实AudioContext在CDP用户激活下运行', context.state === 'running', { sampleRate: context.sampleRate, state: context.state, activation: navigator.userActivation.isActive });
      sink = module.createBrowserMirroringSink({ videoOutput: () => {}, audioContext: context, audioDestination: analyser });
      const audioController = new AbortController();
      await sink.packet({ kind: 'audio_config', epoch: 1, timestampUs: 0, configuration: { codec: 'pcm_s16le', sample_rate: 48000, channels: 2 } }, audioController.signal);
      const pcm = new Uint8Array(4800 * 4); const pcmView = new DataView(pcm.buffer);
      for (let index = 0; index < 4800; ++index) { const sample = Math.round(Math.sin(index * Math.PI * 2 * 440 / 48000) * 8192); pcmView.setInt16(index * 4, sample, true); pcmView.setInt16(index * 4 + 2, Math.round(sample / 2), true); }
      await sink.packet({ kind: 'audio', epoch: 1, timestampUs: 0, bytes: pcm }, audioController.signal);
      await wait(30); const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples);
      check('PCM经真实WebAudio图处理且原生音源已调度', sources.length === 1 && sources[0]?.starts === 1 && samples.some((sample) => Math.abs(sample) > 0.01), { sources: sources.length, peak: Math.max(...samples.map(Math.abs)) });
      const firstSource = sources[0]; const expected = pcmView.getInt16(4, true) / 32768;
      check('真实AudioBuffer左右声道保持PCM16交错样本', firstSource?.buffer?.[0]?.[1] === expected && firstSource.buffer[1]?.[1] === pcmView.getInt16(6, true) / 32768, firstSource?.buffer);
      audioController.abort();
      check('取消停止并断开实际排队音源', firstSource !== undefined && firstSource.stops === 1 && firstSource.disconnects === 1 && firstSource.node.onended === null, firstSource ? { stops: firstSource.stops, disconnects: firstSource.disconnects, onended: firstSource.node.onended } : null);
      const audioNext = new AbortController(); await sink.packet({ kind: 'audio', epoch: 1, timestampUs: 100000, bytes: pcm }, audioNext.signal);
      sink.reset?.(); const resetSource = sources.at(-1);
      check('重置清理实际音源并撤销音频配置', resetSource !== undefined && resetSource.stops === 1 && resetSource.disconnects === 1);
      let missingAudio = false; try { await sink.packet({ kind: 'audio', epoch: 1, timestampUs: 0, bytes: pcm }, audioNext.signal); } catch { missingAudio = true; }
      check('重置后的PCM不能绕过音频配置', missingAudio);
      await sink.packet({ kind: 'audio_config', epoch: 2, timestampUs: 0, configuration: { codec: 'pcm_s16le', sample_rate: 48000, channels: 2 } }, audioNext.signal);
      await sink.packet({ kind: 'audio', epoch: 2, timestampUs: 0, bytes: pcm }, audioNext.signal); sink.dispose?.(); sink = null;
      const disposedSource = sources.at(-1); check('销毁停止自己的真实音源而保留共享上下文', disposedSource !== undefined && disposedSource.stops === 1 && disposedSource.disconnects === 1 && context.state === 'running');
      audio.actualScheduled = true; audio.graphPeak = Math.max(...samples.map(Math.abs)); audio.sources = sources.map((source) => ({ starts: source.starts, stops: source.stops, disconnects: source.disconnects, ended: source.ended, buffer: source.buffer }));
      analyser.disconnect(); gain.disconnect(); context.createBufferSource = nativeCreate; await context.close(); audio.contextClosed = context.state === 'closed'; context = null;
    } else { audio.actualScheduled = false; audio.reason = '当前真实浏览器缺少WebAudio入口'; }
    return { passed: video.actualDecoded === true && audio.actualScheduled === true && checks.every((entry) => entry.passed), checks, capabilities, video, audio };
  } catch (error) {
    audio.actualScheduled = false; audio.failure = error instanceof Error ? error.message : '原生音频验证失败';
    return { passed: false, checks, capabilities, video, audio };
  } finally {
    sink?.dispose?.(); if (context && context.state !== 'closed') await context.close();
  }
}

interface Protocol { call(method: string, parameters?: Record<string, unknown>, timeout?: number): Promise<unknown>; close(): void }
async function connectProtocol(url: string): Promise<Protocol> {
  const socket = new WebSocket(url); const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>(); let sequence = 0;
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { socket.close(); reject(new Error('CDP连接超时')); }, 10000); socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true }); socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP连接失败')); }, { once: true }); });
  socket.addEventListener('message', (event) => {
    let reply: unknown; try { reply = JSON.parse(String(event.data)); } catch { return; }
    if (!record(reply) || typeof reply.id !== 'number') return; const entry = pending.get(reply.id); if (!entry) return;
    pending.delete(reply.id); clearTimeout(entry.timer); if (reply.error) entry.reject(new Error('CDP命令失败：' + JSON.stringify(reply.error).slice(0, 400))); else entry.resolve(reply.result);
  });
  socket.addEventListener('close', () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('CDP连接已关闭')); } pending.clear(); });
  return {
    call(method, parameters = {}, timeout = 30000) { return new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP命令超时')); }, timeout); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params: parameters })); }); },
    close: () => socket.close(),
  };
}
function browserEndpoint(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let diagnostic = ''; const timer = setTimeout(() => finish(new Error('浏览器调试端口在15秒内未就绪')), 15000);
    const data = (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-65536); const found = diagnostic.match(new RegExp('DevTools listening on (ws://127[.]0[.]0[.]1:[0-9]+/[A-Za-z0-9/._-]+)')); if (found?.[1]) finish(null, found[1]); };
    const exit = () => finish(new Error('浏览器在调试端口就绪前退出')); const failure = () => finish(new Error('原生浏览器启动失败'));
    function finish(error: Error | null, value = '') { clearTimeout(timer); child.stderr?.off('data', data); child.off('exit', exit); child.off('error', failure); if (error) reject(error); else resolve(value); }
    child.stderr?.on('data', data); child.once('exit', exit); child.once('error', failure);
  });
}
async function nativeBrowser(directory: string, pageUrl: string, report: Record<string, unknown>): Promise<unknown> {
  const candidates = [process.env.DEVICEFORGE_TEST_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter((value): value is string => typeof value === 'string' && value.length > 0);
  let executable: string | null = null; for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch { } }
  if (!executable) throw new Error('未找到真实Edge，请设置DEVICEFORGE_TEST_BROWSER');
  const flags = ['--headless=new', '--disable-gpu', ...(process.argv.includes('--in-process-gpu') ? ['--in-process-gpu'] : []), '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + join(directory, 'browser-profile'), 'about:blank'];
  const child = spawn(executable, flags, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let browser: Protocol | null = null; let page: Protocol | null = null; let diagnostics = ''; child.stderr?.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-16384); });
  report.browserProcess = { pid: child.pid, executable, flags, ownsProfile: true };
  try {
    const endpoint = await browserEndpoint(child); browser = await connectProtocol(endpoint); report.browserVersion = await browser.call('Browser.getVersion');
    const targetUrl = new URL(endpoint); targetUrl.protocol = 'http:'; targetUrl.pathname = '/json/new'; targetUrl.search = '?' + encodeURIComponent(pageUrl);
    const response = await fetch(targetUrl, { method: 'PUT', signal: AbortSignal.timeout(10000) }); assert.ok(response.ok, '无法创建本次探针标签'); const target: unknown = await response.json();
    assert.ok(record(target) && typeof target.webSocketDebuggerUrl === 'string'); page = await connectProtocol(target.webSocketDebuggerUrl); await page.call('Runtime.enable');
    const deadline = Date.now() + 10000;
    while (true) {
      try {
        const ready = await page.call('Runtime.evaluate', { expression: '({url: location.href, state: document.readyState})', returnByValue: true });
        report.navigationLast = ready;
        if (record(ready) && record(ready.result) && record(ready.result.value) && ready.result.value.url === pageUrl && ready.result.value.state !== 'loading') break;
      } catch (error) { report.navigationError = error instanceof Error ? error.message : '导航探测失败'; }
      if (Date.now() > deadline) throw new Error('探针页面导航未就绪'); await delay(50);
    }
    report.activation = 'CDP Runtime.evaluate userGesture=true；不改变生产自动播放规则';
    const expression = '(async()=>{ const module=await import("/src/features/mirroring-streaming/infrastructure/browser-sink.ts"); return await (' + probeBrowser.toString() + ')(module); })()';
    const evaluation = await page.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, 30000);
    if (!record(evaluation)) throw new Error('探针响应不是对象'); if (evaluation.exceptionDetails) { report.browserException = evaluation.exceptionDetails; throw new Error('浏览器原生媒体探针异常'); }
    if (!record(evaluation.result)) throw new Error('探针结果缺失'); return evaluation.result.value;
  } catch (error) { report.browserPrimaryFailure = error instanceof Error ? error.message : '浏览器调用失败'; throw error; } finally {
    page?.close(); if (browser) { try { await browser.call('Browser.close', {}, 5000); } catch { } browser.close(); }
    if (child.exitCode === null && child.signalCode === null) await Promise.race([new Promise<void>((resolve) => { child.once('exit', () => resolve()); }), delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([new Promise<void>((resolve) => { child.once('exit', () => resolve()); }), delay(2000)]); }
    report.browserDiagnostics = diagnostics; report.browserExited = child.exitCode !== null || child.signalCode !== null; report.browserExit = { code: child.exitCode, signal: child.signalCode }; if (report.browserExited !== true) report.browserCleanupFailure = '自有浏览器子进程句柄未确认退出';
  }
}
async function identity(path: string) { const bytes = await readFile(path); return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }
async function sourceFiles(directory: string): Promise<string[]> { const paths: string[] = []; for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) paths.push(...await sourceFiles(path)); else if (entry.isFile() && /\.ts$/.test(entry.name)) paths.push(path); } return paths.sort(); }

export async function runMirroringMediaBrowserProbe(): Promise<{ passed: boolean; report: string }> {
  if (process.argv.slice(2).some((argument) => argument !== '--in-process-gpu') || process.argv.slice(2).length > 1) throw new Error('探针只接受可选的--in-process-gpu');
  const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const root = resolve(frontend, '..');
  const directory = join(root, 'artifacts', 'mirroring-media-browser-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID()); await mkdir(directory, { recursive: true });
  const report: Record<string, unknown> = { timestamp: new Date().toISOString(), passed: false, scope: '当前冻结browser-sink的原生Edge H264编码与实际解码、PCM图调度和资源释放；不含真实设备、产品页面、扬声器听觉或性能测试' };
  const inputs = [fileURLToPath(import.meta.url), ...await sourceFiles(join(frontend, 'src/features/mirroring-streaming')), ...await sourceFiles(join(frontend, 'src/shared'))];
  report.inputsBefore = await Promise.all(inputs.map(identity)); let server: Awaited<ReturnType<typeof createServer>> | null = null;
  try {
    report.stage = '启动临时本地源码服务';
    server = await createServer({ root: frontend, configFile: false, appType: 'custom', logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
    server.middlewares.use('/__mirroring_media_probe__', (_request, response) => { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>投屏原生媒体探针</title><body>原生媒体功能验证</body></html>'); });
    await server.listen(); const address = server.httpServer?.address(); assert.ok(address && typeof address !== 'string');
    report.stage = '实际平台能力与媒体行为'; const result = await nativeBrowser(directory, 'http://127.0.0.1:' + address.port + '/__mirroring_media_probe__', report); report.browser = result;
    assert.ok(record(result) && result.passed === true, '当前平台未证明H264实际解码和PCM实际调度全部通过'); report.passed = report.browserExited === true; report.stage = '完成';
  } catch (error) { report.passed = false; report.error = error instanceof Error ? { name: error.name, message: error.message.slice(0, 600) } : { message: '探针失败' }; if (!report.browser) report.capabilityBoundary = '浏览器运行上下文不可用，WebCodecs与WebAudio能力查询和行为探针未执行'; }
  finally {
    if (server) { const http = server.httpServer; if (http && 'closeAllConnections' in http) http.closeAllConnections(); try { await server.close(); } catch { report.serverCleanupFailed = true; report.passed = false; } }
    report.inputsAfter = await Promise.all(inputs.map(identity)); report.inputsStable = JSON.stringify(report.inputsBefore) === JSON.stringify(report.inputsAfter); if (!report.inputsStable) report.passed = false;
    report.completedAt = new Date().toISOString(); const path = join(directory, 'report.json'); await writeFile(path, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    return { passed: report.passed === true, report: path };
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runMirroringMediaBrowserProbe(); console.log(JSON.stringify(result)); if (!result.passed) process.exitCode = 1;
}
