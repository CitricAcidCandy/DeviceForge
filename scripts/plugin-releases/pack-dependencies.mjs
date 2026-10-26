// 第二版仅把显式本地输入转成市场资源；官方 HTTPS 元数据和本机发现无需原包。
import { resolve } from 'node:path';
import {
  validateDependencies,
  compatibleDependencyVersion,
  dependencyUrl,
} from './dependencies.mjs';
import { measureFile } from './io.mjs';
import { verifyEntries } from './archive.mjs';

export async function prepareDependencies(manifest, inputs, base, files) {
  const dependencies = structuredClone(manifest ?? { format_version: 1, dependencies: [] });
  for (const item of dependencies.dependencies) {
    const supplied = inputs?.[item.id];
    for (const input of supplied === undefined
      ? []
      : Array.isArray(supplied)
        ? supplied
        : [supplied]) {
      if (
        !input ||
        typeof input.file !== 'string' ||
        !compatibleDependencyVersion(item.version_requirement, input.version)
      )
        throw new Error(`依赖缺真实文件或版本不满足范围：${item.id}`);
      const file = resolve(base, input.file),
        measured = await measureFile(file);
      if (
        (input.sha256 && input.sha256 !== measured.sha256) ||
        (input.size && input.size !== measured.size)
      )
        throw new Error(`依赖输入摘要或大小不符：${item.id}`);
      const source = {
        kind: 'market',
        url: `blobs/${measured.sha256}`,
        platform: input.platform,
        version: input.version,
        ...measured,
        format: input.format,
        entries: input.entries,
      };
      validateDependencies({
        format_version: 1,
        dependencies: [{ ...item, requires: [], sources: [source] }],
      });
      await verifyEntries(file, source, { collect: false });
      files.set(source.sha256, file);
      // 相同版本的不同归档保留各自摘要，不按工具ID/版本覆盖仓库修订。
      item.sources ??= [];
      if (!item.sources.some((other) => JSON.stringify(other) === JSON.stringify(source)))
        item.sources.push(source);
    }
    for (const source of item.sources ?? []) {
      if (source.kind !== 'market') continue;
      let file = files.get(source.sha256);
      if (!file) {
        if (dependencyUrl(source)) throw new Error(`市场依赖须提供可核验的本地输入：${item.id}`);
        file = resolve(base, source.url);
      }
      const measured = await measureFile(file);
      if (measured.sha256 !== source.sha256 || measured.size !== source.size)
        throw new Error(`市场依赖摘要或大小不符：${item.id}`);
      await verifyEntries(file, source, { collect: false });
      files.set(source.sha256, file);
      source.url = `blobs/${source.sha256}`;
    }
  }
  return validateDependencies(dependencies);
}
