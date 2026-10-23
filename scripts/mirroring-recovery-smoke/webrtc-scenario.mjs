// 真实浏览器执行生产公开工厂；仅观看，不调用触摸、键盘或剪贴板接口。
export async function recoveredWebrtcScenario(device) {
  const evidence = { passed: false, checks: [], device, user_input_messages: 0 };
  const until = async (read, label, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await read();
      if (value) return value;
      await new Promise((done) => setTimeout(done, 30));
    }
    throw new Error(label);
  };
  let model;
  let session;
  try {
    const api = await import('/src/services/api/index.ts');
    const feature = await import('/src/features/mirroring-streaming/index.ts');
    const client = api.createApiClient({ baseUrl: location.origin, transport: (input, init) => fetch(input, init) });
    const peers = [];
    model = feature.createHttpWebRtcMirroring(client, {
      peerConnectionFactory: () => { const peer = new RTCPeerConnection(); peers.push(peer); return peer; },
    });
    const video = document.createElement('video');
    video.autoplay = true; video.muted = true; video.playsInline = true;
    video.setAttribute('aria-label', '恢复后真实浏览器视频');
    video.width = 384; video.height = 384;
    document.body.append(video);
    await model.refreshDefinitions(AbortSignal.timeout(10000));
    const result = await model.open({ device_id: device, audio: false, control: false, reconnect_attempts: 0,
      max_size: 1024, max_fps: 30, video_bit_rate: 4000000 }, AbortSignal.timeout(30000));
    session = result.data;
    evidence.session = { id: session.id, generation: session.generation, operation: session.operation, log_id: result.logId };
    evidence.answer_observed = typeof model.snapshot().logs.answer === 'string';
    if (!evidence.answer_observed) throw new Error('生产工厂未完成 answer');
    await until(() => model.snapshot().status === 'streaming', '真实 WebRTC 未进入 streaming');
    evidence.streaming_observed = true;
    await until(() => (model.snapshot().stream?.getVideoTracks().length ?? 0) > 0, '没有真实视频 track');
    video.srcObject = model.snapshot().stream;
    await video.play();
    await until(() => video.videoWidth > 0 && video.videoHeight > 0 && video.getVideoPlaybackQuality().totalVideoFrames >= 30,
      '真实浏览器未持续解码至少 30 帧');
    const stats = await peers.at(-1).getStats();
    let decoded = 0;
    stats.forEach((item) => {
      if (item.type === 'inbound-rtp' && item.kind === 'video') decoded += Number(item.framesDecoded ?? 0);
    });
    if (decoded < 15) throw new Error('WebRTC 接收统计没有实际解码帧');
    evidence.video = { width: video.videoWidth, height: video.videoHeight,
      total_frames: video.getVideoPlaybackQuality().totalVideoFrames, frames_decoded: decoded };
    evidence.checks.push({ name: '真实 answer、streaming、视频 track 及持续解码', passed: true });
    const image = await fetch('/__recovery/capture?name=04-webrtc-decoded', { signal: AbortSignal.timeout(12000) });
    if (!image.ok) throw new Error('真实视频截图未保存');
    await image.json();
    const released = await model.release(AbortSignal.timeout(20000));
    evidence.release = { id: released.data.id, log_id: released.logId };
    const terminal = await until(async () => {
      const response = await fetch('/api/v2/sessions/' + session.id, { signal: AbortSignal.timeout(5000) });
      const body = await response.json();
      if (response.status === 404) return { status: 404, removed: true, log_id: body.log_id };
      if (response.status === 200 && body.data.status === 'finished') return {
        status: 200, removed: false, cleanup: body.data.completion?.cleanup,
        process_exited: body.data.completion?.process_exited, log_id: body.log_id,
      };
      return null;
    }, '释放后的真实服务端终态缺失');
    if (!terminal.removed && (terminal.cleanup !== 'complete' || terminal.process_exited !== true))
      throw new Error('释放后没有 Complete 与原进程退出');
    evidence.terminal = terminal;
    if (video.srcObject?.getTracks().some((track) => track.readyState !== 'ended'))
      throw new Error('释放后本地媒体轨道未停止');
    evidence.checks.push({ name: '真实 release 及本地轨道停止', passed: true });
    evidence.passed = true;
  } catch (error) {
    evidence.failure = { name: error.name, message: error.message };
  } finally {
    if (model && !evidence.passed) {
      try { await model.release(AbortSignal.timeout(15000)); } catch { /* 原始失败不被释放覆盖。 */ }
    }
    model?.dispose?.();
  }
  return evidence;
}
