// 第三方最小发布：服务器、浏览器与一个共享资源通过公开清单关联。
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { npmTgz } from '../../backend/scripts/online-plugins/fixtures.mjs';
import { packRelease, jsonBytes } from '../plugin-releases/pack.mjs';

export async function releaseFixture(
  root,
  {
    id = 'third_party_feature',
    version = '1.0.0',
    toolVersion = '1.0.0',
    toolBytes = '共享工具内容',
    broken = false,
    hold = false,
    cleanupFailed = false,
  } = {},
) {
  const directory = join(root, `${id}-${version}`);
  await mkdir(directory);
  const serverId = `${id}_server`,
    browserId = `${id}_browser`;
  const descriptor = (kind, entry) => ({
    name: `smoke-${id}-${kind}`,
    version,
    type: 'module',
    deviceforge: {
      kind,
      manifest: 'plugin.json',
      entrypoints: { any: { runtime: kind === 'server' ? 'node' : 'browser', path: entry } },
    },
  });
  const ordinaryScript = `import {readFileSync} from 'node:fs';
const request=JSON.parse(readFileSync(0,'utf8'));
if(request.operation==='hold') await new Promise(done=>setTimeout(done,1000));
const bindings=JSON.parse(readFileSync(process.env.DEVICEFORGE_PLUGIN_RESOURCES,'utf8'));
const values=JSON.parse(readFileSync(process.env.DEVICEFORGE_PLUGIN_CONFIG,'utf8'));
const result={version:${JSON.stringify(version)},value:readFileSync(bindings.tools.shared_helper.entries.main,'utf8'),configuration:values.setting,absolute:values.helper===bindings.tools.shared_helper.entries.main};
process.stdout.write(JSON.stringify({protocol_version:1,request_id:request.request_id,result}));`;
  // 协议三故意报告清理失败，验证宿主必须保留真实的资源保护状态。
  const script = cleanupFailed
    ? `import {readFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const input=createInterface({input:process.stdin});
input.once('line',line=>{
  const request=JSON.parse(line);
  const bindings=JSON.parse(readFileSync(process.env.DEVICEFORGE_PLUGIN_RESOURCES,'utf8'));
  const values=JSON.parse(readFileSync(process.env.DEVICEFORGE_PLUGIN_CONFIG,'utf8'));
  const result={version:${JSON.stringify(version)},value:readFileSync(bindings.tools.shared_helper.entries.main,'utf8'),configuration:values.setting,absolute:values.helper===bindings.tools.shared_helper.entries.main};
  process.stdout.write(JSON.stringify({response:{protocol_version:3,request_id:request.request_id,result},cleanup:request.operation==='unconfirmed'?'failed':'complete'}));
  input.close();process.stdin.destroy();
});`
    : ordinaryScript;
  const manifest = {
    id: serverId,
    version,
    protocol_version: cleanupFailed ? 3 : 1,
    args: [],
    operations: [
      {
        name: 'inspect',
        title: '读取托管工具与用户配置',
        input_schema: { type: 'object', additionalProperties: false },
      },
    ],
    configuration: {
      version: 1,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { helper: { type: 'string' }, setting: { type: 'string' } },
        required: ['helper', 'setting'],
      },
      defaults: { helper: '', setting: '初始配置' },
      apply_policy: 'next_invocation',
    },
  };
  if (hold)
    manifest.operations.push({
      name: 'hold',
      title: '占用资源以验证更新保护',
      input_schema: { type: 'object', additionalProperties: false },
    });
  if (cleanupFailed)
    manifest.operations.push({
      name: 'unconfirmed',
      title: '验证资源清理未确认保护',
      input_schema: { type: 'object', additionalProperties: false },
    });
  if (broken) manifest.operations.push(structuredClone(manifest.operations[0]));
  await writeFile(
    join(directory, 'server.tgz'),
    npmTgz([
      { path: 'package.json', bytes: JSON.stringify(descriptor('server', 'dist/index.mjs')) },
      { path: 'plugin.json', bytes: JSON.stringify(manifest) },
      { path: 'dist/index.mjs', bytes: script },
    ]),
  );
  await writeFile(
    join(directory, 'browser.tgz'),
    npmTgz([
      { path: 'package.json', bytes: JSON.stringify(descriptor('browser', 'dist/index.js')) },
      { path: 'plugin.json', bytes: JSON.stringify({ id: browserId, version, api_version: 2 }) },
      {
        path: 'dist/index.js',
        bytes: `export default {id:${JSON.stringify(browserId)},version:${JSON.stringify(version)},apiVersion:2};\n`,
      },
    ]),
  );
  await writeFile(join(directory, 'tool.bin'), toolBytes);
  const source = {
    format_version: 1,
    host_api_version: 2,
    id,
    version,
    name: '第三方完整功能',
    description: '验证安装器不依赖官方插件标识',
    components: [
      { id: serverId, kind: 'server', version, variants: [] },
      { id: browserId, kind: 'browser', version, variants: [] },
    ],
    tools: [
      {
        id: 'shared_helper',
        version: toolVersion,
        required: true,
        variants: [],
        bindings: [{ component_id: serverId, config_pointer: '/helper', entry: 'main' }],
      },
    ],
    requirements: [],
  };
  const inputs = {
    components: {
      [serverId]: { file: 'server.tgz', platform: 'any', format: 'tgz' },
      [browserId]: { file: 'browser.tgz', platform: 'any', format: 'tgz' },
    },
    tools: {
      shared_helper: {
        file: 'tool.bin',
        version: toolVersion,
        platform: 'any',
        format: 'file',
        entries: { main: 'payload' },
      },
    },
  };
  const market = {
    metadata_version: 1,
    id,
    kind: 'plugin',
    version,
    name: '第三方完整功能',
    summary: '真实安装验证',
    description: source.description,
    applies_to: ['DeviceForge'],
    supports_mcp: 'server',
    supports_agent: false,
    restart_policy: 'none',
    categories: ['function'],
  };
  await writeFile(join(directory, 'source.json'), jsonBytes(source));
  await writeFile(join(directory, 'inputs.json'), jsonBytes(inputs));
  await writeFile(join(directory, 'market.json'), jsonBytes(market));
  const output = join(directory, 'release');
  const packed = await packRelease({
    source: join(directory, 'source.json'),
    inputs: join(directory, 'inputs.json'),
    destination: output,
    platform: 'win32-x64',
  });
  return {
    id,
    version,
    serverId,
    browserId,
    directory: output,
    market: join(directory, 'market.json'),
    ...packed,
  };
}
