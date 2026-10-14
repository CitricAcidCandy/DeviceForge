import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { packagePath, readJson, regularFile } from '../cli/src/paths.mjs';

const maximumFileBytes = 8 * 1024 * 1024;
const maximumTotalBytes = 32 * 1024 * 1024;

async function identity(path) {
  const digest = createHash('sha256');
  let size = 0;
  for await (const bytes of createReadStream(path)) {
    size += bytes.length;
    if (size > maximumFileBytes) throw new Error('原生插件静态成员超过单文件上限');
    digest.update(bytes);
  }
  return { size, sha256: digest.digest('hex') };
}

function destinations(files, reserved = []) {
  const paths = [...reserved, ...files.map((file) => file.target)].map((path) =>
    path.toLowerCase(),
  );
  const seen = new Set(paths);
  if (seen.size !== paths.length) throw new Error('原生插件静态成员与入口、模板或其他成员冲突');
  for (const current of paths) {
    const components = current.split('/');
    for (let length = 1; length < components.length; length++) {
      if (!seen.has(components.slice(0, length).join('/'))) continue;
      throw new Error('原生插件静态成员与入口、模板或其他成员冲突');
    }
  }
}

export async function loadNativePluginAssets(directory) {
  let declaration;
  try {
    declaration = await regularFile(directory, 'package-assets.json');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const descriptor = await readJson(declaration);
  if (
    !descriptor ||
    Array.isArray(descriptor) ||
    descriptor.api_version !== 1 ||
    Object.keys(descriptor).some((key) => !['api_version', 'files'].includes(key)) ||
    !Array.isArray(descriptor.files) ||
    descriptor.files.length === 0 ||
    descriptor.files.length > 64
  ) {
    throw new Error('原生插件静态成员声明必须使用版本1和1至64个文件');
  }
  const files = [];
  let total = 0;
  for (const item of descriptor.files) {
    if (
      !item ||
      Array.isArray(item) ||
      Object.keys(item).some((key) => !['source', 'target'].includes(key)) ||
      typeof item.source !== 'string' ||
      typeof item.target !== 'string' ||
      !item.target.startsWith('bin/')
    ) {
      throw new Error('原生插件静态成员必须声明源文件和bin内目标');
    }
    packagePath(directory, item.target);
    const source = await regularFile(directory, item.source);
    const fingerprint = await identity(source);
    total += fingerprint.size;
    if (total > maximumTotalBytes) throw new Error('原生插件静态成员超过总量上限');
    files.push({ directory, sourceName: item.source, source, target: item.target, ...fingerprint });
  }
  destinations(files);
  return files;
}

export async function copyNativePluginAssets(files, directory, reserved = []) {
  destinations(files, reserved);
  for (const file of files) {
    const source = await regularFile(file.directory, file.sourceName);
    const destination = packagePath(directory, file.target);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    const copied = await identity(await regularFile(directory, file.target));
    if (copied.size !== file.size || copied.sha256 !== file.sha256) {
      throw new Error('原生插件静态成员在构包期间变化，拒绝发布');
    }
  }
}
