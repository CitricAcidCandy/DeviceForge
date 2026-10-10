import { HostError } from '../plugin-sdk/index.ts';
import type { EsmImporter, InstalledWebPackage, PackageEntryResolver } from '../plugin-sdk/index.ts';
import type { TrustedRegistration } from './manager.ts';
import { readPluginModule } from './contracts.ts';

// 资源路径代次仅用于避免 ESM 依赖图缓存复用，不承担鉴权；普通 LAN HTTP 同样可用。
const packageRunPrefix = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
let packageRunSequence = 0;

export function createInstalledPackageLoader(descriptor: InstalledWebPackage, importer: EsmImporter, resolveEntry: PackageEntryResolver): TrustedRegistration {
  return {
    id: descriptor.id, trusted: true,
    async loader(signal) {
      if (signal.aborted) throw new HostError('cancelled', 'cancelled', '包加载等待已取消');
      // URL 来自宿主已安装包适配器；实际 ESM 导入器由宿主注入。
      const runId = packageRunPrefix + '-' + (++packageRunSequence).toString(36);
      const plugin = readPluginModule(await importer(resolveEntry(descriptor, runId), signal));
      if (signal.aborted) throw new HostError('cancelled', 'stale_package', '晚到包模块已撤销');
      if (plugin.id !== descriptor.id || plugin.version !== descriptor.version) throw new Error('包入口声明与安装目录不一致');
      return plugin;
    },
  };
}
