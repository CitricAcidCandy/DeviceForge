import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { smokeBinary } from './smoke-binaries.mjs';

// 模拟部署使用独立插件及显式旧名映射，宿主不再提供 HDC 业务回退。
export async function deployHarmonyDevice(temporary, tool, suffix, profile, priorBindings) {
  const directory = join(temporary, 'plugins', 'harmony-device');
  await mkdir(directory, { recursive: true });
  const configuration = join(directory, 'harmony-device.config.json');
  await writeFile(configuration, JSON.stringify({ format_version: 1, tools: { hdc: tool } }));
  const manifest = JSON.parse(await readFile(new URL('../plugins/harmony-device/manifest.example.json', import.meta.url), 'utf8'));
  manifest.executable = smokeBinary('deviceforge-harmony-device-plugin', profile);
  manifest.args = ['--config', configuration];
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  const existing = JSON.parse(await readFile(priorBindings, 'utf8'));
  const harmony = JSON.parse(await readFile(new URL('../plugins/harmony-device/aliases.example.json', import.meta.url), 'utf8'));
  await writeFile(priorBindings, JSON.stringify({ format_version: 2, bindings: [...existing.bindings, ...harmony.bindings] }));
  return { bindings: priorBindings, directory };
}
