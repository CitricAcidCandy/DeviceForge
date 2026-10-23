// 共享 Cargo 获准后显式执行；每批使用新目录，保留失败现场及全部冻结字节。
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packNativePlugins } from '../native-plugin-package.mjs';
import { officialSources } from './official.mjs';
import { prepareOfficialInputs } from './prepare-official-inputs.mjs';
import { packRelease, verifyReleaseDirectory, jsonBytes } from './pack.mjs';
import { readJson, measureFile } from './io.mjs';

export async function buildOfficialReleases({ destination, inventory }) {
  const output = resolve(destination);
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const official = (await officialSources(root)).reports;
  const ids = official.map((item) => item.id);
  const stock = resolve(inventory);
  await readJson(stock);
  await mkdir(output);
  const nativeDirectory = join(output, 'native-components');
  const componentPath = join(output, 'native-results.json');
  const native = await packNativePlugins({ root, destination: nativeDirectory, selected: ids });
  const frozen = [];
  for (const item of native) frozen.push({ ...item, ...(await measureFile(item.archive)) });
  await writeFile(componentPath, jsonBytes(frozen), { flag: 'wx' });
  const inputDirectory = join(output, 'inputs');
  await prepareOfficialInputs({
    components: componentPath,
    inventory: stock,
    destination: inputDirectory,
    root,
  });
  const releases = join(output, 'releases');
  await mkdir(releases);
  const reports = [];
  for (const { id, directory: sourceDirectory } of official) {
    console.log(`开始打包官方发布：${id}`);
    const directory = join(releases, id);
    const packed = await packRelease({
      source: join(root, 'backend/plugins', sourceDirectory, 'release.json'),
      inputs: join(inputDirectory, `${id}.json`),
      destination: directory,
      platform: 'win32-x64',
    });
    const verified = await verifyReleaseDirectory(directory);
    reports.push({ ...packed, resources_verified: verified.files.size, directory_verified: true });
    await writeFile(join(output, 'release-progress.json'), jsonBytes({ complete: false, reports }));
  }
  const report = {
    complete: reports.length === ids.length,
    platform: 'win32-x64',
    reports,
    native_components: frozen,
    real_host_installed: false,
    market_published: false,
    device_verified: false,
  };
  await writeFile(join(output, 'build-report.json'), jsonBytes(report), { flag: 'wx' });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [destination, inventory] = process.argv.slice(2);
  if (!destination || !inventory || process.argv.length !== 4)
    throw new Error('用法：node build-official-releases.mjs 独占新输出目录 工具库存.json');
  console.log(JSON.stringify(await buildOfficialReleases({ destination, inventory }), null, 2));
}
