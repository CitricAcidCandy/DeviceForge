import { fileURLToPath } from 'node:url';
import { buildBrowserPlugin } from '@deviceforge/plugin-tools';

const result = await buildBrowserPlugin({
  root: fileURLToPath(new URL('../', import.meta.url)),
  entry: 'browser/index.ts',
  outputDir: fileURLToPath(new URL('../dist/browser', import.meta.url)),
  dependencies: {
    '@deviceforge/plugin-sdk': fileURLToPath(import.meta.resolve('@deviceforge/plugin-sdk')),
    '@deviceforge/plugin-sdk/json': fileURLToPath(import.meta.resolve('@deviceforge/plugin-sdk/json')),
  },
});
console.log(`浏览器入口已生成，共 ${result.files.length} 个文件；构建标识 ${result.buildId}`);
