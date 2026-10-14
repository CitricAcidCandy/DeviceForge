import { readFile } from 'node:fs/promises';
import { npmTgz, serverFixture } from '../../backend/scripts/online-plugins/fixtures.mjs';

export const browserId = 'task_history_browser_probe';
export const probeKey = 'deviceforge.task-history-browser.probe';

// 复用公开协议2有限回显包与通用TGZ生成器，不执行 npm 或安装脚本。
export async function createFixtures() {
  const server = serverFixture(2);
  const descriptor = {
    name: 'deviceforge-task-history-browser-probe',
    version: '1.0.0',
    type: 'module',
    deviceforge: {
      kind: 'browser',
      manifest: 'plugin.json',
      entrypoints: { any: { runtime: 'browser', path: 'dist/index.js' } },
    },
  };
  const files = [
    { path: 'package.json', bytes: JSON.stringify(descriptor) + '\n' },
    {
      path: 'plugin.json',
      bytes: JSON.stringify({ id: browserId, version: '1.0.0', api_version: 2 }) + '\n',
    },
    {
      path: 'dist/index.js',
      bytes: await readFile(new URL('./browser-plugin.mjs', import.meta.url)),
    },
  ];
  return {
    server,
    browser: { id: browserId, kind: 'browser', files, archive: npmTgz(files) },
    config: {
      browserId,
      serverId: server.id,
      operation: 'plugin.' + server.id + '.echo',
      probeKey,
      panelIds: { left: browserId + '.left', right: browserId + '.right' },
    },
  };
}
