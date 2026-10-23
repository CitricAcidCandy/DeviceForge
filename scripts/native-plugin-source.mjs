import { copyFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, regularFile } from '../cli/src/paths.mjs';
import { loadNativePluginAssets } from './native-plugin-assets.mjs';
import { readMarketMetadata } from '../cli/src/plugin-package.mjs';

// 正式清单优先；只在文件不存在时兼容旧示例，损坏的正式清单不能被掩盖。
export async function loadNativePluginSource(directory) {
  let manifestPath;
  try {
    manifestPath = await regularFile(directory, 'manifest.json');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    manifestPath = await regularFile(directory, 'manifest.example.json');
  }
  const manifest = await readJson(manifestPath);
  const entries = await readdir(directory);
  const configurationTemplates = [];
  for (const name of entries
    .filter((name) => name.endsWith('.example.json') && name !== 'manifest.example.json')
    .sort()) {
    const source = await regularFile(directory, name);
    // 只分发受限的公开 JSON 示例，不采集部署者配置及凭据。
    await readJson(source);
    configurationTemplates.push({ name, source });
  }
  if (manifest.configuration !== undefined) {
    const configuration = manifest.configuration;
    if (
      !configuration ||
      !Number.isInteger(configuration.version) ||
      configuration.version < 1 ||
      configuration.version > 0xffffffff ||
      !configuration.schema ||
      configuration.schema.type !== 'object' ||
      !configuration.defaults ||
      Array.isArray(configuration.defaults) ||
      typeof configuration.defaults !== 'object' ||
      !['next_invocation', 'plugin_reload'].includes(configuration.apply_policy)
    ) {
      throw new Error('插件配置声明须包含正整数版本、对象 schema、默认对象和生效策略');
    }
    if (configuration.legacy_filename !== undefined) {
      const legacy = configuration.legacy_filename;
      if (typeof legacy !== 'string' || !/^[a-z0-9][a-z0-9._-]*\.json$/.test(legacy))
        throw new Error('插件旧配置名须为普通 JSON 文件名');
      const template = legacy.replace(/\.json$/, '.example.json');
      if (!configurationTemplates.some((entry) => entry.name === template))
        throw new Error(`插件配置声明缺少公开模板：${template}`);
    }
  }
  const assets = await loadNativePluginAssets(directory);
  const marketMetadata = await readMarketMetadata(directory, manifest);
  return { manifest, configurationTemplates, assets, marketMetadata };
}

// 打包器与验证共用模板复制入口，实际配置与凭据始终留在部署目录。
export async function copyNativePluginConfiguration(plan, directory) {
  for (const template of plan.configurationTemplates) {
    await copyFile(template.source, join(directory, 'bin', template.name));
  }
}
