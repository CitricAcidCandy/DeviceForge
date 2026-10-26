// 独立协议原帧夹具；逐次明确报告清理状态，不派生后台进程或执行 shell。
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [root] = process.argv.slice(2);
const lines = createInterface({ input: process.stdin });
let request;
let finished = false;

const finish = () => {
  if (finished) throw Error('本次调用不得重复结束');
  finished = true;
  writeFileSync(join(root, `${request.input.name}.json`), JSON.stringify({
    pid: process.pid,
    request_id: request.request_id,
    protocol_version: request.protocol_version,
    directory: process.cwd(),
  }));
  process.stdout.write(`${JSON.stringify({
    response: {
      protocol_version: request.protocol_version,
      request_id: request.request_id,
      result: request.operation === 'runtime.recover' ? {
        coverage: 'plugin', inspected: 1, remaining: 0, status: 'recovered',
        message: '旧资源核对完成',
        checks: [{ resource: 'old-call', status: 'confirmed', message: '旧调用已释放' }],
      } : { pid: process.pid, input: request.input },
      outputs: [],
    },
    cleanup: request.input.cleanup ?? 'complete',
  })}\n`);
};

lines.on('line', (line) => {
  const frame = JSON.parse(line);
  if (!request) {
    if (![3, 4].includes(frame.protocol_version)) throw Error('夹具只接受协议 3/4');
    request = frame;
    if (request.protocol_version === 3) {
      finish();
    } else {
      process.stdout.write(`${JSON.stringify({
        protocol_version: 4, request_id: request.request_id, command: 'ready',
      })}\n`);
    }
    return;
  }
  if (frame.protocol_version !== 4 || frame.command !== 'start'
    || frame.request_id !== request.request_id || frame.remaining_timeout_ns <= 0) {
    throw Error('本次 Start 关联或剩余预算无效');
  }
  finish();
});

// 收到响应后宿主关闭输入；等待输出排空再退出，让宿主核对真实零退出。
lines.on('close', () => process.stdout.end(() => process.exit(0)));
