import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

// 该文件作为自包含在线 TGZ 的入口执行；路径只来自测试管理员生成的配置。
const config = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let request;
let label;
let cancelled = false;
let replyStarted = false;
let stdinClosed = false;
let notifyCancel;
const cancellation = new Promise((done) => { notifyCancel = done; });
const record = (kind) => appendFileSync(join(config.directory, 'events.jsonl'), `${JSON.stringify({
  kind, at: Date.now(), pid: process.pid, provider_id: config.id, request_id: request.request_id,
  operation: request.operation, device_id: request.input?.device_id ?? null, label })}\n`, 'utf8');

function cancel() {
  if (!request || replyStarted || cancelled) return;
  cancelled = true;
  record('cancel_received');
  notifyCancel();
}

async function wait(milliseconds, gate) {
  const deadline = Date.now() + milliseconds;
  while (!cancelled && (gate ? !existsSync(join(config.directory, `${label}.release`)) : Date.now() < deadline)) {
    if (gate && Date.now() >= deadline) throw new Error('夹具门闩未在有限期限内解除');
    await Promise.race([delay(25), cancellation]);
  }
}

async function execute() {
  if (request.protocol_version !== 3 || typeof request.request_id !== 'string' || process.env.APK_API_TOKEN) {
    throw new Error('夹具要求公开协议 3，且不得继承令牌');
  }
  const discovery = request.operation === 'discover';
  const control = JSON.parse(readFileSync(join(config.directory, 'control.json'), 'utf8'));
  const input = discovery ? {} : request.input.input;
  label = discovery ? control.label : input.label;
  if (!/^[a-z0-9_-]{1,80}$/.test(label)) throw new Error('夹具标签必须是受控简单名称');
  record('started');
  await wait(input.duration_ms ?? (discovery && control.mode === 'blocked' ? 12000 : 25),
    input.gate === true || (discovery && control.mode === 'blocked'));
  const availability = [{ id: 'device_read', version: 1, available: true },
    { id: 'device_write', version: 1, available: true },
    { id: 'disabled', version: 1, available: false, reason: '夹具明确不可用' }];
  let result = discovery ? [config.localId, config.otherId, config.offlineId].map((id) => ({ id,
    state: id === config.offlineId ? 'offline' : 'online', model: '第三方模拟设备', capabilities: availability }))
    : { provider_id: config.id, device_id: request.input.device_id, operation: request.operation, label, synthetic_device: true };
  if (discovery && control.mode === 'duplicate') result = [result[0], result[0]];
  if (discovery && control.mode === 'bad-state') result[0].state = '不属于公开枚举';
  if (discovery && control.mode === 'undeclared-capability') result[0].capabilities = [{ id: 'undeclared', version: 1, available: true }];
  // 模拟资源只包括本次计时器与输入流，不能作为真机恢复或外部连接清理证据。
  await delay(40);
  record('cleaned');
  const response = { protocol_version: 3, request_id: request.request_id,
    ...(cancelled ? { error: '夹具已完成合作取消' } : { result }) };
  replyStarted = true;
  await new Promise((done, reject) => process.stdout.write(`${JSON.stringify({ response, cleanup: 'complete' })}\n`,
    (error) => error ? reject(error) : done()));
  record('response_written');
  // 故意等待宿主关闭输入再退出，覆盖取消响应后的 EOF 通知契约。
  if (stdinClosed) lines.close();
}

lines.on('line', (line) => {
  try {
    const frame = JSON.parse(line);
    if (!request) {
      request = frame;
      execute().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1; lines.close(); process.stdin.destroy();
      });
    } else {
      if (frame.protocol_version !== 3 || frame.request_id !== request.request_id || frame.command !== 'cancel') {
        throw new Error('夹具收到不匹配控制帧');
      }
      cancel();
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1; cancel(); lines.close(); process.stdin.destroy();
  }
});
process.stdin.on('end', () => { if (request) record('stdin_eof'); });
process.on('exit', () => { if (request && label) record('process_exit'); });
lines.on('close', () => { stdinClosed = true; if (request && label) record('readline_closed'); cancel(); });
