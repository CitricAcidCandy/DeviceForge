import type { Dispose, HostContext } from '../../plugin-sdk/index.ts';
import type { PlatformRuntime } from '../platform-runtime.ts';
import { legacyRouteSurfaces } from './legacy-route-surfaces.ts';

/** 旧设置分组仍在“插件扩展”分类里显示，不挪到全页页脚或开放替换。 */
export function registerLegacySettings(
  context: HostContext,
  extensions: PlatformRuntime['extensions'],
  ownerId: string,
) {
  const ui = context.ui, points = context.extensions?.points;
  if (!ui || !points) throw new Error('旧设置分组需要公开视图与扩展点');
  const viewId = `${ownerId}.settings-section`;
  ui.register({ views: [{
    id: viewId, title: '兼容插件设置', provides: ['settings.legacy-sections'],
    mount: legacyRouteSurfaces(() => extensions, 'settings.plugin.section')(async () => () => {}),
  }] });
  const access = points;
  let release: Dispose | null = null;
  const refresh = () => {
    if (context.signal.aborted) return;
    const present = extensions.catalog().components.some((entry) => entry.slot === 'settings.plugin.section');
    if (present && !release) release = access.contribute({
      id: `${ownerId}.settings-section-entry`, point: { id: 'deviceforge_settings.sections', version: '1' },
      mode: 'append', data: { title: '兼容插件设置', view: { pluginId: ownerId, viewId } },
    }).dispose;
    else if (!present && release) { const previous = release; release = null; void previous(); }
  };
  context.onDispose(extensions.subscribe(refresh));
  refresh();
}
