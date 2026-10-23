import type { EsmImporter } from '../plugin-sdk/index.ts';

// 只加载当前服务器已安装包的运行代次或不可变发布资源，业务页面不直接导入远端代码。
export function installedPackageUrl(baseUrl: string, value: string): string {
  const origin = new URL(baseUrl).origin;
  const url = new URL(value, origin);
  const legacyRun = /^\/api\/v2\/browser-plugins\/[a-z][a-z0-9._-]*\/runs\/[a-zA-Z0-9._-]+\/assets\/.+\.(?:js|mjs)$/.test(url.pathname);
  const release = /^\/api\/v2\/plugin-installations\/browser\/[A-Za-z][A-Za-z0-9._-]{0,127}\/revisions\/[a-f0-9]{64}\/assets\/.+\.(?:js|mjs)$/.test(url.pathname);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!legacyRun && !release)
  )
    throw new Error('浏览器插件入口必须来自当前服务器的已安装包');
  return url.href;
}

export function createInstalledPackageImporter(baseUrl: string): EsmImporter {
  return async (value, signal) => {
    if (signal.aborted) throw new Error('浏览器插件加载已取消');
    const url = installedPackageUrl(baseUrl, value);
    const loaded: unknown = await import(/* @vite-ignore */ url);
    if (signal.aborted) throw new Error('浏览器插件加载结果已撤销');
    return loaded;
  };
}
