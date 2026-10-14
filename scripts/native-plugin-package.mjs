import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inside, readJson, regularFile } from '../cli/src/paths.mjs';
import { materializeManifest } from '../cli/src/plugin-package.mjs';
import { npmCommand } from '../cli/src/processes.mjs';
import {
  nativePluginPlan,
  nativePluginReadme,
  selectPluginPlans,
  verifyNativeHost,
} from './native-plugin-plan.mjs';
import { loadNativePluginSource } from './native-plugin-source.mjs';
import { copyNativePluginAssets } from './native-plugin-assets.mjs';

const execute = promisify(execFile);
const defaultRoot = fileURLToPath(new URL('../', import.meta.url));

async function loadPlans(backend, selected, options) {
  const output = await execute(
    'cargo',
    ['metadata', '--format-version', '1', '--no-deps'],
    options,
  );
  const metadata = JSON.parse(output.stdout);
  const packages = metadata.packages.filter(
    (pkg) =>
      metadata.workspace_members.includes(pkg.id) &&
      inside(join(backend, 'plugins'), dirname(pkg.manifest_path)),
  );
  const plans = await Promise.all(
    packages.map(async (pkg) => {
      const sourceDirectory = dirname(pkg.manifest_path);
      const { manifest, configurationTemplates, assets } =
        await loadNativePluginSource(sourceDirectory);
      return {
        ...nativePluginPlan(pkg, manifest),
        sourceDirectory,
        configurationTemplates,
        assets,
      };
    }),
  );
  return { metadata, plans: selectPluginPlans(plans, selected) };
}

async function compilePlugins(plans, metadata, options) {
  const compiler = await execute('rustc', ['-vV'], options);
  const host = verifyNativeHost(compiler.stdout.match(/^host: (.+)$/m)?.[1]?.trim() || '');
  const args = [
    'build',
    '--locked',
    '--release',
    '--bins',
    '--target',
    host,
    '--message-format=json-render-diagnostics',
    '-p',
    'apk-server',
  ];
  for (const plan of plans) args.push('-p', plan.crate);
  const build = await execute('cargo', args, { ...options, timeout: 300000 });
  if (build.stderr) process.stderr.write(build.stderr);
  const artifacts = build.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter(
      (entry) =>
        entry.reason === 'compiler-artifact' &&
        entry.executable &&
        entry.target.kind.includes('bin'),
    );
  async function binary(packageId, target) {
    const entry = artifacts.find(
      (item) => item.package_id === packageId && item.target.name === target,
    );
    if (!entry || !inside(metadata.target_directory, entry.executable))
      throw new Error('Cargo 没有返回目标目录内的原生入口');
    return regularFile(dirname(entry.executable), basename(entry.executable));
  }
  const server = metadata.packages.find(
    (pkg) => pkg.name === 'apk-server' && metadata.workspace_members.includes(pkg.id),
  );
  if (!server) throw new Error('工作区缺少插件校验器');
  return { validator: await binary(server.id, 'validate-plugin'), binary };
}

async function packOne(plan, temporary, destination, compiled, options, cliVersion) {
  const directory = join(temporary, plan.id);
  await mkdir(join(directory, 'bin'), { recursive: true });
  await copyFile(await compiled.binary(plan.packageId, plan.target), join(directory, plan.entry));
  for (const template of plan.configurationTemplates) {
    await copyFile(template.source, join(directory, 'bin', template.name));
  }
  await copyNativePluginAssets(plan.assets, directory, [
    plan.entry,
    ...plan.configurationTemplates.map((template) => `bin/${template.name}`),
  ]);
  const sourceReadme = await readFile(await regularFile(plan.sourceDirectory, 'README.md'), 'utf8');
  await writeFile(
    join(directory, 'README.md'),
    nativePluginReadme(plan, cliVersion, sourceReadme, plan.configurationTemplates),
  );
  await writeFile(join(directory, 'package.json'), JSON.stringify(plan.packageJson, null, 2));
  await writeFile(join(directory, 'plugin.json'), JSON.stringify(plan.portableManifest, null, 2));
  // 与真正安装器共用入口映射和 Rust 注册门禁，打包阶段也不执行插件。
  const manifest = await materializeManifest(directory, directory);
  const checkPath = join(temporary, `${plan.id}.validate.json`);
  await writeFile(checkPath, JSON.stringify(manifest));
  await execute(compiled.validator, [checkPath], { ...options, timeout: 15000, maxBuffer: 65536 });
  const npm = npmCommand(options.env);
  const output = await execute(
    npm.command,
    [...npm.prefix, 'pack', '--ignore-scripts', '--json', '--pack-destination', destination],
    { ...options, cwd: directory },
  );
  const packed = JSON.parse(output.stdout);
  if (
    packed.length !== 1 ||
    packed[0].name !== plan.packageJson.name ||
    packed[0].version !== plan.packageJson.version
  )
    throw new Error('npm 打包结果与插件计划不一致');
  const archive = await regularFile(destination, packed[0].filename);
  return {
    id: plan.id,
    name: packed[0].name,
    version: packed[0].version,
    archive,
    size: packed[0].size,
  };
}

export async function packNativePlugins({
  root = defaultRoot,
  destination = join(root, 'artifacts'),
  selected = [],
  signal,
} = {}) {
  root = resolve(root);
  destination = resolve(destination);
  const backend = join(root, 'backend');
  const cliVersion = (await readJson(join(root, 'package.json'))).version;
  const environment = { ...process.env };
  delete environment.APK_API_TOKEN;
  const options = {
    cwd: backend,
    env: environment,
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
    signal,
  };
  const { metadata, plans } = await loadPlans(backend, selected, options);
  const compiled = await compilePlugins(plans, metadata, options);
  const stagingRoot = join(root, '.runtime-staging');
  await mkdir(stagingRoot, { recursive: true });
  await mkdir(destination, { recursive: true });
  const temporary = await mkdtemp(join(stagingRoot, 'plugin-pack-'));
  try {
    const results = [];
    for (const plan of plans)
      results.push(await packOne(plan, temporary, destination, compiled, options, cliVersion));
    return results;
  } finally {
    // 仅清理本次创建的暂存目录，发布的 tgz 和其他构建目录继续保留。
    if (!inside(stagingRoot, temporary) || temporary === stagingRoot)
      throw new Error('插件打包清理路径越界');
    await rm(temporary, { recursive: true, force: true });
  }
}
