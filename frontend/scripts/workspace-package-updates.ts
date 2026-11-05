import type { WorkspacePackageDirectory } from './workspace-plugin-packages.ts';
import { workspacePluginPackages } from './workspace-plugin-packages.ts';
import type { Plugin } from 'vite';
import { join, relative, resolve } from 'node:path';

type PackageEvent = 'add' | 'change' | 'unlink';
interface PackageWatcher {
  on(event: PackageEvent, listener: (file: string) => void): void;
  off(event: PackageEvent, listener: (file: string) => void): void;
}
export interface WorkspacePackageUpdatePort {
  readonly watcher: PackageWatcher;
  readonly invalidate: () => void;
  readonly reload: () => void;
  readonly report: (diagnostics: WorkspacePackageDirectory['diagnostics']) => void;
}

/** 开发目录变化由文件事件驱动；模块解析继续只读同一张公开出口表。 */
export function attachWorkspacePackageUpdates(
  root: string,
  aliases: Map<string, string>,
  port: WorkspacePackageUpdatePort,
  readDirectory: (root: string) => WorkspacePackageDirectory = workspacePluginPackages,
): () => void {
  const pluginsRoot = join(resolve(root), 'plugins');
  let stopped = false;
  const update = (file: string) => {
    if (stopped) return;
    const parts = relative(pluginsRoot, resolve(file)).replaceAll('\\', '/').split('/');
    if (parts.length !== 2 || !parts[0] || parts[0] === '..' || parts[1] !== 'package.json') return;
    let directory: WorkspacePackageDirectory;
    try { directory = readDirectory(root); }
    catch {
      // 只报告本阶段失败，不回显任意异常正文；下次独立变更仍可更新目录。
      port.report([{ project: '公开开发出口', message: '目录读取失败，保留上次有效映射' }]);
      return;
    }
    port.report(directory.diagnostics);
    const next = new Map(directory.aliases.map(({ find, replacement }) => [find, replacement]));
    if (next.size === aliases.size && [...next].every(([name, path]) => aliases.get(name) === path)) return;
    // 整体更新在同一同步回调中完成，失效通知只能看到当前完整公开目录。
    aliases.clear();
    for (const [name, path] of next) aliases.set(name, path);
    port.invalidate();
    port.reload();
  };
  const events: readonly PackageEvent[] = ['add', 'change', 'unlink'];
  for (const event of events) port.watcher.on(event, update);
  return () => {
    if (stopped) return;
    stopped = true;
    for (const event of events) port.watcher.off(event, update);
  };
}

/** Vite只提供监听和缓存失效端口，公开出口的读取与校验继续由原目录负责。 */
export function workspacePackageUpdates(root: string, aliases: Map<string, string>): Plugin {
  let release = () => {};
  return {
    name: 'deviceforge-workspace-package-updates',
    configureServer(server) {
      release();
      release = attachWorkspacePackageUpdates(root, aliases, {
        watcher: server.watcher,
        invalidate: () => server.moduleGraph.invalidateAll(),
        reload: () => server.ws.send({ type: 'full-reload' }),
        report: (diagnostics) => {
          if (diagnostics.length)
            server.config.logger.warn(`公开开发出口有${diagnostics.length}项无效声明，请检查插件清单。`);
        },
      });
    },
    closeBundle() { release(); },
  };
}
