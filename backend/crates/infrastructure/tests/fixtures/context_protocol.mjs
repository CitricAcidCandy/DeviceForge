// 独立原帧夹具：不调用SDK，不用宿主实现生成期望值。
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
const [marker, mode] = process.argv.slice(2);
// 输入尚未读取时先等待有限启动日志排空，能复现首次双管道互等。
if (mode === 'stderr-first' && !process.stderr.write('x'.repeat(256 * 1024))) {
  await once(process.stderr, 'drain');
}
const lines = createInterface({ input: process.stdin });
let request;
let start;
let readySent = false;
const reply = (value, error = null, outputs = []) => {
  process.stdout.write(`${JSON.stringify({ response: {
    protocol_version: 4, request_id: request.request_id,
    ...(error === null ? { result: value } : { error }),
    outputs,
  }, cleanup: 'complete' })}\n`);
};
lines.on('line', async (line) => {
  const frame = JSON.parse(line);
  if (!request) {
    request = frame;
    writeFileSync(`${marker}.spawn`, JSON.stringify({ pid: process.pid }));
    if (mode === 'bad-ready') {
      process.stdout.write(`${JSON.stringify({ protocol_version: 4, request_id: 'wrong', command: 'ready' })}\n`);
      return;
    }
    // 主动占满一部分错误管道，验证握手期间并发读取不会形成死锁。
    if (mode === 'stderr-ready') process.stderr.write('x'.repeat(256 * 1024));
    const ready = JSON.stringify({ protocol_version: 4, request_id: request.request_id, command: 'ready' }) + '\n';
    if (mode === 'hold-ready' || mode === 'split-ready') {
      const split = mode === 'split-ready' ? Math.floor(ready.length / 2) : 0;
      if (split) process.stdout.write(ready.slice(0, split));
      await new Promise(resolve => {
        const timer = setInterval(() => {
          if (existsSync(marker + '.release')) { clearInterval(timer); resolve(); }
        }, 10);
      });
      process.stdout.write(ready.slice(split));
    } else if (mode === 'no-ready') {
      return;
    } else {
      process.stdout.write(ready);
    }
    readySent = true;
    return;
  }
  if (!start) {
    if (frame.command === 'cancel') {
      if (!readySent || frame.protocol_version !== 4 || frame.request_id !== request.request_id
        || !['cancelled', 'timeout', 'transport_failure'].includes(frame.reason)) throw Error('启动取消不匹配');
      writeFileSync(marker + '.control', JSON.stringify({ ...frame, pid: process.pid, handler_calls: 0 }));
      reply(null, '启动前按控制要求完成清理');
      return;
    }
    if (frame.protocol_version !== 4 || frame.request_id !== request.request_id || frame.command !== 'start') throw Error('Start不匹配');
    start = frame;
    writeFileSync(marker, JSON.stringify({ pid: process.pid, start, request }));
    if (mode === 'normal' || mode === 'stderr-ready' || mode === 'stderr-first') reply({ remaining_timeout_ns: start.remaining_timeout_ns, input: request.input });
    if (mode === 'outputs') reply({ sample: true }, null, [{ filename: 'unexpected.png' }]);
    if (mode === 'error-outputs') reply(null, '夹具采样失败', [{ filename: 'unexpected.png' }]);
    return;
  }
  if (frame.protocol_version !== 4 || frame.request_id !== request.request_id || frame.command !== 'cancel') throw Error('控制帧不匹配');
  writeFileSync(`${marker}.control`, JSON.stringify(frame));
  reply(null, '按控制要求完成本次清理');
});
lines.on('close', () => process.exit(0));
