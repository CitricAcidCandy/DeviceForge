import type { Plugin } from 'vite';

interface WorkspaceModuleResolution {
  readonly plugins: Plugin[];
  readonly worker: {
    readonly format: 'es';
    readonly plugins: () => Plugin[];
  };
}

/** 各构建环境复用同一公开出口表，独立建立插件实例；解析期间不扫描磁盘。 */
export function workspaceModuleResolution(aliases: ReadonlyMap<string, string>): WorkspaceModuleResolution {
  const plugin = (): Plugin => ({
    name: 'deviceforge-workspace-public-packages',
    resolveId(id) { return aliases.get(id) ?? null; },
  });
  return {
    plugins: [plugin()],
    worker: { format: 'es', plugins: () => [plugin()] },
  };
}
