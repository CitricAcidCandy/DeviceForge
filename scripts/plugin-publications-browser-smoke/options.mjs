// 只选择主代理冻结的输入，不构建、不复制共享产物。
import { join, resolve } from 'node:path';
import { browserSmokeOptions } from '../plugin-installations-browser-smoke/options.mjs';

export function publicationSmokeOptions(root, args, cwd = process.cwd(), platform = process.platform) {
  const shared = [], directories = {};
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    const name = ['--market-binary-directory', '--dist-directory'].find((flag) => value === flag || value.startsWith(`${flag}=`));
    if (!name) { shared.push(value); continue; }
    if (directories[name] !== undefined) throw new Error(`${name} 不得重复`);
    const directory = value === name ? args[++index] : value.slice(name.length + 1);
    if (!directory?.trim() || directory.startsWith('--')) throw new Error(`${name} 必须提供本轮冻结目录`);
    directories[name] = resolve(cwd, directory);
  }
  const options = browserSmokeOptions(root, shared, cwd, platform);
  const marketDirectory = directories['--market-binary-directory'] ?? options.marketDirectory;
  return {
    ...options, marketDirectory,
    marketBinary: join(marketDirectory, `deviceforge-resource-server${platform === 'win32' ? '.exe' : ''}`),
    dist: directories['--dist-directory'] ?? join(root, 'frontend', 'dist'),
  };
}
