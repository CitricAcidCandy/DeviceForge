import { packNativePlugins } from './native-plugin-package.mjs';

try {
  const packages = await packNativePlugins({ selected: process.argv.slice(2) });
  for (const pkg of packages)
    console.log(`原生插件包已生成：${pkg.id}@${pkg.version}，${pkg.archive}，${pkg.size} 字节`);
} catch (error) {
  console.error(`原生插件打包失败：${error.message}`);
  process.exitCode = 1;
}
