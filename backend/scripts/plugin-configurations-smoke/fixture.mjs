// 受控协议 1 插件，只读取固定启动参数和本次调用的管理配置快照。
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';

const argument = (name) => process.argv[process.argv.indexOf(name) + 1];
const input = createInterface({ input: process.stdin });
input.once('line', async (line) => {
  const request = JSON.parse(line);
  input.close();
  const path = process.env.DEVICEFORGE_PLUGIN_CONFIG || argument('--config');
  const configuration = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(argument('--marker'), request.request_id);
  await new Promise((done) => setTimeout(done, request.input.delay_ms || 0));
  process.stdout.write(JSON.stringify({
    protocol_version: request.protocol_version,
    request_id: request.request_id,
    result: {
      count: configuration.count,
      managed: Boolean(process.env.DEVICEFORGE_PLUGIN_CONFIG),
      revision_file: process.env.DEVICEFORGE_PLUGIN_CONFIG ? basename(path) : null,
    },
  }) + '\n');
});
