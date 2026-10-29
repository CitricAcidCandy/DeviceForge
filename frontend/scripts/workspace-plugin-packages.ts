import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export interface WorkspacePackageAlias {
  readonly find: string;
  readonly replacement: string;
}
export interface WorkspacePackageDirectory {
  readonly aliases: readonly WorkspacePackageAlias[];
  readonly diagnostics: readonly { readonly project: string; readonly message: string }[];
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** 开发解析只认独立包公开出口，不建立宿主业务清单或私有路径别名。 */
export function workspacePluginPackages(frontendRoot: string): WorkspacePackageDirectory {
  const pluginsRoot = join(resolve(frontendRoot), 'plugins');
  if (!existsSync(pluginsRoot)) return { aliases: [], diagnostics: [] };
  const diagnostics: { project: string; message: string }[] = [];
  const candidates: WorkspacePackageAlias[] = [];
  for (const project of readdirSync(pluginsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!project.isDirectory()) continue;
    const root = join(pluginsRoot, project.name);
    const manifest = join(root, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      const metadata: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
      if (!record(metadata) || typeof metadata.name !== 'string' ||
          !/^@?[a-z0-9][a-z0-9._/-]*$/.test(metadata.name)) throw new Error('开发包名称无效');
      if (metadata.exports === undefined) continue;
      const entries = typeof metadata.exports === 'string'
        ? [['.', metadata.exports]]
        : record(metadata.exports) && Object.keys(metadata.exports).some((key) => key.startsWith('.'))
          ? Object.entries(metadata.exports)
          : [['.', metadata.exports]];
      const additions: WorkspacePackageAlias[] = [];
      for (const [subpath, value] of entries) {
        if (typeof subpath !== 'string' || !/^\.(?:\/[a-zA-Z0-9._/-]+)?$/.test(subpath) ||
            subpath.includes('..')) throw new Error('公开出口必须使用明确子路径');
        const source = typeof value === 'string' ? value
          : record(value) && typeof value.development === 'string' ? value.development : null;
        if (!source) continue;
        if (!source.startsWith('./') || source.includes('\\') || source.includes('\0'))
          throw new Error('开发出口必须在本包内部');
        const absolute = resolve(root, source);
        const lexical = relative(root, absolute);
        if (!lexical || lexical === '..' || lexical.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(lexical))
          throw new Error('开发出口超出独立包目录');
        if (!existsSync(absolute)) throw new Error('公开开发出口不存在');
        const actual = relative(realpathSync(root), realpathSync(absolute));
        if (actual === '..' || actual.startsWith('..\\') || actual.startsWith('../') || isAbsolute(actual))
          throw new Error('开发出口链接指向包外');
        additions.push({ find: metadata.name + (subpath === '.' ? '' : subpath.slice(1)), replacement: absolute });
      }
      candidates.push(...additions);
    } catch (error) {
      diagnostics.push({ project: project.name, message: error instanceof Error ? error.message : '开发包解析失败' });
    }
  }
  const duplicates = new Set(candidates.filter((entry, index) =>
    candidates.findIndex((candidate) => candidate.find === entry.find) !== index).map((entry) => entry.find));
  for (const name of duplicates) diagnostics.push({ project: name, message: '多个工程声明相同公开出口，全部排除' });
  return {
    aliases: candidates.filter((entry) => !duplicates.has(entry.find))
      .sort((a, b) => b.find.length - a.find.length || a.find.localeCompare(b.find)),
    diagnostics,
  };
}

export function workspacePackagePaths(frontendRoot: string, directory = workspacePluginPackages(frontendRoot)) {
  return Object.fromEntries(directory.aliases.map(({ find, replacement }) => [
    find, [`./${relative(resolve(frontendRoot), replacement).replaceAll('\\', '/')}`],
  ]));
}

