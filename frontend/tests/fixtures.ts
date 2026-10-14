import type { JobDto, PackageInfo, PackageKind, PluginInfo } from '../src/services/api/index.ts';

export function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {
    throw new Error('承诺尚未初始化');
  };
  let reject: (error: unknown) => void = () => {
    throw new Error('承诺尚未初始化');
  };
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export function success(data: unknown, logId = 'log-test', status = 200): Response {
  return Response.json(
    { log_id: logId, data },
    { status, headers: { 'x-deviceforge-log-id': logId } },
  );
}
export function failure(code: string, status = 409): Response {
  return Response.json(
    { log_id: 'log-error', error: { code, message: '公开错误' } },
    { status, headers: { 'x-deviceforge-log-id': 'log-error' } },
  );
}
export function job(id = 'job-test'): JobDto {
  return { id, operation: 'example.run', input: {}, created_at: 1, status: 'queued' };
}
export function plugin(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: 'example',
    generation: 'generation-1',
    version: '1.0',
    operations: ['example.run'],
    protected: false,
    state: 'loaded',
    cleanup_failed: false,
    ...overrides,
  };
}
export function installedPackage(
  kind: PackageKind = 'browser',
  overrides: Partial<PackageInfo> = {},
): PackageInfo {
  return {
    id: 'example',
    kind,
    version: '1.0',
    runtime: kind === 'browser' ? 'browser' : 'process',
    entry_path: 'dist/index.js',
    api_version: kind === 'browser' ? 2 : null,
    installed_at: 1,
    ...overrides,
  };
}
export function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(input instanceof Request ? input.url : String(input));
}
export const signal = () => new AbortController().signal;
