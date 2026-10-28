import { readdir, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { compile } from 'tailwindcss';

const frontend = fileURLToPath(new URL('../', import.meta.url));
const plugin = fileURLToPath(new URL('../../examples/browser-debugger/', import.meta.url));
const require = createRequire(import.meta.url);

async function sources(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw new Error('插件源码不得通过链接引入工作区之外的内容');
    const path = join(directory, item.name);
    if (item.isDirectory()) result.push(...await sources(path));
    else if (/\.tsx?$/.test(item.name) && item.name !== 'style.ts') result.push(path);
  }
  return result;
}

/** 只构建官方插件，不安装、不发布，不替换用户的宿主与前端服务。 */
export async function buildDebuggerPlugin() {
  const files = await sources(join(plugin, 'src'));
  if (files.length === 0) throw new Error('官方 Debugger 插件源码尚未准备好');
  const texts = await Promise.all(files.map(path => readFile(path, 'utf8')));
  const theme = await readFile(require.resolve('tailwindcss/theme.css'), 'utf8');
  const compiler = await compile(`${theme.replace('@theme default', '@theme inline')}\n@scope ([data-deviceforge-debugger]) { @tailwind utilities; }`);
  const candidates = [...new Set(texts.join('\n').split(/[\s"'`<>]+/u).filter(value => value.length > 0 && value.length <= 256))];
  const css = compiler.build(candidates).replace(/<\/style/gi, '<\\/style');
  await writeFile(join(plugin, 'src/style.ts'),
    `// 由官方插件构建脚本从 Tailwind 工具类生成，请勿手改。\nexport const DEBUGGER_STYLE = ${JSON.stringify(css)};\n`, 'utf8');
  const entries = await readdir(join(plugin, 'src'));
  const entry = entries.includes('index.tsx') ? 'index.tsx' : 'index.ts';
  const packageText = await readFile(join(plugin, 'package.json'), 'utf8');
  const manifest: unknown = JSON.parse(packageText);
  if (!manifest || typeof manifest !== 'object' || !('version' in manifest) || typeof manifest.version !== 'string')
    throw new Error('Debugger 包清单缺少版本');
  const version = manifest.version;
  await build({ configFile: false, root: frontend, plugins: [react()],
    build: { outDir: resolve(plugin, 'dist'), emptyOutDir: false, sourcemap: true, minify: true,
      lib: { entry: resolve(plugin, 'src', entry), formats: ['es'], fileName: () => 'index.js' },
      rolldownOptions: { external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'deviceforge-host'] } },
  });
  const bytes = await readFile(join(plugin, 'dist/index.js'));
  const identity = { id: 'deviceforge_debugger', version, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    built_at: new Date().toISOString(), source_files: files.length,
    validation: '构建身份；不代表本机浏览器或生产验收完成' };
  await mkdir(join(plugin, 'dist'), { recursive: true });
  await copyFile(join(dirname(require.resolve('tailwindcss/package.json')), 'LICENSE'), join(plugin, 'dist/TAILWIND-LICENSE.txt'));
  await writeFile(join(plugin, 'dist/build.json'), JSON.stringify(identity, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(identity, null, 2));
  return identity;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await buildDebuggerPlugin();
