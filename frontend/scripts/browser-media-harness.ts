import { createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MediaPage } from '../src/app/product/pages/media.tsx';
import { createProductServices } from '../src/app/product/services.ts';
import { createMediaMaterial } from './browser-media-stream.ts';
import { createMediaFixture, mediaSessionId } from './browser-media-fixture.ts';
import { observeNativeMedia } from './browser-media-observation.ts';

const wait = (milliseconds = 16) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
function check(value: unknown, message: string): asserts value {if (!value) throw new Error(message);}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
async function until(predicate: () => boolean, message: string) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {if (performance.now() >= deadline) throw new Error(message); await wait(10);}
}
function button(label: string): HTMLButtonElement {
  const target = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === label);
  check(target instanceof HTMLButtonElement, `没有找到媒体按钮：${label}`); return target;
}
async function click(label: string) {const target = button(label); check(!target.disabled, `媒体按钮不可用：${label}`); target.click(); await wait();}
async function fill(label: string, value: string) {
  const targetLabel = [...document.querySelectorAll('label')].find(item => item.textContent?.trim() === label);
  const target = targetLabel instanceof HTMLLabelElement ? document.getElementById(targetLabel.htmlFor) : null;
  check(target instanceof HTMLInputElement, `没有找到媒体字段：${label}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; check(setter, '原生输入 setter 缺失');
  setter.call(target, value); target.dispatchEvent(new Event('input', {bubbles: true})); await wait();
}
function center(canvas: HTMLCanvasElement): readonly number[] {
  const context = canvas.getContext('2d'); check(context, '产品投屏画布没有实际 2D 上下文'); return [...context.getImageData(32, 32, 1, 1).data];
}

export async function verifyMediaPage() {
  const checks: {name: string; passed: true; detail?: unknown}[] = []; const gaps: string[] = [];
  const material = await createMediaMaterial(); const fixture = await createMediaFixture(material);
  const native = observeNativeMedia(); const target = document.createElement('main'); document.body.append(target); const root = createRoot(target);
  const services = createProductServices({baseUrl: location.origin, transport: fixture.transport, panelTarget: () => target});
  let disposed = false; const passed = (name: string, detail?: unknown) => checks.push({name, passed: true, ...(detail === undefined ? {} : {detail})});
  const count = (path: string) => fixture.requests.filter(item => item.path === path && item.method === 'POST').length;
  const inputRequests = () => fixture.requests.filter(item => item.path === `/api/v2/sessions/${mediaSessionId}/input`);
  const controlValues = () => inputRequests().map(item => {
    check(object(item.input) && Array.isArray(item.input['bytes']) && item.input['bytes'].every(value => typeof value === 'number'), '控制输入没有公开原字节数组');
    const bytes = new Uint8Array(item.input['bytes']); const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    check(text.endsWith('\n'), '控制原字节缺少单行换行结束符'); const value: unknown = JSON.parse(text); return {bytes: [...bytes], text, value};
  });
  try {
    await services.runtime.operations.refresh(AbortSignal.timeout(5000)); await services.runtime.devices.refreshDirectories(AbortSignal.timeout(5000));
    const provider = fixture.providers[0]; const other = fixture.providers[1]; check(provider && other, '受控媒体提供者缺失');
    services.runtime.devices.select({providerId: provider.id, generation: provider.generation, localId: 'emulator-fixture'});
    root.render(createElement(StrictMode, null, createElement(MediaPage, {services}))); await wait();
    check(button('开始投屏').disabled, '未查询公开直播目录仍允许打开'); await click('检查直播能力');
    await until(() => !button('开始投屏').disabled, '真实 MediaPage 没有准入公开直播目录'); passed('真实 MediaPage 与 ProductServices 按直播目录准入');
    const audioSwitch = document.getElementById('media-audio'); const controlSwitch = document.getElementById('media-control');
    check(audioSwitch instanceof HTMLButtonElement && controlSwitch instanceof HTMLButtonElement, '官方音频与控制开关缺失');
    audioSwitch.click(); controlSwitch.click(); await wait(); await click('开始投屏');
    const canvas = target.querySelector('canvas'); check(canvas instanceof HTMLCanvasElement, '真实页面缺少投屏画布');
    await until(() => native.frames.length >= 1 && canvas.width === 64 && canvas.height === 64, '受控 DFML 没有通过原生 H.264 解码到产品画布');
    const red = center(canvas); check((red[0] ?? 0) > 170 && (red[1] ?? 255) < 70 && (red[2] ?? 255) < 70, '产品画布像素与原生编码红色输入不一致');
    check(native.frames[0]?.width === 64 && native.frames[0].height === 64 && native.frames[0].timestamp === 0 && native.frames[0].closed, '原生帧尺寸、时间戳或释放状态不正确');
    passed('原生 VideoEncoder H.264 经 DFML 和真实 MediaPage 解码到 64×64 红色画布', {pixel: red, encoder: material.encoder, chunks: fixture.firstCount});
    await until(() => native.peak() > 0.01, 'PCM 没有在产品实例的真实 AudioContext 音频图中处理');
    const audio = native.sources[0]; check(native.contexts[0]?.state === 'running' && audio?.starts === 1 && audio.destinationConnections === 1 && audio.left.length === 8 && audio.right.length === 8, '产品原生音频上下文、音源调度或 destination 连接不正确');
    check(audio.left[1] !== 0 && Math.abs((audio.left[1] ?? 0) / 2 - (audio.right[1] ?? 0)) < 0.0001, '原生 AudioBuffer 未保持 PCM 左右交错声道');
    passed('产品播放音频通过真实 AudioContext、原生 PCM 音源与实际音频图', {peak: native.peak(), destinationConnections: audio.destinationConnections, sampleRate: native.contexts[0]?.sampleRate, left: audio.left, right: audio.right});
    const opening = fixture.requests.find(item => item.path === '/api/v2/sessions' && item.method === 'POST');
    check(object(opening?.input) && object(opening.input['input']) && opening.input['input']['audio'] === true && opening.input['input']['control'] === true, '产品开关没有进入真实会话打开字段');
    await until(() => fixture.held() === 1, '首批媒体交付后没有继续等待输出'); await click('暂停读取');
    await until(() => !services.runtime.mirroringStreaming.snapshot().pending.includes('output') && fixture.held() === 0, '暂停没有结束输出等待');
    check(count(`/api/v2/sessions/${mediaSessionId}/cancel`) === 0 && count('/api/v2/sessions') === 1, '暂停读取错误停止或重开服务器会话');
    check(native.decoders.every(decoder => decoder.state === 'closed'), '暂停没有关闭旧输出信号持有的原生解码器');
    passed('暂停只取消输出等待，0 次服务器 cancel，关闭旧原生解码器', {abortedOutput: fixture.aborted()});
    fixture.append(1); await click('继续读取');
    await until(() => native.frames.length >= 2 && (center(canvas)[1] ?? 0) > 150, '继续读取没有交付新的原生绿色关键帧');
    check(count('/api/v2/sessions') === 1, '继续读取错误新建直播');
    check(fixture.requests.some(item => item.path === `/api/v2/sessions/${mediaSessionId}/output?after=${fixture.firstCount}&limit=100`), '恢复读取没有保留实际游标与100页长');
    passed('继续读取复用原会话与游标，原生解码新绿色关键帧', {pixel: center(canvas), frame: native.frames.at(-1)});
    await until(() => !button('返回').disabled, 'Streaming 后控制入口未就绪'); await click('返回');
    await until(() => inputRequests().length === 2, '返回按键没有连续交付 down/up 原字节');
    await fill('设备输入文本', '中文媒体验证'); await click('发送文本'); await until(() => inputRequests().length === 3, '文本控制没有交付原字节');
    const controls = controlValues(); const down = controls[0]?.value; const up = controls[1]?.value; const text = controls[2]?.value;
    check(object(down) && down['type'] === 'key' && down['action'] === 'down' && down['keycode'] === 4 && down['epoch'] === 1
      && object(up) && up['action'] === 'up' && object(text) && text['type'] === 'text' && text['text'] === '中文媒体验证' && text['epoch'] === 1, '设备控制原字节没有保持按键顺序、UTF-8 与连接代次');
    passed('产品按键与中文文本控制保持原字节、顺序及 epoch', controls);
    services.runtime.devices.select({providerId: other.id, generation: other.generation, localId: 'emulator-fixture'}); await wait();
    const beforeOldControl = inputRequests().length;
    check(button('返回').disabled && button('发送文本').disabled, '同本地设备 ID 的另一提供者仍获得旧会话控制资格');
    button('返回').click(); button('发送文本').click(); await wait();
    check(inputRequests().length === beforeOldControl, '旧完整设备引用仍向会话提交控制');
    passed('切换同 localId 的不同提供者后旧会话控制拒绝');
    services.runtime.devices.select({providerId: provider.id, generation: provider.generation, localId: 'emulator-fixture'}); await wait();
    await click('暂停读取'); await until(() => fixture.held() === 0, '恢复游标前输出仍占用');
    const recovery = [...target.querySelectorAll('summary')].find(item => item.textContent === '恢复已知直播会话');
    check(recovery instanceof HTMLElement, '恢复会话原生 details 入口缺失'); recovery.click(); await wait();
    await fill('直播会话 ID', mediaSessionId); await click('恢复画面读取位置');
    await until(() => !services.runtime.mirroringStreaming.snapshot().pending.includes('resume'), '恢复会话请求未结束');
    check(count('/api/v2/sessions') === 1 && fixture.requests.some(item => item.path === `/api/v2/sessions/${mediaSessionId}` && item.method === 'GET'), '恢复既有会话错误重新打开');
    fixture.append(2); await click('继续读取');
    await until(() => native.frames.length >= 3 && (center(canvas)[2] ?? 0) > 170, '恢复原会话没有交付新的原生蓝色画面');
    passed('恢复已知直播 GET 原会话且不 open，继续解码蓝色画面', {pixel: center(canvas), frame: native.frames.at(-1)});
    await click('截取画面');
    const image = () => target.querySelector('img.screenshot-preview');
    await until(() => image() instanceof HTMLImageElement && image()?.getAttribute('src') !== null, '截图任务没有创建 Blob 预览');
    const preview = image(); check(preview instanceof HTMLImageElement, '截图预览不是真实图像元素');
    await until(() => preview.complete && preview.naturalWidth === 64 && preview.naturalHeight === 64, '截图 PNG 没有被浏览器实际解析到正确尺寸');
    const saveImage = [...target.querySelectorAll('a[download]')].find(item => item.getAttribute('download') === 'screenshot.png');
    check(saveImage instanceof HTMLAnchorElement && saveImage.href === preview.src, '原始截图保存链接没有使用同一 Blob');
    const pngBytes = new Uint8Array(await (await fetch(saveImage.href)).arrayBuffer());
    const pngDigest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', pngBytes))].map(value => value.toString(16).padStart(2, '0')).join('');
    check(pngBytes.length === fixture.screenshot.size && pngDigest === fixture.screenshot.sha256, '截图下载或保存改变了原字节');
    passed('真实截图任务、PNG Blob 预览尺寸与原字节 SHA-256 保存', {size: pngBytes.length, sha256: pngDigest, width: preview.naturalWidth, height: preview.naturalHeight});
    if (material.movie) {
      await fill('录制时长（毫秒）', '1000'); await click('录制并下载 MP4');
      const movie = () => target.querySelector('video.recording-preview');
      await until(() => movie() instanceof HTMLVideoElement, '录像任务没有创建 MP4 Blob 预览');
      const video = movie(); check(video instanceof HTMLVideoElement, 'MP4 预览不是原生 video');
      await until(() => video.readyState >= 1 && video.videoWidth === 64 && video.videoHeight === 64, '原生 MP4 预览没有加载正确元数据');
      const saveMovie = [...target.querySelectorAll('a[download]')].find(item => item.getAttribute('download') === 'screen.mp4');
      check(saveMovie instanceof HTMLAnchorElement && saveMovie.href === video.src, '录像保存没有使用已校验 Blob');
      const bytes = new Uint8Array(await (await fetch(saveMovie.href)).arrayBuffer());
      check(bytes.length === material.movie.size && JSON.stringify([...bytes]) === JSON.stringify([...new Uint8Array(await material.movie.arrayBuffer())]), 'MP4 预览链接改变录像原字节');
      passed('原生 MediaRecorder MP4 经录像任务校验、Blob 元数据与原字节保存', {bytes: bytes.length, width: video.videoWidth, height: video.videoHeight, duration: Number.isFinite(video.duration) ? video.duration : String(video.duration)});
    } else gaps.push(material.movieReason ?? '原生 MP4 素材不可用，录像预览未执行');
    await click('关闭控制输入'); await until(() => services.runtime.mirroringStreaming.snapshot().inputState === 'eof', 'EOF 未收敛控制入口');
    check(button('返回').disabled && count(`/api/v2/sessions/${mediaSessionId}/eof`) === 1, '关闭控制输入没有真实 EOF 或保留了入口');
    await click('停止直播'); await until(() => services.runtime.mirroringStreaming.snapshot().session?.status === 'finished' && fixture.held() === 0, '停止直播没有完成当前输出与会话');
    check(count(`/api/v2/sessions/${mediaSessionId}/cancel`) === 1, '停止按钮没有仅提交一次服务器 cancel');
    passed('EOF 禁用控制、停止直播仅一次 cancel 并终结输出');
    root.unmount(); await services.dispose(); disposed = true;
    check(native.contexts.length === 1 && native.contexts.every(context => context.state === 'closed') && native.decoders.every(decoder => decoder.state === 'closed')
      && native.frames.every(frame => frame.closed) && native.sources.every(source => source.disconnects >= 1) && native.errors.length === 0 && services.mediaDisplay.error() === null, '产品关闭后原生音视频资源未收敛或存在解码错误');
    passed('产品销毁关闭真实 AudioContext、所有解码器、VideoFrame 与音频节点');
    return {passed: true, checks, gaps, requests: fixture.requests, native: {frames: native.frames, decoders: native.decoders.map(decoder => decoder.state), contexts: native.contexts.map(context => context.state), audioPeak: native.peak(), audioSources: native.sources.map(source => ({starts: source.starts, stops: source.stops, disconnects: source.disconnects})), errors: native.errors},
      scope: '真实 MediaPage/ProductServices、浏览器原生 H.264 编解码与画布、WebAudio 图、受控 HTTP 协议夹具；不含 Rust 服务、真实设备、桌面输入、扬声器听觉或视觉审核'};
  } finally {fixture.dispose(); if (!disposed) {root.unmount(); await services.dispose();} native.restore(); target.remove();}
}
