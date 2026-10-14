export interface NativeFrameObservation {readonly width: number; readonly height: number; readonly timestamp: number; closed: boolean}
export interface NativeAudioObservation {
  readonly node: AudioBufferSourceNode;
  starts: number; stops: number; disconnects: number; destinationConnections: number;
  left: readonly number[]; right: readonly number[];
}

// 观测包装仍调用原生构造器与原生方法；没有替换解码输出或音频处理结果。
export function observeNativeMedia() {
  const NativeDecoder = VideoDecoder; const NativeAudioContext = AudioContext;
  const frames: NativeFrameObservation[] = []; const decoders: VideoDecoder[] = [];
  const contexts: AudioContext[] = []; const sources: NativeAudioObservation[] = [];
  const analysers: AnalyserNode[] = []; const mutedBranches: GainNode[] = []; const errors: string[] = [];
  let peak = 0;
  const sampler = setInterval(() => {for (const analyser of analysers) {const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples); for (const value of samples) peak = Math.max(peak, Math.abs(value));}}, 5);
  class ObservedDecoder extends NativeDecoder {
    constructor(init: VideoDecoderInit) {
      super({error(error) {errors.push(error.message); init.error(error);}, output(frame) {
        const observation = {width: frame.displayWidth, height: frame.displayHeight, timestamp: frame.timestamp, closed: false}; frames.push(observation);
        try {init.output(frame);} finally {observation.closed = frame.format === null;}
      }}); decoders.push(this);
    }
  }
  class ObservedAudioContext extends NativeAudioContext {
    private readonly analyser: AnalyserNode;
    constructor(options?: AudioContextOptions) {
      super(options); contexts.push(this);
      this.analyser = super.createAnalyser(); this.analyser.fftSize = 2048; analysers.push(this.analyser);
      const gain = super.createGain(); gain.gain.value = 0; this.analyser.connect(gain); gain.connect(this.destination); mutedBranches.push(gain);
    }
    override createBufferSource(): AudioBufferSourceNode {
      const node = super.createBufferSource(); node.connect(this.analyser);
      const observed: NativeAudioObservation = {node, starts: 0, stops: 0, disconnects: 0, destinationConnections: 0, left: [], right: []}; sources.push(observed);
      const start = node.start.bind(node); const stop = node.stop.bind(node); const disconnect = node.disconnect.bind(node);
      const connect = node.connect.bind(node); const destination = this.destination;
      function observedConnect(target: AudioNode, output?: number, input?: number): AudioNode;
      function observedConnect(target: AudioParam, output?: number): void;
      function observedConnect(target: AudioNode | AudioParam, output = 0, input = 0): AudioNode | void {
        if (target instanceof AudioParam) {connect(target, output); return;}
        const connected = connect(target, output, input); if (target === destination) observed.destinationConnections++; return connected;
      }
      node.connect = observedConnect;
      node.start = (when = 0, offset = 0, duration?: number) => {
        observed.starts++; observed.left = node.buffer ? [...node.buffer.getChannelData(0).slice(0, 8)] : []; observed.right = node.buffer && node.buffer.numberOfChannels > 1 ? [...node.buffer.getChannelData(1).slice(0, 8)] : [];
        if (duration === undefined) start(when, offset); else start(when, offset, duration);
      };
      node.stop = (when = 0) => {observed.stops++; stop(when);};
      node.disconnect = () => {observed.disconnects++; disconnect();};
      return node;
    }
  }
  globalThis.VideoDecoder = ObservedDecoder; globalThis.AudioContext = ObservedAudioContext;
  return {frames, decoders, contexts, sources, errors,
    peak: () => peak,
    restore() {clearInterval(sampler); globalThis.VideoDecoder = NativeDecoder; globalThis.AudioContext = NativeAudioContext; for (const analyser of analysers) analyser.disconnect(); for (const gain of mutedBranches) gain.disconnect();},
  };
}
