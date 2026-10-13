import { readdir } from 'node:fs/promises';
import { readJson, regularFile } from '../cli/src/paths.mjs';
import { loadNativePluginAssets } from './native-plugin-assets.mjs';

// 正式清单优先；只在文件不存在时兼容旧示例，损坏的正式清单不能被掩盖。
export async function loadNativePluginSource(directory) {
  let manifestPath;
  try { manifestPath = await regularFile(directory, 'manifest.json'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    manifestPath = await regularFile(directory, 'manifest.example.json');
  }
  const manifest = await readJson(manifestPath);
  const entries = await readdir(directory);
  const configurationTemplates = [];
  for (const name of entries.filter((name) => name.endsWith('.example.json') && name !== 'manifest.example.json').sort()) {
    const source = await regularFile(directory, name);
    // 只分发受限的公开 JSON 示例，不采集部署者配置及凭据。
    await readJson(source);
    configurationTemplates.push({ name, source });
  }
  const assets = await loadNativePluginAssets(directory);
  return { manifest, configurationTemplates, assets };
}
