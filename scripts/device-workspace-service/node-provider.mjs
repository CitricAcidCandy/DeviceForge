import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

// 自包含协议 3 夹具，只读写自己的状态文件，不派生任何平台工具。
const config = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let request;
let replied = false;
const record = (kind) => {
  appendFileSync(
    join(config.directory, 'events.jsonl'),
    `${JSON.stringify({ kind, pid: process.pid, at: Date.now(), operation: request?.operation, request_id: request?.request_id })}\n`,
    'utf8',
  );
};
const device = (id, state, model) => ({
  id,
  state,
  raw_state: state === 'online' ? 'device' : state,
  model,
  capabilities: [
    {
      id: 'packages',
      version: 1,
      available: state === 'online',
      reason: state === 'online' ? null : '受控设备当前不可操作',
    },
  ],
});

lines.on('line', (line) => {
  try {
    const frame = JSON.parse(line);
    if (request) {
      if (frame.request_id !== request.request_id || frame.command !== 'cancel')
        throw new Error('受控夹具拒绝未知控制帧');
      record('cancel_received');
      return;
    }
    request = frame;
    if (
      request.protocol_version !== 3 ||
      typeof request.request_id !== 'string' ||
      process.env.APK_API_TOKEN
    )
      throw new Error('受控夹具要求公开协议 3 且不继承访问令牌');
    record('started');
    const connectionPath = join(config.directory, 'connection.json');
    const current = JSON.parse(readFileSync(connectionPath, 'utf8'));
    let result;
    if (request.operation === 'discover') {
      result = [
        device('fixture-usb-online', 'online', '受控模拟设备 · 在线'),
        device('fixture-offline', 'offline', '受控模拟设备 · 离线'),
        device('fixture-unauthorized', 'unauthorized', '受控模拟设备 · 待授权'),
        ...(current ? [device(current, 'online', '受控模拟网络设备')] : []),
      ];
    } else if (request.operation === 'packages') {
      result = {
        output: 'package:org.deviceforge.fixture\npackage:org.deviceforge.second\n',
        synthetic_device: true,
      };
    } else if (request.operation === 'connect' || request.operation === 'disconnect') {
      // 地址值固定在夹具命名空间，防止测试误操作真实目标。
      if (
        request.input?.device_id !== null ||
        request.input?.input?.address !== 'fixture.invalid:5555'
      )
        throw new Error('受控连接仅接受 fixture.invalid:5555');
      writeFileSync(
        connectionPath,
        JSON.stringify(request.operation === 'connect' ? 'fixture.invalid:5555' : null),
        'utf8',
      );
      result = {
        address: 'fixture.invalid:5555',
        connected: request.operation === 'connect',
        synthetic_device: true,
      };
    } else {
      throw new Error('受控夹具拒绝未声明操作');
    }
    record('cleaned');
    replied = true;
    process.stdout.write(
      `${JSON.stringify({ response: { protocol_version: 3, request_id: request.request_id, result }, cleanup: 'complete' })}\n`,
      () => record('response_written'),
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    lines.close();
    process.stdin.destroy();
  }
});
process.stdin.on('end', () => record('stdin_eof'));
process.on('exit', () => record('process_exit'));
lines.on('close', () => {
  record('readline_closed');
  if (!replied && request) process.exitCode = 1;
});
