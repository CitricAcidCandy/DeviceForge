import type { WebPlugin } from '../../src/plugin-sdk/index.ts';
import { pluginIds } from './fixture.ts';

const mark = (key: string) => {
  const value = Number(document.documentElement.dataset[key] ?? '0');
  document.documentElement.dataset[key] = String(value + 1);
};
mark('defaultFailureImported');
export const plugin: WebPlugin = {
  id: pluginIds.failure, version: '1.0.0', apiVersion: 2, panels: [],
  async activate(context) {
    mark('defaultFailureActivated');
    context.onDispose(() => mark('defaultFailureReleased'));
    throw new Error('受控 SDK v2 插件启动失败');
  },
};
export default plugin;
