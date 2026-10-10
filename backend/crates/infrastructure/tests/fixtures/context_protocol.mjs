// 独立原帧夹具：不调用SDK，不用宿主实现生成期望值。
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { once } from 'node:events';
const [marker, mode] = process.argv.slice(2);
// 输入尚未读取时先等待有限启动日志排空，能复现首次双管道互等。
if (mode === 'stderr-first' && !process.stderr.write('x'.repeat(256 * 1024))) {
  await once(process.stderr, 'drain');
}
const lines = createInterface({ input: process.stdin });
let request;
let start;
const reply = (value, error = null) => {
  process.stdout.write(`${JSON.stringify({ response: {
    protocol_version: 4, request_id: request.request_id,
    ...(error === null ? { result: value } : { error }),
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
    process.stdout.write(`${JSON.stringify({ protocol_version: 4, request_id: request.request_id, command: 'ready' })}\n`);
    return;
  }
  if (!start) {
    if (frame.protocol_version !== 4 || frame.request_id !== request.request_id || frame.command !== 'start') throw Error('Start不匹配');
    start = frame;
    writeFileSync(marker, JSON.stringify({ pid: process.pid, start, request }));
    if (mode === 'normal' || mode === 'stderr-ready' || mode === 'stderr-first') reply({ remaining_timeout_ns: start.remaining_timeout_ns, input: request.input });
    return;
  }
  if (frame.protocol_version !== 4 || frame.request_id !== request.request_id || frame.command !== 'cancel') throw Error('控制帧不匹配');
  writeFileSync(`${marker}.control`, JSON.stringify(frame));
  reply(null, '按控制要求完成本次清理');
});
lines.on('close', () => process.exit(0));
