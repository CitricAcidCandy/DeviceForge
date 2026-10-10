import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

// 入口只读写本次独立部署目录；观测均为夹具，不连接 ADB/HDC 或硬件。
const counter = new URL('../counter.json', import.meta.url);
const settings = new URL('../settings.json', import.meta.url);
const events = new URL('../events.jsonl', import.meta.url);
let request;
const record = (kind, extra = {}) => appendFileSync(events, `${JSON.stringify({ kind, at: Date.now(),
  pid: process.pid, request_id: request?.request_id, operation: request?.operation, ...extra })}\n`, 'utf8');
process.on('exit', (code) => { if (request) record('exit', { code }); });

function execute() {
  if (request.protocol_version !== 2 || typeof request.request_id !== 'string' || process.env.APK_API_TOKEN) {
    throw new Error('夹具仅接受无令牌的公开协议 2');
  }
  record('started');
  if (request.operation === 'discover') {
    if (!request.input || Array.isArray(request.input) || Object.keys(request.input).length) throw new Error('发现只接受空对象');
    const revision = existsSync(counter) ? JSON.parse(readFileSync(counter, 'utf8')).revision + 1 : 1;
    writeFileSync(counter, JSON.stringify({ revision }), 'utf8');
    const mode = existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')).mode : 'raw';
    record('observation', { revision, mode });
    const samples = [['online', 'online', 'device'], ['recovery', 'unknown', 'recovery'],
      ['sideload', 'unknown', 'sideload'], ['bootloader', 'unknown', 'bootloader'],
      ['unknown', 'unknown', ' MixedCase 未知 '], ['offline', 'offline', 'offline'],
      ['unauthorized', 'unauthorized', 'unauthorized'], ['none', 'unknown', null]];
    return samples.map(([id, state, raw]) => ({ id, state, model: `模拟观测-${revision}`,
      ...(mode === 'raw' && raw !== null ? { raw_state: raw } : {}),
      capabilities: [{ id: 'device.echo', version: 1, available: true }],
    }));
  }
  const input = request.input;
  if (!input || typeof input.input !== 'object' || input.input === null) throw new Error('需要标准设备动作输入');
  if (request.operation === 'configure' && input.device_id === null && ['raw', 'none'].includes(input.input.mode)) {
    writeFileSync(settings, JSON.stringify({ mode: input.input.mode }), 'utf8');
    return { mode: input.input.mode, synthetic: true };
  }
  if (request.operation === 'echo' && input.device_id === 'online') return { synthetic: true, value: input.input };
  throw new Error('夹具动作或设备不存在');
}

try {
  const bytes = readFileSync(0); if (bytes.length > 65536) throw new Error('夹具请求超限');
  request = JSON.parse(bytes.toString('utf8'));
  const result = execute();
  record('response');
  process.stdout.write(`${JSON.stringify({ protocol_version: 2, request_id: request.request_id, result })}\n`);
} catch {
  // 不回显请求或任意输入；失败由进程退出及真实宿主日志关联定位。
  process.exitCode = 1;
}
