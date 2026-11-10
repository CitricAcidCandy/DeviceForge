import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { buildBrowserPlugin } from '@deviceforge/plugin-tools';
import { auditBrowserBundle } from './browser-bundle-closure.ts';
import {
  hash, inside, object, releaseProjects, releaseSourceIdentity,
} from './workspace-release-inputs.ts';
import { prepareReleasePackages } from './workspace-release-packages.ts';
import { publicWorkspaceTheme } from './workspace-ui-theme.ts';
import { workspacePluginEntry } from './workspace-plugin-entry.ts';
import { completedPluginRelease, freezeReleaseSources, sealPreparedProject, verifyPreparedProject } from './workspace-release-resume.ts';
import { readWorkspaceBuildTool } from './workspace-build-tool.ts';
// 发布编排复用CLI同一准备提交协议；不重新实现归档、校验或目录迁移。
import { finalizePreparedPlugin } from '../../cli/src/plugin-authoring/prepared.mjs';

const execute = promisify(execFile);
export interface WorkspacePluginBuildOptions {
  readonly frontend: string;
  readonly output: string;
  readonly signal: AbortSignal;
  readonly resume?: boolean;
  readonly adoptCurrentInputs?: boolean;
}

/** 只生成独立浏览器组件与完整发布，不安装插件、构建宿主或启动服务。 */
export async function buildWorkspacePlugins(options: WorkspacePluginBuildOptions) {
  const frontend = resolve(options.frontend), output = resolve(options.output);
  if (!inside(join(frontend, 'artifacts'), output)) throw new Error('官方发行输出必须在前端 artifacts 的新子目录内');
  options.signal.throwIfAborted();
  const projects = await releaseProjects(join(frontend, 'plugins'));
  const sources = await Promise.all(projects.map(async (project) => ({
    id: project.id, files: await releaseSourceIdentity(project.root),
  })));
  await mkdir(join(frontend, 'artifacts'), { recursive: true });
  if (!options.resume) await mkdir(output, { recursive: false });
  else {
    try { await readFile(join(output, 'build-report.json')); throw new Error('此批发行已完成，不重复接续或覆盖'); }
    catch (error) { if (!object(error) || error.code !== 'ENOENT') throw error; }
    await readFile(join(output, 'build-failure.json'));
  }
  try {
    const baseline = await freezeReleaseSources(output, sources, options);
    const prepareRoot = options.resume ? join(output, `resume-inputs-${Date.now()}`) : output;
    const prepared = await prepareReleasePackages(frontend, prepareRoot, projects, options.signal);
    if (options.resume) {
      for (const item of prepared.packages) {
        const prior = join(output, 'development-packages', basename(item.archive));
        if (hash(await readFile(prior)) !== item.sha256) throw new Error('公开依赖发行字节已改变，不能接续此批旧构建');
      }
    }
    const tool = await readWorkspaceBuildTool(frontend);
    const toolArchive = join(output, 'development-packages', basename(tool.archive));
    if (!options.resume) await copyFile(tool.archive, toolArchive, 1);
    let toolBytes: Buffer;
    try { toolBytes = await readFile(toolArchive); }
    catch (error) { throw new Error('此批缺少当前版本的构建工具归档，不能接续旧批次', { cause: error }); }
    if (hash(toolBytes) !== hash(tool.content)) throw new Error('构建工具身份已改变，不能接续旧批次');
    const theme = publicWorkspaceTheme(await readFile(join(frontend, 'src/app/styles.css'), 'utf8'));
    const themeFile = join(output, 'development-packages/deviceforge-ui-theme.json');
    if (!options.resume) await writeFile(themeFile, JSON.stringify(theme, null, 2) + '\n', { flag: 'wx' });
    else if (await readFile(themeFile, 'utf8') !== JSON.stringify(theme, null, 2) + '\n')
      throw new Error('公开主题已改变，不能接续旧批次');
    await mkdir(join(output, 'releases'), { recursive: true });
    await mkdir(join(output, 'builds'), { recursive: true });
    const releases: {
      id: string; version: string; archive: string; bytes: number; sha256: string;
      files: number; sharedImports: readonly string[];
    }[] = [];
    for (const project of projects) {
      options.signal.throwIfAborted();
      const buildRoot = join(output, 'builds', project.id);
      const reuse = options.resume && await verifyPreparedProject(project, buildRoot);
      if (!reuse) {
        await mkdir(buildRoot, { recursive: false });
        const source = sources.find((entry) => entry.id === project.id);
        if (!source) throw new Error('源身份快照缺少本次构建工程');
        for (const input of source.files) {
          const target = join(buildRoot, input.name);
          await mkdir(dirname(target), { recursive: true });
          await copyFile(join(project.root, input.name), target, 1);
        }
        await buildBrowserPlugin({ root: buildRoot, entry: project.entry.slice(project.root.length + 1),
          outputDir: join(buildRoot, 'dist'), dependencies: prepared.imports, theme: theme.theme,
          signal: options.signal,
        });
        await writeFile(join(buildRoot, 'dist/plugin-entry.js'), workspacePluginEntry(), { flag: 'wx' });
      }
      const closure = await auditBrowserBundle(join(buildRoot, 'dist'));
      const files = await sealPreparedProject(project, buildRoot, closure);
      const destination = join(output, 'releases', project.id);
      let release = options.resume ? await completedPluginRelease(destination, project, buildRoot) : null;
      if (!release) {
        const packed = await execute(process.execPath, [join(frontend, '../cli/bin/deviceforge.mjs'),
          'plugin', 'pack', join(buildRoot, 'manifest.json'), '--out', destination, '--prepare-only', 'true'], {
          cwd: frontend, signal: options.signal, timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true,
        });
        const prepared: unknown = JSON.parse(packed.stdout);
        if (!object(prepared) || prepared.state !== 'prepared' || typeof prepared.receipt !== 'string' ||
            typeof prepared.target !== 'string' || prepared.target !== destination ||
            dirname(prepared.receipt) !== dirname(destination)) throw new Error('CLI没有返回本次所属的真实准备回执');
        await finalizePreparedPlugin(prepared.receipt, { signal: options.signal });
        release = await completedPluginRelease(destination, project, buildRoot);
      }
      if (!release) throw new Error('打包结束后没有真实发布回执');
      releases.push({ ...release, files: files.length, sharedImports: closure.sharedImports });
      console.log(`已核对 ${project.id}：${release.bytes} 字节；静态资源 ${files.length} 项`);
    }
    const current = await Promise.all(projects.map(async (project) => ({
      id: project.id, files: await releaseSourceIdentity(project.root),
    })));
    if (JSON.stringify(current) !== JSON.stringify(sources)) throw new Error('构建期间源文件发生变化，保留诊断但不签发完成报告');
    const report = { formatVersion: 1, builtAt: new Date().toISOString(), kind: 'official_browser_plugin_releases',
      sourceBaseline: baseline,
      validation: '本地构建、静态资源闭包及 CLI 归档；未安装、未启动服务、未执行浏览器或设备验收',
      tool: { name: tool.name, version: tool.version, archive: toolArchive,
        bytes: toolBytes.length, sha256: hash(toolBytes) },
      theme: { file: themeFile, sha256: hash(await readFile(themeFile)) }, sources,
      developmentPackages: prepared.packages.map(({ name, version, archive, bytes, sha256 }) =>
        ({ name, version, archive, bytes, sha256 })), releases };
    await writeFile(join(output, 'build-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    return report;
  } catch (error) {
    await writeFile(join(output, options.resume ? `resume-failure-${Date.now()}.json` : 'build-failure.json'), JSON.stringify({ state: 'failed',
      message: error instanceof Error ? error.message : '发行未完成',
      validation: '保留本次独占制品用于诊断，不自动删除或继续发布' }, null, 2) + '\n', { flag: 'wx' });
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const frontend = resolve(import.meta.dirname, '..');
  const output = process.argv[2] ? resolve(process.argv[2])
    : join(frontend, 'artifacts', `open-workspace-plugins-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const report = await buildWorkspacePlugins({ frontend, output, signal: AbortSignal.timeout(10 * 60 * 1000),
    ...(process.argv.includes('--resume') ? { resume: true } : {}),
    ...(process.argv.includes('--adopt-current-inputs') ? { adoptCurrentInputs: true } : {}),
  });
  console.log(JSON.stringify({ output, releases: report.releases.length,
    developmentPackages: report.developmentPackages.length, validation: report.validation }, null, 2));
}
