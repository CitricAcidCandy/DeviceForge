import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { apkSample } from '../android-packages-smoke/samples.mjs';
import { npmTgz } from '../../backend/scripts/online-plugins/fixtures.mjs';

export const pluginId = 'android-device';
export const apkCase = 'artifact-browser-safe';
export const devices = ['input-ok', 'input-error', 'ok', 'stderr-failure'];
export const capabilityNames = [
  'app.install',
  'screenshot',
  'connect',
  'disconnect',
  'packages',
  'app.start',
  'app.stop',
  'app.uninstall',
  'input',
];
export const operation = (name) => `plugin.${pluginId}.${name}`;
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function createFixtures() {
  const apk = apkSample(apkCase);
  const pixel = await readFile(
    new URL(
      '../../backend/crates/infrastructure/src/device_artifacts/fixtures/pixel.png',
      import.meta.url,
    ),
  );
  return {
    apk,
    pixel,
    browser: browserPackage(),
    apkSha256: sha256(apk),
    pixelSha256: sha256(pixel),
  };
}

export function browserPluginSource() {
  return `const id = 'android_artifacts_browser_probe';
const key = Symbol.for('deviceforge.android-artifacts-browser.probe');
let probe;
function panel(panelId) { return { id: id + '.' + panelId, title: '安卓产物验收 ' + panelId, async mount(target, context) {
  const node = target.ownerDocument.createElement('span'); node.textContent = '安卓产物验收探针'; target.append(node);
  const entry = { context, disposed: false, releases: 0 }; probe.panels[panelId] = entry;
  context.onDispose(() => { entry.disposed = true; });
  return () => { entry.releases += 1; node.remove(); };
} }; }
export default { id, version: '1.0.0', apiVersion: 2, panels: [panel('left'), panel('right')], async activate(context) {
  if (!context.devices || !context.artifacts) throw new Error('公开上下文缺少设备或产物端口');
  probe = { context, moduleIdentity: import.meta.url, disposed: false, panels: {} }; globalThis[key] = probe;
  context.onDispose(() => { probe.disposed = true; });
} };`;
}

export function browserPackage() {
  const files = [
    {
      path: 'package.json',
      bytes:
        JSON.stringify({
          name: 'deviceforge-android-artifacts-browser-probe',
          version: '1.0.0',
          type: 'module',
          deviceforge: {
            kind: 'browser',
            manifest: 'plugin.json',
            entrypoints: { any: { runtime: 'browser', path: 'dist/index.js' } },
          },
        }) + '\n',
    },
    {
      path: 'plugin.json',
      bytes:
        JSON.stringify({
          id: 'android_artifacts_browser_probe',
          version: '1.0.0',
          api_version: 2,
        }) + '\n',
    },
    { path: 'dist/index.js', bytes: browserPluginSource() },
  ];
  return { files, archive: npmTgz(files), id: 'android_artifacts_browser_probe', kind: 'browser' };
}
