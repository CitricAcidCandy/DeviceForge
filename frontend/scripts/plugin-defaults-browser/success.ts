import type { WebPlugin } from '../../src/plugin-sdk/index.ts';
import { pluginIds } from './fixture.ts';

const mark = (key: string) => {
  const value = Number(document.documentElement.dataset[key] ?? '0');
  document.documentElement.dataset[key] = String(value + 1);
};
mark('defaultSuccessImported');
export const plugin: WebPlugin = {
  id: pluginIds.success, version: '1.0.0', apiVersion: 2, panels: [],
  async activate(context) {
    mark('defaultSuccessActivated');
    context.onDispose(() => mark('defaultSuccessReleased'));
  },
  deactivate() { mark('defaultSuccessDeactivated'); },
  contributions: {
    commands: [{
      id: pluginIds.success + '.ping', title: '原生默认插件命令',
      async execute(input) { return { data: input, logId: 'defaults-native-command-log' }; },
    }],
  },
};
export default plugin;
