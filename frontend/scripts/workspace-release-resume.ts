import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { extract } from 'it-tar';
import { unzipSync } from 'fflate';
import { auditBrowserBundle } from './browser-bundle-closure.ts';
import type { BundleClosure } from './browser-bundle-closure.ts';
import { hash, inside, object, readObject, releaseSourceIdentity } from './workspace-release-inputs.ts';
import type { ReleaseProject } from './workspace-release-inputs.ts';
import { workspacePluginEntry } from './workspace-plugin-entry.ts';

interface ReleaseSource {
  readonly id: string;
  readonly files: readonly { readonly name: string; readonly sha256: string }[];
}
/** 先落盘整批基线；旧失败批次只能显式按当前输入接纳，不能补造首次运行证据。 */
export async function freezeReleaseSources(output: string, sources: readonly ReleaseSource[], options: {
  readonly resume?: boolean; readonly adoptCurrentInputs?: boolean;
}) {
  const path = join(output, 'source-baseline.json');
  let existing: Record<string, unknown> | null = null;
  try { existing = await readObject(path); }
  catch (error) { if (!object(error) || error.code !== 'ENOENT') throw error; }
  if (existing) {
    if (!options.resume) throw new Error('整批来源基线已存在，不能覆盖');
    if (existing.formatVersion !== 1 || !['initial', 'explicit_legacy_adoption'].includes(String(existing.origin)) ||
        JSON.stringify(existing.sources) !== JSON.stringify(sources))
      throw new Error('整批来源集合或源码与既有基线不同，拒绝接续');
    return existing;
  }
  if (options.resume && !options.adoptCurrentInputs) throw new Error('旧批次缺少首次来源基线，须显式接纳当前输入');
  const baseline = { formatVersion: 1, establishedAt: new Date().toISOString(),
    origin: options.resume ? 'explicit_legacy_adoption' : 'initial', sources };
  await writeFile(path, JSON.stringify(baseline, null, 2) + '\n', { flag: 'wx' });
  return baseline;
}

export function assembledBrowserManifest(project: ReleaseProject, files: readonly string[]) {
  const component: unknown = Array.isArray(project.manifest.components) ? project.manifest.components[0] : null;
  if (!object(component)) throw new Error('源清单缺少浏览器组件');
  return { ...project.manifest, components: [{ ...component, files,
    entrypoints: { any: { runtime: 'browser', path: 'dist/plugin-entry.js' } },
  }] };
}
/** 显式接续只复用与本次真实源码相同的已构建工程，不覆盖未知或改变的旧产物。 */
export async function verifyPreparedProject(project: ReleaseProject, buildRoot: string): Promise<boolean> {
  try { await lstat(buildRoot); }
  catch (error) { if (object(error) && error.code === 'ENOENT') return false; throw error; }
  const inputs = await releaseSourceIdentity(project.root), staged = await releaseSourceIdentity(buildRoot);
  if (JSON.stringify(inputs.filter((entry) => entry.name !== 'manifest.json')) !==
      JSON.stringify(staged.filter((entry) => entry.name !== 'manifest.json')))
    throw new Error('旧构建源码与本次工程不同，不能复用');
  const closure = await auditBrowserBundle(join(buildRoot, 'dist'));
  if (closure.computedImports.length) throw new Error('旧构建包含未确认的计算式导入');
  const files = closure.files.filter((file) => file.name !== 'plugin-build.json').map((file) => `dist/${file.name}`);
  const manifest = await readObject(join(buildRoot, 'manifest.json'));
  if (JSON.stringify(manifest) !== JSON.stringify(assembledBrowserManifest(project, files)) &&
      JSON.stringify(manifest) !== JSON.stringify(project.manifest))
    throw new Error('旧构建的清单或资源与当前来源不匹配，不能复用');
  if (await readFile(join(buildRoot, 'dist/plugin-entry.js'), 'utf8') !== workspacePluginEntry())
    throw new Error('旧构建的样式归属入口与本次工具不同，不能复用');
  return true;
}

/** 闭包检查后才派生清单；断在检查阶段的自有暂存可完成封口，不重建或覆盖未知输入。 */
export async function sealPreparedProject(project: ReleaseProject, buildRoot: string, closure: BundleClosure) {
  if (closure.computedImports.length) throw new Error('构建包含尚未确认的计算式模块导入');
  const files = closure.files.filter((file) => file.name !== 'plugin-build.json').map((file) => `dist/${file.name}`);
  if (files.length > 256) throw new Error('组件资源数量超过单清单限制，需要先明确资源分组');
  const expected = assembledBrowserManifest(project, files), actual = await readObject(join(buildRoot, 'manifest.json'));
  const derived = JSON.stringify(expected);
  const seal = JSON.stringify(actual) !== derived;
  if (seal && JSON.stringify(actual) !== JSON.stringify(project.manifest)) throw new Error('暂存清单发生未知变化，拒绝覆盖');
  const closureFile = join(buildRoot, 'bundle-closure.json'), text = JSON.stringify(closure, null, 2) + '\n';
  try {
    if (await readFile(closureFile, 'utf8') !== text) throw new Error('既有资源闭包记录与本次不同，拒绝覆盖');
  } catch (error) {
    if (!object(error) || error.code !== 'ENOENT') throw error;
    await writeFile(closureFile, text, { flag: 'wx' });
  }
  if (seal) await writeFile(join(buildRoot, 'manifest.json'), JSON.stringify(expected, null, 2) + '\n');
  return files;
}

export async function completedPluginRelease(directory: string, project: ReleaseProject, buildRoot: string) {
  let report: Record<string, unknown>;
  try { report = await readObject(join(directory, 'pack-report.json')); }
  catch (error) { if (object(error) && error.code === 'ENOENT') return null; throw error; }
  if (report.id !== project.id || report.version !== project.version ||
      typeof report.archive !== 'string' || !inside(directory, report.archive) ||
      typeof report.sha256 !== 'string' || typeof report.size !== 'number')
    throw new Error('CLI 没有返回匹配身份的真实发布报告');
  const bytes = await readFile(report.archive);
  if (bytes.length !== report.size || hash(bytes) !== report.sha256) throw new Error('发布报告与最终归档字节不匹配');
  let expanded = 0, members = 0;
  const delivered = unzipSync(bytes, { filter: (entry) => {
    expanded += entry.originalSize;
    if (++members > 512 || expanded > 64 * 1024 * 1024) throw new Error('旧发布 ZIP 超过接续校验限额');
    return true;
  } });
  const declaration = delivered['release.json'];
  const release: unknown = declaration ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(declaration)) : null;
  if (!object(release) || release.id !== project.id || release.version !== project.version ||
      !Array.isArray(release.components) || release.components.length !== 1)
    throw new Error('最终 ZIP 的发布身份与当前工程不匹配');
  const packaged: unknown = release.components[0];
  if (!object(packaged) || packaged.id !== project.id || packaged.version !== project.version ||
      packaged.kind !== 'browser' || !Array.isArray(packaged.variants) || packaged.variants.length !== 1)
    throw new Error('最终 ZIP 的组件身份不匹配');
  const variant: unknown = packaged.variants[0];
  if (!object(variant) || variant.format !== 'tgz' || variant.platform !== 'any' ||
      typeof variant.sha256 !== 'string' || variant.path !== `blobs/${variant.sha256}` || typeof variant.size !== 'number')
    throw new Error('最终 ZIP 的组件资源声明无效');
  const payload = delivered[`blobs/${variant.sha256}`];
  if (!payload || payload.length !== variant.size || hash(payload) !== variant.sha256)
    throw new Error('最终 ZIP 的真实组件与资源摘要不匹配');
  const closure = await auditBrowserBundle(join(buildRoot, 'dist'));
  const expected = new Map(closure.files.filter((file) => file.name !== 'plugin-build.json')
    .map((file) => [`package/dist/${file.name}`, file.sha256]));
  const component = await readFile(join(directory, 'components', `${project.id}.tgz`));
  if (hash(component) !== variant.sha256) throw new Error('最终 ZIP 的真实组件与本次构建组件不同');
  if (component.length > 32 * 1024 * 1024) throw new Error('旧组件归档超过接续校验限额');
  for await (const entry of extract()([gunzipSync(component, { maxOutputLength: 64 * 1024 * 1024 })])) {
    if (!entry.header.name.startsWith('package/dist/')) continue;
    const digest = expected.get(entry.header.name);
    if (!digest || entry.header.type !== 'file') throw new Error('旧发布组件资源与本次构建不同');
    const chunks: Uint8Array[] = [];
    for await (const chunk of entry.body) chunks.push(chunk.subarray());
    if (hash(Buffer.concat(chunks)) !== digest) throw new Error('旧发布组件资源与本次构建不同');
    expected.delete(entry.header.name);
  }
  if (expected.size) throw new Error('旧发布组件缺少本次构建资源');
  return { id: project.id, version: project.version, archive: report.archive, bytes: bytes.length, sha256: report.sha256 };
}
