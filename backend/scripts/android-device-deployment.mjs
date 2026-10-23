import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { smokeBinary } from './smoke-binaries.mjs';

export async function deployAndroidDevice(temporary, tool, suffix, profile, packageDeployment, java) {
  const directory = join(temporary, 'plugins', 'android-device');
  await mkdir(directory, { recursive: true });
  const configuration = join(directory, 'android-device.config.json');
  await writeFile(configuration, JSON.stringify({
    format_version: 1,
    tools: { adb: tool, java, bundletool: { kind: 'java_jar', jar: join(packageDeployment.directory, 'mock-bundletool.jar') } },
  }));
  const manifest = JSON.parse(await readFile(new URL('../plugins/android-device/manifest.example.json', import.meta.url), 'utf8'));
  manifest.executable = smokeBinary('deviceforge-android-device-plugin', profile);
  manifest.args = ['--config', configuration];
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  const packages = JSON.parse(await readFile(packageDeployment.bindings, 'utf8'));
  const devices = JSON.parse(await readFile(new URL('../plugins/android-device/aliases.example.json', import.meta.url), 'utf8'));
  const bindings = join(temporary, 'operation-bindings.json');
  await writeFile(bindings, JSON.stringify({ format_version: 2, bindings: [...packages.bindings, ...devices.bindings] }));
  return { bindings, directory };
}
