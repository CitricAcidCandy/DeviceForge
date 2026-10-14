import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { npmCommand } from '../cli/src/processes.mjs';

export async function packFixture(temporary) {
  const root = join(temporary, 'fixture');
  await mkdir(join(root, 'node_modules/sample-helper'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'test-deviceforge-npx-plugin',
      version: '1.0.0',
      type: 'module',
      dependencies: { 'sample-helper': '1.0.0' },
      bundleDependencies: ['sample-helper'],
      scripts: { postinstall: 'node postinstall.mjs' },
      deviceforge: {
        kind: 'server',
        manifest: 'plugin.json',
        entrypoints: { any: { runtime: 'node', path: 'entry.mjs' } },
      },
    }),
  );
  await writeFile(
    join(root, 'postinstall.mjs'),
    'import {writeFileSync} from "node:fs"; writeFileSync("INSTALL_SCRIPT_RAN","不应运行");',
  );
  await writeFile(
    join(root, 'node_modules/sample-helper/package.json'),
    JSON.stringify({ name: 'sample-helper', version: '1.0.0', main: 'index.js' }),
  );
  await writeFile(
    join(root, 'node_modules/sample-helper/index.js'),
    'exports.message = "npm 包依赖可用";',
  );
  await writeFile(
    join(root, 'entry.mjs'),
    `import {message} from 'sample-helper';
import {readFileSync} from 'node:fs';
// 插件使用公开 JSON 协议，并验证宿主没有传入访问令牌。
if (process.env.APK_API_TOKEN) process.exit(1);
const request = JSON.parse(readFileSync(0,'utf8'));
process.stdout.write(JSON.stringify({protocol_version:request.protocol_version,request_id:request.request_id,result:{message,input:request.input}}));
`,
  );
  await writeFile(
    join(root, 'plugin.json'),
    JSON.stringify({
      id: 'npx_demo',
      version: '1.0.0',
      protocol_version: 1,
      args: [],
      operations: [
        {
          name: 'echo',
          title: 'npm 安装验证',
          input_schema: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
            additionalProperties: false,
          },
        },
      ],
    }),
  );
  const npm = npmCommand();
  const result = await promisify(execFile)(
    npm.command,
    [...npm.prefix, 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary],
    { cwd: root, windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  return join(temporary, JSON.parse(result.stdout)[0].filename);
}
