import { HostError } from '../plugin-sdk/index.ts';
import type { EsmImporter, InstalledWebPackage, PackageEntryResolver } from '../plugin-sdk/index.ts';
import type { createPluginManager } from './manager.ts';
import { createInstalledPackageLoader } from './package-loader.ts';

export function createInstalledPackageController(manager: ReturnType<typeof createPluginManager>, resolveEntry: PackageEntryResolver, importer?: EsmImporter) {
  const sources = new Map<string, InstalledWebPackage>();
  function register(descriptor: InstalledWebPackage) {
    if (!importer) throw new Error('宿主未注入已安装包 ESM 导入器');
    const current = sources.get(descriptor.id);
    if (current) {
      if (current.version === descriptor.version && current.entryPath === descriptor.entryPath) return;
      throw new Error('安装包来源发生变化，须先撤销旧来源');
    }
    manager.register(createInstalledPackageLoader(descriptor, importer, resolveEntry));
    sources.set(descriptor.id, descriptor);
  }
  async function enable(descriptor: InstalledWebPackage, signal: AbortSignal) {
    if (signal.aborted) throw new HostError('cancelled', 'cancelled', '浏览器包启用等待已取消');
    const old = sources.get(descriptor.id);
    if (old && (old.version !== descriptor.version || old.entryPath !== descriptor.entryPath)) {
      await manager.unregister(descriptor.id); sources.delete(descriptor.id);
    }
    if (signal.aborted) throw new HostError('cancelled', 'cancelled', '浏览器包启用等待已取消');
    register(descriptor);
    let cancellation: Promise<void> | null = null;
    const cancel = () => { cancellation = manager.unload(descriptor.id); void cancellation.catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const result = await manager.load(descriptor.id);
      if (signal.aborted) throw new HostError('cancelled', 'cancelled', '浏览器包启用等待已取消');
      return result;
    } finally { signal.removeEventListener('abort', cancel); if (cancellation) await cancellation; }
  }
  return {
    register, enable,
    disable: manager.unload,
    async forget(id: string) { await manager.unregister(id); sources.delete(id); },
    clearSources: () => sources.clear(),
  };
}
