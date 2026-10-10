import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

// 在线模拟包通过宿主授权输出目录发布真实文件，不用业务 JSON 自填产物 ID。
const config = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let request;
const record = (kind) => appendFileSync(join(config.directory, 'events.jsonl'), `${JSON.stringify({
  kind, pid: process.pid, at: Date.now(), request_id: request.request_id,
  operation: request.operation, label: request.input.label,
})}\n`, 'utf8');
lines.on('line', (line) => {
  if (request) throw new Error('短产物调用不接受额外请求');
  request = JSON.parse(line);
  if (![2, 3].includes(request.protocol_version) || !request.artifacts?.output_directory) {
    throw new Error('产物夹具要求公开输出授权');
  }
  record('started');
  writeFileSync(join(request.artifacts.output_directory, 'result.json'), '{"published":"真实宿主产物"}\n', 'utf8');
  const response = { protocol_version: request.protocol_version, request_id: request.request_id,
    result: { artifacts: [{ id: 'forged-business-id', filename: 'result.json' }] }, outputs: [{ filename: 'result.json' }] };
  record('cleaned');
  const frame = request.protocol_version === 3 ? { response, cleanup: 'complete' } : response;
  process.stdout.write(`${JSON.stringify(frame)}\n`, () => record('response_written'));
});
process.stdin.on('end', () => { if (request) record('stdin_eof'); });
process.on('exit', () => { if (request) record('process_exit'); });
