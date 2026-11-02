export interface BrowserPluginBuildOptions {
  readonly root: string;
  readonly entry?: string;
  readonly outputDir: string;
  /** 仅精确匹配公开包说明符，值须为实际发行包中的绝对模块路径。 */
  readonly dependencies?: Readonly<Record<string, string>>;
  /** 公开 Tailwind 主题指令文本，工具不读取宿主主题。 */
  readonly theme?: string;
  readonly signal?: AbortSignal;
}

export interface PluginBuildFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
export interface PluginModuleImports {
  readonly file: string;
  readonly static: readonly string[];
  readonly dynamic: readonly string[];
  readonly assets: readonly string[];
}
export interface BrowserPluginBuildResult {
  readonly formatVersion: 1;
  readonly tool: { readonly name: '@deviceforge/plugin-tools'; readonly version: '0.1.0' };
  readonly buildId: string;
  readonly root: string;
  readonly entry: string;
  readonly outputDir: string;
  readonly entryFile: 'index.js';
  readonly stylesFile: 'styles.js';
  readonly reportFile: 'plugin-build.json';
  readonly css: readonly string[];
  readonly hostImports: readonly string[];
  /** 包含 ESM、工作线程与资源，不包含报告本身，避免自引用摘要。 */
  readonly files: readonly PluginBuildFile[];
  readonly imports: readonly PluginModuleImports[];
}

export interface BuildInput {
  readonly root: string;
  readonly entry: string;
  readonly outputDir: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly dependencyRoots: readonly string[];
  readonly theme: string;
}
export interface WorkerBuildInput extends BuildInput { readonly stage: string }
export interface WorkerBuildResult {
  readonly css: readonly string[];
  readonly imports: readonly PluginModuleImports[];
}

export const HOST_IMPORTS = [
  'deviceforge-host', 'react', 'react/jsx-runtime', 'react/jsx-dev-runtime',
  'react-dom', 'react-dom/client',
] as const;
