// 初始安装调用同一宿主用例；不在 Node 中实现第二套发现、下载或共享仓库。
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnManaged, stopManaged } from './processes.mjs';

export async function prepareDependencies(resources, options, pluginDirectory, id, environment, signal) {
  if (!resources.dependencyPreparation) return null;
  signal?.throwIfAborted();
  await mkdir(resolve(options.dataDirectory), { recursive: true });
  const user = resolve(environment.DEVICEFORGE_USER_DIR || join(homedir(), '.deviceforge'));
  const output = [];
  let size = 0, rejected = false;
  const process = spawnManaged(resources.binary, ['--prepare-plugin-dependencies', 'server', id], {
    cwd: resolve(options.dataDirectory), stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...environment, APK_DATA_DIR: resolve(options.dataDirectory), APK_PLUGIN_DIR: pluginDirectory,
      APK_BROWSER_PLUGIN_DIR: resolve(environment.APK_BROWSER_PLUGIN_DIR || join(options.dataDirectory, 'browser-plugins')),
      DEVICEFORGE_USER_DIR: user },
  });
  process.child.stdin.on('error', () => {});
  const cancel = () => {
    if (rejected) return;
    rejected = true;
    void stopManaged(process);
  };
  process.child.stdout.on('data', (bytes) => {
    size += bytes.length;
    if (size > 256 * 1024) cancel();
    else output.push(bytes);
  });
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(cancel, 3_600_000);
  try {
    const result = await process.closed;
    if (result.failure || result.code !== 0 || rejected) throw new Error('依赖准备未完成');
  } catch {
    throw new Error('插件文件已部署，但依赖准备失败；原工具和配置保留，请在插件管理页查询缺项并重试');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    await stopManaged(process);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(output).toString('utf8')); } catch { throw new Error('插件已部署，宿主依赖准备结果无效'); }
  if (value?.target?.id !== id || value.target.kind !== 'server' || typeof value.ready !== 'boolean'
      || !/^[a-f0-9]{64}$/.test(value.revision) || !Array.isArray(value.dependencies))
    throw new Error('插件已部署，宿主依赖准备身份或修订无效');
  return value;
}
