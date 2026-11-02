import type { WebPlugin } from '../../plugin-sdk/index.ts';
import type { PlatformRuntime } from '../platform-runtime.ts';
import { registerLegacySettings } from './legacy-settings.ts';

/** 兼容旧扩展贡献，不登记宿主业务页，也不在独立插件停用时恢复旧页面。 */
export function createLegacyCompositionAdapter(
  extensions: PlatformRuntime['extensions'],
): WebPlugin {
  const id = 'host_legacy_adapters';
  return {
    id, version: '0.1.0', apiVersion: 2, panels: [],
    async activate(context) {
      registerLegacySettings(context, extensions, id);
    },
  };
}
