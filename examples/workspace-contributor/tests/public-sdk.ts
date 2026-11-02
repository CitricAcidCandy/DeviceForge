import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { registerHooks } from 'node:module';

/** 单元只加载随工程交付的真实 SDK TGZ，不通过宿主源码或仓库别名解析。 */
const bytes = gunzipSync(readFileSync(new URL('../vendor/deviceforge-plugin-sdk-0.1.0.tgz', import.meta.url)));
const files = new Map<string, string>();
const decoder = new TextDecoder('utf-8', { fatal: true });
for (let cursor = 0; cursor + 512 <= bytes.length;) {
  const header = bytes.subarray(cursor, cursor + 512);
  const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/s, '');
  if (!name) break;
  const size = Number.parseInt(decoder.decode(header.subarray(124, 136)).replace(/\0.*$/s, '').trim(), 8);
  if (!Number.isSafeInteger(size) || size < 0 || cursor + 512 + size > bytes.length)
    throw new Error('随附 SDK 归档结构无效');
  if (name.startsWith('package/lib/') && name.endsWith('.js'))
    files.set(name.slice('package/'.length), decoder.decode(bytes.subarray(cursor + 512, cursor + 512 + size)));
  cursor += 512 + Math.ceil(size / 512) * 512;
}
if (!files.has('lib/index.js')) throw new Error('随附 SDK 不含真实 ESM 入口');
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@deviceforge/plugin-sdk')
      return { url: 'deviceforge-example-sdk:///lib/index.js', shortCircuit: true };
    if (specifier === '@deviceforge/plugin-sdk/json')
      return { url: 'deviceforge-example-sdk:///lib/json.js', shortCircuit: true };
    if (context.parentURL?.startsWith('deviceforge-example-sdk:') && specifier.startsWith('.'))
      return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.startsWith('deviceforge-example-sdk:')) return next(url, context);
    const source = files.get(new URL(url).pathname.slice(1));
    if (source === undefined) throw new Error('随附 SDK 缺少引用的真实模块');
    return { format: 'module', source, shortCircuit: true };
  },
});
