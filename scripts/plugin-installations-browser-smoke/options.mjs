// 构建模式只选择现有文件；本脚本不会构建、部署或连接用户服务。
import { join, resolve } from 'node:path';

export function browserSmokeOptions(root, args, cwd = process.cwd(), platform = process.platform) {
  let release = false, binaryDirectory;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--release') {
      if (release) throw new Error('--release 不得重复');
      release = true;
    } else if (value === '--binary-directory' || value.startsWith('--binary-directory=')) {
      if (binaryDirectory !== undefined) throw new Error('--binary-directory 不得重复');
      binaryDirectory = value === '--binary-directory' ? args[++index] : value.slice('--binary-directory='.length);
      if (!binaryDirectory?.trim() || binaryDirectory.startsWith('--'))
        throw new Error('--binary-directory 必须提供本轮宿主二进制目录');
    } else throw new Error(`未知参数：${value}`);
  }
  const profile = release ? 'release' : 'debug';
  const hostDirectory = binaryDirectory === undefined
    ? join(root, 'backend', 'target', profile) : resolve(cwd, binaryDirectory);
  const marketDirectory = join(root, 'resource-server', 'target', profile);
  const suffix = platform === 'win32' ? '.exe' : '';
  return {
    profile,
    binaryDirectory: hostDirectory,
    marketDirectory,
    binary: join(hostDirectory, `apk-server${suffix}`),
    marketBinary: join(marketDirectory, `deviceforge-resource-server${suffix}`),
  };
}
