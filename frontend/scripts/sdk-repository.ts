import { isAbsolute, resolve } from 'node:path';

/** SDK只在独立仓库维护；环境变量用于显式选择另一份独立检出。 */
export function sdkRepositoryRoot(frontendRoot: string): string {
  const configured = process.env['DEVICEFORGE_SDK_ROOT'];
  if (configured) {
    if (!isAbsolute(configured)) throw new Error('DEVICEFORGE_SDK_ROOT必须是独立SDK仓库的绝对路径');
    return resolve(configured);
  }
  return resolve(frontendRoot, '../../DeviceForge-SDK');
}

export function sdkBrowserPackage(frontendRoot: string, name: 'sdk' | 'tools' | 'contracts'): string {
  return resolve(sdkRepositoryRoot(frontendRoot), 'browser', name);
}
