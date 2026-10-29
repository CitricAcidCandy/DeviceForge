import { existsSync, realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { inspectSource } from './source-dependencies.ts';

const ignoredDirectories = new Set(['node_modules', 'dist', 'build', 'coverage', 'artifacts', '.git', 'tests', '__tests__']);
const sourcePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/;
function inside(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target));
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}
function canonical(path: string): string {
  return existsSync(path) ? realpathSync.native(path) : resolve(path);
}
function localSpecifier(value: string): boolean {
  return value.startsWith('.') || isAbsolute(value) || /^[a-z]:[\\/]/i.test(value);
}

/** 扫描真正的独立插件源码；不把空目录检查当作官方业务已完成迁移的证据。 */
export async function checkPluginBoundaries(root = fileURLToPath(new URL('../', import.meta.url))): Promise<string[]> {
  const pluginsRoot = join(root, 'plugins');
  if (!existsSync(pluginsRoot)) return [];
  const hostSource = canonical(join(root, 'src'));
  const failures: string[] = [];
  const configs = new Map<string, ts.CompilerOptions>();
  const report = (file: string, line: number, message: string) => {
    failures.push(`${relative(root, file).split(sep).join('/')}:${line}: ${message}`);
  };
  function reason(target: string, project: string): string | null {
    const actual = canonical(target);
    if (inside(hostSource, actual) || inside(join(root, 'src'), target)) return '独立插件禁止依赖宿主私有源码';
    if (!inside(canonical(project), actual)) return '独立插件依赖越过自身工程边界，须使用公开发行说明符';
    return null;
  }
  function options(configPath: string, project: string): ts.CompilerOptions {
    const cached = configs.get(configPath);
    if (cached) return cached;
    const input = ts.readConfigFile(configPath, ts.sys.readFile);
    if (input.error) {
      report(configPath, 1, '插件 TypeScript 配置无法读取');
      configs.set(configPath, {});
      return {};
    }
    const parsed = ts.parseJsonConfigFileContent(input.config, ts.sys, dirname(configPath), undefined, configPath);
    for (const error of parsed.errors) {
      // 目录尚无源码不属于配置边界错误，正式编译时仍由 TypeScript 报告。
      if (error.code !== 18003 && error.code !== 18002)
        report(configPath, 1, `插件 TypeScript 配置无效：${ts.flattenDiagnosticMessageText(error.messageText, ' ')}`);
    }
    const compiler = parsed.options;
    if (compiler.baseUrl) {
      const issue = reason(compiler.baseUrl, project);
      if (issue) report(configPath, 1, `baseUrl：${issue}`);
    }
    for (const [alias, mappings] of Object.entries(compiler.paths ?? {})) {
      for (const mapping of mappings) {
        const aliasRoot = compiler.baseUrl ?? (typeof compiler.pathsBasePath === 'string' ? compiler.pathsBasePath : dirname(configPath));
        const target = resolve(aliasRoot, mapping.replaceAll('*', '__plugin_path__'));
        const issue = reason(target, project);
        if (issue) report(configPath, 1, `paths ${alias}：${issue}`);
      }
    }
    for (const directory of compiler.rootDirs ?? []) {
      const issue = reason(directory, project);
      if (issue) report(configPath, 1, `rootDirs：${issue}`);
    }
    for (const reference of parsed.projectReferences ?? []) {
      const issue = reason(reference.path, project);
      if (issue) report(configPath, 1, `references：${issue}`);
    }
    configs.set(configPath, compiler);
    return compiler;
  }
  function sourceOptions(file: string, project: string): ts.CompilerOptions {
    let directory = dirname(file);
    while (inside(project, directory)) {
      const configPath = join(directory, 'tsconfig.json');
      if (existsSync(configPath)) return options(configPath, project);
      if (directory === project) break;
      directory = dirname(directory);
    }
    return { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext };
  }
  function checkDependency(file: string, line: number, value: string, project: string, compiler: ts.CompilerOptions): void {
    if (/^(?:file:|https?:|data:|blob:)/i.test(value) || value.startsWith('@/') || value.startsWith('src/')) {
      report(file, line, '独立插件不得通过宿主别名、源码路径或 URL 引用宿主私有实现');
      return;
    }
    const resolved = ts.resolveModuleName(value, file, compiler, ts.sys).resolvedModule;
    if (resolved) {
      const target = canonical(resolved.resolvedFileName);
      if (inside(hostSource, target)) report(file, line, '独立插件禁止依赖宿主私有源码');
      else if (!resolved.isExternalLibraryImport && !/[\\/]node_modules[\\/]/.test(target)) {
        const issue = reason(target, project);
        if (issue) report(file, line, issue);
      }
      return;
    }
    if (localSpecifier(value)) {
      const issue = reason(resolve(dirname(file), value), project);
      if (issue) report(file, line, issue);
    }
  }
  async function inspect(file: string, project: string): Promise<void> {
    const text = await readFile(file, 'utf8');
    const compiler = sourceOptions(file, project);
    const inspection = inspectSource(text, file);
    for (const issue of inspection.issues) {
      if (issue === '动态导入必须使用可检查的字面量' || issue === '浏览器源码不得使用 require') report(file, 1, issue);
    }
    for (const dependency of inspection.dependencies)
      checkDependency(file, dependency.line, dependency.value, project, compiler);
    // import = require、三斜线引用均属于真实编译依赖，不能被 ES import 检查遗漏。
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const reference of source.referencedFiles)
      checkDependency(file, source.getLineAndCharacterOfPosition(reference.pos).line + 1,
        reference.fileName.startsWith('.') ? reference.fileName : `./${reference.fileName}`, project, compiler);
    function visit(node: ts.Node): void {
      if (ts.isImportEqualsDeclaration(node)) report(file, source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        '浏览器源码不得使用 require 或 import = require');
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if ((ts.isIdentifier(callee) && callee.text === 'createRequire') ||
            (ts.isPropertyAccessExpression(callee) && callee.name.text === 'createRequire'))
          report(file, source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            '浏览器源码不得创建 require 以绕过可检查的导入');
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  async function scan(directory: string, inheritedProject: string | null): Promise<void> {
    let project = inheritedProject;
    if (directory !== pluginsRoot && (project === null || existsSync(join(directory, 'manifest.json')) || existsSync(join(directory, 'package.json'))))
      project = directory;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (ignoredDirectories.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        report(path, 1, '插件源码不得通过链接跨工程引用');
        continue;
      }
      if (entry.isDirectory()) { await scan(path, project); continue; }
      const actualProject = project ?? pluginsRoot;
      if (entry.name === 'tsconfig.json') options(path, actualProject);
      if (sourcePattern.test(entry.name) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name))
        await inspect(path, actualProject);
    }
  }
  await scan(pluginsRoot, null);
  return failures;
}
