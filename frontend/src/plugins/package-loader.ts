import { HostError } from '../plugin-sdk/index.ts';
import type { EsmImporter, InstalledWebPackage, PackageEntryResolver } from '../plugin-sdk/index.ts';
import type { TrustedRegistration } from './manager.ts';
import { readPluginModule } from './contracts.ts';

export function createInstalledPackageLoader(descriptor: InstalledWebPackage, importer: EsmImporter, resolveEntry: PackageEntryResolver): TrustedRegistration {
  return {
    id: descriptor.id, trusted: true,
    async loader(signal) {
      if (signal.aborted) throw new HostError('cancelled', 'cancelled', '包加载等待已取消');
      // URL 来自宿主已安装包适配器；实际 ESM 导入器由宿主注入。
      const runId = crypto.randomUUID();
      const plugin = readPluginModule(await importer(resolveEntry(descriptor, runId), signal));
      if (signal.aborted) throw new HostError('cancelled', 'stale_package', '晚到包模块已撤销');
      if (plugin.id !== descriptor.id || plugin.version !== descriptor.version) throw new Error('包入口声明与安装目录不一致');
      return plugin;
    },
  };
}
