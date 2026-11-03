import type { ServerOptions } from 'vite';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** 开发监听策略与业务装载分离，发行目录不属于源码热更新输入。 */
export function developmentWatch(frontendRoot: string): NonNullable<ServerOptions['watch']> {
  const artifacts = resolve(frontendRoot, 'artifacts');
  return {
    ignored(path: string) {
      const child = relative(artifacts, resolve(frontendRoot, path));
      return child === '' || child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
    },
  };
}
