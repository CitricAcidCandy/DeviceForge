import { readFile } from 'node:fs/promises';
import { npmTgz } from '../../backend/scripts/online-plugins/fixtures.mjs';

export const browserId = 'ordinary_deadline_browser_probe';
export const probeKey = 'deviceforge.ordinary-deadline-browser.probe';

// 浏览器夹具只包含本轮公开消费逻辑；服务器包始终由 Galileo 的冻结接口构造。
export async function createBrowserFixture(fixtures) {
  const settings = {
    fixtures: fixtures.map((fixture) => ({
      pluginId: fixture.pluginId,
      protocolVersion: fixture.protocolVersion,
      operations: fixture.operations,
    })),
  };
  const descriptor = {
    name: 'deviceforge-ordinary-deadline-browser-probe',
    version: '1.0.0',
    type: 'module',
    deviceforge: {
      kind: 'browser',
      manifest: 'plugin.json',
      entrypoints: { any: { runtime: 'browser', path: 'dist/index.js' } },
    },
  };
  const files = [
    { path: 'package.json', bytes: JSON.stringify(descriptor) },
    {
      path: 'plugin.json',
      bytes: JSON.stringify({ id: browserId, version: '1.0.0', api_version: 2 }),
    },
    {
      path: 'dist/index.js',
      bytes: await readFile(new URL('./browser-plugin.mjs', import.meta.url)),
    },
    { path: 'dist/settings.json', bytes: JSON.stringify(settings) },
    {
      path: 'dist/relative.js',
      bytes:
        '// 每个 UUID 路径使用独立相对模块图，不声称旧图退出内存。\nexport const dependencyRun = crypto.randomUUID();\n',
    },
  ];
  return { id: browserId, kind: 'browser', files, archive: npmTgz(files) };
}
