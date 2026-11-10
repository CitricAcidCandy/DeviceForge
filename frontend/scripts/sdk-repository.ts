import { readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep, isAbsolute } from 'node:path';

const names = { sdk: '@deviceforge/plugin-sdk', tools: '@deviceforge/plugin-tools', contracts: '@deviceforge/contracts' } as const;

/** 宿主只消费正常安装的公开发行包；不寻找同级SDK检出，也不读取旧源码环境变量。 */
export function sdkBrowserPackage(frontendRoot: string, name: 'sdk' | 'tools' | 'contracts'): string {
  const packageName = names[name];
  const modules = resolve(frontendRoot, 'node_modules');
  let root: string;
  let metadata: unknown;
  try {
    root = realpathSync(join(modules, packageName));
    metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch (cause) {
    throw new Error(`未找到已安装的公开包 ${packageName}，请先在前端执行 npm install`, { cause });
  }
  const part = relative(realpathSync(modules), root);
  if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part))
    throw new Error(`已安装公开包 ${packageName} 不能链接到前端 node_modules 之外的源码`);
  if (!metadata || typeof metadata !== 'object' || !('name' in metadata) || metadata.name !== packageName)
    throw new Error(`已安装公开包身份不一致：${packageName}`);
  return root;
}
