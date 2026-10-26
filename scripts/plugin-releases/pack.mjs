// 发布层仅组合已经构建的插件和工具归档，不调用 Cargo、npm 或设备工具。
import { copyFile, mkdir, writeFile, mkdtemp, rm, realpath } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, sep, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  validateRelease,
  selectRelease,
  releaseResources,
  relativePath,
  OFFLINE_LIMIT,
} from './contract.mjs';
import { readJson, measureFile, verifyFile, assertWithin } from './io.mjs';
import { verifyEntries, writeZip, writeTgz } from './archive.mjs';
import { portableOfficialMembers } from './templates.mjs';
import { fixedVersion, versionSatisfied } from './versions.mjs';
import { validateDependencies } from './dependencies.mjs';
import { prepareDependencies } from './pack-dependencies.mjs';

const fail = (condition, message) => {
  if (!condition) throw new Error(message);
};
export const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export const digestBytes = (value) => createHash('sha256').update(value).digest('hex');

async function inputVariant(input, base, tool) {
  fail(
    input && typeof input.file === 'string' && typeof input.platform === 'string',
    '发布输入须声明实际文件及平台',
  );
  const file = resolve(base, input.file),
    measured = await measureFile(file);
  fail(!input.sha256 || input.sha256 === measured.sha256, '发布输入预期摘要与文件不符');
  fail(!input.size || input.size === measured.size, '发布输入预期大小与文件不符');
  const variant = {
    platform: input.platform,
    path: `blobs/${measured.sha256}`,
    ...measured,
    format: input.format,
  };
  if (tool) variant.entries = input.entries;
  const members = await verifyEntries(file, variant, { collect: !tool });
  return { file, variant, members };
}

function portableComponent(members, component, platform, inputVersion) {
  const prefix = members.has('package/package.json') ? 'package/' : '';
  const bytes = members.get(`${prefix}package.json`);
  fail(bytes && bytes.length <= 256 * 1024, '组件缺少有界便携 package.json');
  const descriptor = JSON.parse(bytes),
    entry = descriptor.deviceforge;
  fail(
    fixedVersion(descriptor.version) &&
      versionSatisfied(component.version, descriptor.version) &&
      (inputVersion === undefined || inputVersion === descriptor.version) &&
      entry?.kind === component.kind &&
      typeof entry.manifest === 'string',
    '组件便携描述或版本不匹配',
  );
  relativePath(entry.manifest);
  const manifestBytes = members.get(prefix + entry.manifest);
  fail(manifestBytes && manifestBytes.length <= 256 * 1024, '组件缺少便携清单');
  const manifest = JSON.parse(manifestBytes);
  fail(
    manifest.id === component.id && manifest.version === descriptor.version,
    '组件清单身份与发布声明不匹配',
  );
  const dependencyBytes = members.get(prefix + 'dependencies.json');
  if (dependencyBytes) {
    fail(dependencyBytes.length <= 256 * 1024, '组件依赖清单超过256KiB');
    validateDependencies(JSON.parse(dependencyBytes), {
      owner: component.id,
      components: new Set([component.id]),
    });
  }
  if (component.kind === 'server') {
    const executable = entry.entrypoints?.[platform] ?? entry.entrypoints?.any;
    fail(
      executable && ['native', 'node'].includes(executable.runtime),
      '服务器组件缺少目标平台入口',
    );
    relativePath(executable.path);
    fail(members.has(prefix + executable.path), '组件程序入口不存在');
  }
  return descriptor.version;
}

export async function prepareRelease(sourcePath, inputPath, platform, { staging } = {}) {
  const source = validateRelease(await readJson(sourcePath), { source: true });
  const inputs = await readJson(inputPath),
    base = dirname(resolve(inputPath)),
    files = new Map();
  fail(
    inputs &&
      typeof inputs === 'object' &&
      !Array.isArray(inputs) &&
      Object.keys(inputs).every((key) =>
        ['components', 'tools', ...(source.format_version === 2 ? ['dependencies'] : [])].includes(
          key,
        ),
      ),
    '发布输入必须为组件和工具对象',
  );
  for (const [kind, values] of [
    ['components', source.components],
    ['tools', source.tools ?? []],
    ...(source.format_version === 2
      ? [['dependencies', source.dependencies?.dependencies ?? []]]
      : []),
  ]) {
    fail(
      !inputs[kind] ||
        (typeof inputs[kind] === 'object' &&
          !Array.isArray(inputs[kind]) &&
          Object.keys(inputs[kind]).every((id) => values.some((item) => item.id === id))),
      `发布输入含未知${kind}身份`,
    );
  }
  const components = [];
  for (const component of source.components) {
    const input = inputs.components?.[component.id];
    fail(input, `插件组件缺实际归档：${component.id}`);
    let { file, variant, members } = await inputVariant(input, base, false);
    const version = portableComponent(members, component, variant.platform, input.version);
    const locked = { ...component, version };
    if (staging) {
      members = portableOfficialMembers(locked, members);
      file = join(staging, `${component.id}.tgz`);
      await writeTgz(file, members);
      const measured = await measureFile(file);
      variant = { ...variant, ...measured, path: `blobs/${measured.sha256}`, format: 'tgz' };
    }
    files.set(variant.sha256, file);
    components.push({ ...locked, variants: [variant] });
  }
  const tools = [];
  for (const tool of source.tools ?? []) {
    const input = inputs.tools?.[tool.id];
    if (!input) {
      fail(tool.required === false, `必需工具缺实际归档：${tool.id}`);
      continue;
    }
    const version = input.version;
    fail(fixedVersion(version), `工具必须填写已核验固定版本：${tool.id}`);
    fail(
      versionSatisfied(tool.version, version),
      `工具版本不满足源码范围或与固定声明不一致：${tool.id}`,
    );
    const { file, variant } = await inputVariant(input, base, true);
    files.set(variant.sha256, file);
    tools.push({ ...tool, version, variants: [variant] });
  }
  const dependencies =
    source.format_version === 2
      ? await prepareDependencies(source.dependencies, inputs.dependencies, base, files)
      : undefined;
  const manifest = selectRelease(
    validateRelease({ ...source, components, tools, ...(dependencies ? { dependencies } : {}) }),
    platform,
  );
  return { manifest, files, platform };
}

export async function verifyReleaseDirectory(directory) {
  const manifest = validateRelease(await readJson(join(directory, 'release.json')));
  for (const dependency of manifest.dependencies?.dependencies ?? [])
    for (const source of dependency.sources ?? [])
      fail(source.kind !== 'market' || source.url === `blobs/${source.sha256}`,
        '离线市场依赖必须引用同摘要的本地 blobs 资源');
  const files = new Map();
  for (const variant of releaseResources(manifest)) {
    const file = resolve(directory, variant.path);
    await assertWithin(directory, file);
    await verifyFile(file, variant);
    files.set(variant.sha256, file);
  }
  // 同一摘要可以被不同资源键引用，每份入口声明仍独立验证。
  for (const tool of manifest.tools ?? [])
    for (const variant of tool.variants)
      await verifyEntries(files.get(variant.sha256), variant, { collect: false });
  for (const dependency of manifest.dependencies?.dependencies ?? [])
    for (const source of dependency.sources ?? [])
      if (source.kind === 'market')
        await verifyEntries(files.get(source.sha256), source, { collect: false });
  for (const component of manifest.components)
    for (const variant of component.variants)
      portableComponent(
        await verifyEntries(files.get(variant.sha256), variant),
        component,
        variant.platform,
      );
  return { manifest, files };
}

export async function packRelease({
  source,
  inputs,
  destination,
  platform = `${process.platform}-${process.arch}`,
}) {
  const staging = await mkdtemp(join(tmpdir(), 'deviceforge-release-pack-'));
  try {
    const prepared = await prepareRelease(resolve(source), resolve(inputs), platform, { staging });
    const directory = resolve(destination);
    // 所有随包资源及依赖声明验证成功后才创建输出；现有目录永不覆盖。
    await mkdir(directory);
    await mkdir(join(directory, 'blobs'));
    const members = [],
      manifestBytes = jsonBytes(prepared.manifest);
    for (const variant of releaseResources(prepared.manifest)) {
      const file = join(directory, variant.path);
      await copyFile(prepared.files.get(variant.sha256), file);
      await verifyFile(file, variant);
      members.push({ name: variant.path, path: file });
    }
    await writeFile(join(directory, 'release.json'), manifestBytes, { flag: 'wx' });
    const archive = join(
      directory,
      `${prepared.manifest.id}-${prepared.manifest.version}-${platform}.zip`,
    );
    await writeZip(archive, [{ name: 'release.json', bytes: manifestBytes }, ...members]);
    const report = {
      id: prepared.manifest.id,
      version: prepared.manifest.version,
      platform,
      revision: digestBytes(manifestBytes),
      resources: members.length,
      archive,
      ...(await measureFile(archive, OFFLINE_LIMIT)),
    };
    await writeFile(join(directory, 'pack-report.json'), jsonBytes(report), { flag: 'wx' });
    return report;
  } finally {
    const absolute = await realpath(staging),
      temporary = await realpath(tmpdir()),
      offset = relative(temporary, absolute);
    fail(
      offset &&
        !isAbsolute(offset) &&
        offset !== '..' &&
        !offset.startsWith('..' + sep) &&
        basename(absolute).startsWith('deviceforge-release-pack-'),
      '发布暂存清理路径越界',
    );
    await rm(absolute, { recursive: true, force: true });
  }
}
