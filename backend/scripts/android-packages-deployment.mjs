// 七业务服务回归只部署真实插件清单，工具与签名均为本次假样本。
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export async function deployAndroidPackages(temporary, tool, signingFile, suffix, profile = 'debug') {
  const directory = join(temporary, 'plugins', 'android-packages');
  const scratch = join(temporary, 'android-packages-work');
  await mkdir(directory, { recursive: true });
  await mkdir(scratch);
  const bundletool = join(directory, 'mock-bundletool.jar');
  const apktool = join(directory, 'mock-apktool.jar');
  await writeFile(bundletool, '仅用于模拟bundletool入口');
  await writeFile(apktool, '仅用于模拟apktool入口');
  const configuration = join(directory, 'android-packages.config.json');
  await writeFile(configuration, JSON.stringify({
    format_version: 1,
    tools: {
      java: tool,
      apkanalyzer: { kind: 'executable', executable: tool },
      apksigner: { kind: 'executable', executable: tool },
      bundletool: { kind: 'java_jar', jar: bundletool },
      apktool: { kind: 'java_jar', jar: apktool },
    },
    signing: { keystore: signingFile, alias: 'test-key',
      store_password_file: signingFile, key_password_file: signingFile },
    scratch_root: scratch,
  }));
  const manifest = JSON.parse(await readFile(new URL('../plugins/android-packages/manifest.example.json', import.meta.url), 'utf8'));
  manifest.executable = resolve('target', profile, `deviceforge-android-packages-plugin${suffix}`);
  manifest.args = ['--config', configuration];
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  const bindings = join(temporary, 'android-packages-bindings.json');
  await copyFile(new URL('../plugins/android-packages/aliases.example.json', import.meta.url), bindings);
  return { bindings, scratch, directory };
}
