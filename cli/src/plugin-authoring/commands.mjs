// 开发工具参数独立于服务启动和安装参数。
import { resolve } from 'node:path';

export function parseAuthoringOptions(args) {
  if (args[0] !== 'plugin' || !['pack', 'plan', 'publish'].includes(args[1])) return null;
  const action = args[1], rest = args.slice(2), options = { command: `plugin.${action}` };
  if (action === 'pack') options.source = rest[0] && !rest[0].startsWith('--') ? rest.shift() : 'manifest.json';
  else {
    if (!rest[0] || rest[0].startsWith('-')) throw new Error('发布要求已有打包输出目录');
    options.directory = resolve(rest.shift());
  }
  const allowed = action === 'pack' ? ['--out', '--platform'] : ['--server'];
  const seen = new Set();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index], value = rest[index + 1];
    if (!allowed.includes(key) || seen.has(key) || !value || value.startsWith('-')) throw new Error('开发工具参数无效、重复或缺少值');
    seen.add(key);
    options[{ '--out': 'destination', '--platform': 'platform', '--server': 'server' }[key]] = value;
  }
  if (action !== 'pack' && !options.server) throw new Error('发布要求 --server 资源服务地址');
  return options;
}

export async function runAuthoring(options, { signal, transport = fetch } = {}) {
  if (options.command === 'plugin.pack') {
    const { packPlugin } = await import('./pack.mjs');
    return packPlugin(options, { signal });
  }
  const { planPublication, publishRelease } = await import('../../../scripts/plugin-releases/publish.mjs');
  const plan = await planPublication(options);
  if (options.command !== 'plugin.publish') return plan.summary;
  const response = await transport(new URL('/api/v1/capabilities', plan.base), {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), redirect: 'error',
  });
  if (!response.ok) throw new Error('资源服务不支持发布能力查询，请升级后重试；尚未上传');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 65536) throw new Error('资源服务能力响应过大；尚未上传');
  const capabilities = JSON.parse(new TextDecoder().decode(bytes));
  const release = capabilities.release_publication;
  if (capabilities.api_version !== 1 || !release?.format_versions?.includes(plan.manifest.format_version) ||
      !release.host_api_versions?.includes(2) || !release.catalog_last || !release.immutable_versions ||
      !Number.isSafeInteger(release.resource_max_bytes) ||
      [...plan.resources.map((item) => item.size), plan.bytes.length].some((size) => size > release.resource_max_bytes))
    throw new Error('资源服务发布能力或大小限制不兼容；尚未上传');
  return publishRelease(plan, { signal, transport });
}
