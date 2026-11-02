import { realpath, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isBuiltin } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { build } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { codePath, inside, record, rejectUnknownSharedModule, sharedModule } from './paths.js';
import { inspectOutput, outputFiles } from './imports.js';
import { stylesDeclaration, stylesModule } from './styles.js';
import type { WorkerBuildInput, WorkerBuildResult } from './types.js';

function inputValue(value: unknown): value is WorkerBuildInput {
  return record(value) && typeof value.root === 'string' && typeof value.entry === 'string' &&
    typeof value.outputDir === 'string' && typeof value.stage === 'string' && typeof value.theme === 'string' &&
    record(value.dependencies) && Object.values(value.dependencies).every((item) => typeof item === 'string') &&
    Array.isArray(value.dependencyRoots) && value.dependencyRoots.every((item) => typeof item === 'string');
}
function boundaryPlugin(input: WorkerBuildInput, worker = false): Plugin {
  const files = new Set(Object.values(input.dependencies).map(codePath));
  return {
    name: 'deviceforge-public-dependencies', enforce: 'pre',
    async resolveId(id, importer) {
      if (id.startsWith('\0')) return null;
      rejectUnknownSharedModule(id);
      if (sharedModule(id)) {
        if (worker) throw new Error(`Worker 不能读取页面 importmap 共享模块：${id}`);
        return { id, external: true };
      }
      if (isBuiltin(id)) throw new Error(`浏览器插件不能依赖 Node 内置模块：${id}`);
      const explicit = input.dependencies[id];
      if (explicit) return codePath(explicit);
      if (id.startsWith('virtual:deviceforge-')) return null;
      const resolved = await this.resolve(id, importer, { skipSelf: true });
      if (!resolved) return null;
      if (resolved.external) throw new Error(`未声明的外部依赖：${id}`);
      const path = resolved.id.split('?')[0];
      if (!path || path.startsWith('\0') || !isAbsolute(path)) return resolved;
      const actual = await realpath(path);
      const normalized = codePath(actual);
      if (/\/node_modules\/(?:react|react-dom)\//u.test(normalized))
        throw new Error(`共享 React 必须通过宿主裸导入使用，不能内联文件路径：${id}`);
      if (inside(input.root, actual) || files.has(normalized) ||
          input.dependencyRoots.some((root) => inside(root, actual)) || normalized.includes('/node_modules/'))
        return resolved;
      throw new Error(`依赖超出工程和公开发行包边界：${id}`);
    },
  };
}
function tailwindEntry(input: WorkerBuildInput): Plugin {
  const id = codePath(join(input.root, '__deviceforge_tooling_tailwind.css'));
  const cssPath = (value: string) => codePath(fileURLToPath(import.meta.resolve(value)));
  const theme = cssPath('tailwindcss/theme.css'), utilities = cssPath('tailwindcss/utilities.css');
  const sources = [...new Set([input.root, ...input.dependencyRoots])].map((root) =>
    `@source ${JSON.stringify(codePath(root))};`).join('\n');
  const dark = /@custom-variant\s+dark\b/u.test(input.theme) ? '' : '@custom-variant dark (&:where(.dark, .dark *));';
  const css = `@layer theme, base, components, utilities;
@import ${JSON.stringify(theme)} layer(theme);
@import ${JSON.stringify(utilities)} layer(utilities) source(none);
${sources}
@source not ${JSON.stringify(codePath(input.outputDir))};
${dark}
${input.theme}
`;
  return {
    name: 'deviceforge-generated-utilities', enforce: 'pre',
    resolveId(source) { if (source === 'virtual:deviceforge-tailwind.css') return id; return null; },
    load(source) { if (source === id) return css; return null; },
    transform(code, source) {
      if (codePath(source) === codePath(input.entry))
        return { code: `import "virtual:deviceforge-tailwind.css";\n${code}`, map: null };
      return null;
    },
  };
}

async function compile(input: WorkerBuildInput): Promise<WorkerBuildResult> {
  const outputs = {
    entryFileNames: 'index.js', chunkFileNames: 'chunks/[name]-[hash].js',
    assetFileNames: 'assets/[name]-[hash][extname]', format: 'es' as const,
  };
  await build({
    root: input.root, configFile: false, envFile: false, mode: 'production',
    base: './', publicDir: false, logLevel: 'silent', clearScreen: false,
    cacheDir: join(input.stage, '.vite-cache'),
    plugins: [tailwindEntry(input), boundaryPlugin(input), react(), tailwind({ optimize: { minify: false } })],
    css: { postcss: { plugins: [] } },
    resolve: { conditions: ['browser', 'module', 'import', 'production'], tsconfigPaths: false },
    build: {
      outDir: input.stage, emptyOutDir: false, copyPublicDir: false, write: true,
      minify: false, target: 'es2022', cssCodeSplit: false, assetsInlineLimit: 0,
      modulePreload: false, reportCompressedSize: false,
      rolldownOptions: {
        input: input.entry, preserveEntrySignatures: 'strict',
        external: (id) => sharedModule(id), output: outputs,
      },
    },
    worker: {
      format: 'es',
      plugins: () => [boundaryPlugin(input, true), react()],
      rolldownOptions: { external: (id) => {
        if (sharedModule(id)) throw new Error(`Worker 不能读取页面 importmap 共享模块：${id}`);
        return false;
      }, output: {
        chunkFileNames: outputs.chunkFileNames, assetFileNames: outputs.assetFileNames,
      } },
    },
  });
  const css = (await outputFiles(input.stage)).filter((file) => file.endsWith('.css'));
  await writeFile(join(input.stage, 'styles.js'), stylesModule(css), 'utf8');
  await writeFile(join(input.stage, 'styles.d.ts'), stylesDeclaration, 'utf8');
  return { css, imports: await inspectOutput(input.stage) };
}

if (!process.send) throw new Error('插件构建进程需要调用方建立 IPC 通道');
process.once('message', (input: unknown) => {
  const respond = (message: unknown) => {
    process.send?.(message, () => { process.disconnect(); });
  };
  if (!inputValue(input)) { respond({ ok: false, message: '插件构建进程输入无效' }); return; }
  void compile(input).then(
    (result) => respond({ ok: true, result }),
    (error: unknown) => respond({ ok: false, message: error instanceof Error ? error.message : '插件构建失败' }),
  );
});
