import type { JobDto } from '../../services/api/index.ts';
import type { ProductRoute } from './routes.ts';

export const taskStateLabels: Readonly<Record<JobDto['status'], string>> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
};

function pluginOperations(pluginId: string, actions: readonly string[]): readonly string[] {
  return actions.map((action) => `plugin.${pluginId}.${action}`);
}

// 画面与应用并入设备工作台后，这些操作产生的任务都归属设备页。
const routeOperations: Readonly<Partial<Record<ProductRoute, ReadonlySet<string>>>> = {
  devices: new Set([
    ...pluginOperations('android-device', ['discover', 'connect', 'disconnect', 'input']),
    ...pluginOperations('harmony-device', ['discover', 'connect', 'disconnect', 'input']),
    ...pluginOperations('android-packages', [
      'manifest', 'signature', 'extract_apk', 'build_apks', 'decode', 'scan_sdks', 'extract_splits',
    ]),
    ...pluginOperations('android-device', [
      'packages', 'app.install', 'app.install_apks', 'app.start', 'app.stop', 'app.uninstall',
      'screenshot',
    ]),
    ...pluginOperations('harmony-device', [
      'packages', 'app.install', 'app.uninstall', 'app.detail', 'app.start', 'app.stop', 'app.reset',
      'screenshot',
    ]),
    ...pluginOperations('mirroring', ['runtime.status', 'record', 'open']),
  ]),
  performance: new Set([
    ...['start', 'inspect', 'pause', 'resume', 'stop', 'samples', 'list', 'capabilities'].map(
      (action) => `android.performance.${action}`,
    ),
    ...pluginOperations('android-device', ['performance.sample', 'stack.probe', 'profile.record']),
  ]),
  frida: new Set(pluginOperations('frida', [
    'server.deploy', 'server.status', 'server.run', 'processes', 'script.run', 'permissions.analyze',
  ])),
  automation: new Set(pluginOperations('automation', [
    'sequence.run', 'click.repeat', 'windows.mouse.position', 'windows.mouse.click',
    'windows.mouse.repeat', 'input_trace.record', 'input_trace.playback',
  ])),
  terminal: new Set(pluginOperations('terminal', ['open'])),
  ai: new Set([
    ...pluginOperations('ai-assistant', [
      'runtime.status', 'cli.single', 'cli.turn', 'session.get', 'session.close', 'cli.stream',
    ]),
    ...pluginOperations('ai-sdk', [
      'runtime.status', 'sdk.single', 'sdk.turn', 'session.get', 'session.close',
      'assistant.run', 'sdk.stream',
    ]),
  ]),
  analysis: new Set([
    ...pluginOperations('dex-analysis', ['inspect', 'scan_sdks']),
    ...pluginOperations('msgpack', ['encode', 'decode', 'query']),
  ]),
  tools: new Set(pluginOperations('tool-supply', [
    'catalog', 'plan', 'install', 'runtime_feature.status', 'runtime_feature.prepare', 'remove',
  ])),
  settings: new Set(pluginOperations('settings', [
    'list', 'get', 'set', 'delete', 'import', 'remote.load', 'remote.save',
  ])),
};

export function taskBelongsToRoute(
  operation: string,
  route: ProductRoute,
  deviceOperations?: ReadonlySet<string>,
): boolean {
  if (route === 'tasks') return true;
  if (route === 'devices' && deviceOperations?.has(operation)) return true;
  return routeOperations[route]?.has(operation) ?? false;
}
