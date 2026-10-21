import type { ProductServices } from '../../../app/product/services.ts';
import { ApiError } from '../../../services/api/index.ts';
import { readonlyIssues } from '../../../utils/schema.ts';
import { runUploadPreparation } from '../upload-preparation/index.ts';
import type { PreparationExecutor } from '../upload-preparation/index.ts';
import {
  digestLocalFile,
  mergeConfigurationPreview,
  parseLocalConfiguration,
  readImportJson,
} from './rules.ts';
import type { LocalImportKind, LocalImportPreview, LocalToolManifest } from './types.ts';

export interface LocalImportPorts {
  readonly packages: Pick<ProductServices['runtime']['pluginPackages'], 'upload'>;
  readonly serverPlugins: Pick<ProductServices['runtime']['serverPlugins'], 'refresh'>;
  readonly artifacts: Pick<ProductServices['runtime']['artifacts'], 'upload'>;
  readonly tools: Pick<ProductServices['toolSupply'], 'importLocal'>;
  readonly settings: Pick<ProductServices['settings'], 'list' | 'import'>;
  readonly configurations: Pick<ProductServices['pluginConfigurations'], 'get' | 'save'>;
}
export function localImportPorts(services: ProductServices): LocalImportPorts {
  return {
    packages: services.runtime.pluginPackages,
    serverPlugins: services.runtime.serverPlugins,
    artifacts: services.runtime.artifacts,
    tools: services.toolSupply,
    settings: services.settings,
    configurations: services.pluginConfigurations,
  };
}

export async function previewLocalImport(
  ports: LocalImportPorts,
  input: {
    readonly kind: LocalImportKind;
    readonly file: File;
    readonly manifest: LocalToolManifest | null;
    readonly moduleId: string;
  },
  signal: AbortSignal,
  prepare: PreparationExecutor = runUploadPreparation,
): Promise<LocalImportPreview> {
  const { kind, file } = input;
  signal.throwIfAborted();
  if (kind === 'plugin') {
    if (!/\.(zip|tgz|tar\.gz)$/i.test(file.name)) throw new Error('插件请选择 ZIP 或 TGZ 便携包');
    const prepared = await prepare(
      {
        kind: 'plugin',
        selection: { mode: 'archive', name: file.name, files: [{ path: file.name, file }] },
      },
      signal,
    );
    const inspection = 'inspection' in prepared ? prepared.inspection : prepared;
    if (!inspection.identity) throw new Error('插件包缺少有效运行清单');
    const sha256 = await digestLocalFile(file, signal);
    return {
      kind,
      file,
      plugin: inspection.identity,
      sha256,
      mediaType: /\.(tgz|tar\.gz)$/i.test(file.name) ? 'application/gzip' : 'application/zip',
      target: `${inspection.identity.kind === 'server' ? '服务器' : '浏览器'}插件 ${inspection.identity.id}`,
      summary: `版本 ${inspection.identity.version}，${inspection.files.length} 个文件；安装后请到已安装目录显式启用。`,
    };
  }
  if (kind === 'tool') {
    if (!/\.zip$/i.test(file.name)) throw new Error('工具归档请选择 ZIP 文件');
    const manifest = input.manifest;
    const module = manifest?.modules.find((item) => item.id === input.moduleId);
    if (!manifest || !module) throw new Error('请读取工具清单并选择一个模块');
    if (file.size !== module.size) throw new Error('ZIP 文件大小与选定工具模块声明不一致');
    const sha256 = await digestLocalFile(file, signal);
    if (sha256 !== module.sha256) throw new Error('ZIP 文件 SHA-256 与选定工具模块声明不一致');
    return {
      kind,
      file,
      manifest,
      module,
      sha256,
      target: `工具模块 ${module.id}`,
      summary: `版本 ${module.version}；大小与 SHA-256 一致。保留清单中的来源 URL，但导入不下载或执行工具。`,
    };
  }
  const configuration = parseLocalConfiguration(await readImportJson(file, signal));
  if (configuration.kind === 'settings') {
    const snapshot = await ports.settings.list(
      { scope: configuration.scope, owner_id: configuration.owner_id },
      signal,
    );
    signal.throwIfAborted();
    return {
      kind,
      file,
      configuration,
      revision: snapshot.data.revision,
      target: `${configuration.scope === 'user' ? '用户' : '工作区'} ${configuration.owner_id}`,
      summary: `合并配置区：${Object.keys(configuration.sections).join('、')}；已有同名配置区将更新。`,
    };
  }
  const installed = await ports.serverPlugins.refresh(signal);
  signal.throwIfAborted();
  if (!installed.data.some((plugin) => plugin.id === configuration.plugin_id))
    throw new Error('目标服务器插件尚未安装');
  const snapshot = await ports.configurations.get(
    { kind: 'server', id: configuration.plugin_id },
    signal,
  );
  signal.throwIfAborted();
  if (!snapshot.definition) throw new Error('目标服务器插件没有声明配置能力');
  if (!snapshot.compatible) throw new Error('目标服务器插件当前配置与声明不兼容，请先在配置页修复');
  if (
    readonlyIssues(
      snapshot.definition.schema,
      snapshot.values,
      mergeConfigurationPreview(snapshot.values, configuration.values),
    ).length
  )
    throw new Error('导入值包含只读字段变更');
  return {
    kind,
    file,
    configuration,
    revision: snapshot.revision,
    target: `服务器插件 ${configuration.plugin_id}`,
    summary: `合并配置字段：${Object.keys(configuration.values).join('、') || '无'}；保存后按插件策略生效，需要重载时请显式应用。`,
  };
}

export async function submitLocalImport(
  ports: LocalImportPorts,
  preview: LocalImportPreview,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  if (preview.kind === 'plugin') {
    const result = await ports.packages.upload(
      preview.plugin.kind,
      preview.file,
      preview.mediaType,
      signal,
      preview.plugin,
    );
    signal.throwIfAborted();
    return `已安装插件 ${result.data.id} ${result.data.version}，尚未自动启用。`;
  }
  if (preview.kind === 'tool') {
    const artifact = await ports.artifacts.upload(preview.file.name, preview.file, signal);
    signal.throwIfAborted();
    if (
      artifact.data.sha256.toLowerCase() !== preview.sha256 ||
      artifact.data.size !== preview.file.size
    )
      throw new Error('服务器产物摘要或大小不一致，已停止工具导入');
    const result = await ports.tools.importLocal(
      {
        archive_artifact_id: artifact.data.id,
        module_id: preview.module.id,
        manifest: preview.manifest.value,
      },
      signal,
    );
    signal.throwIfAborted();
    if (
      result.data.version !== preview.module.version ||
      result.data.sha256.toLowerCase() !== preview.sha256
    )
      throw new ApiError(
        'protocol',
        'local_tool_result_mismatch',
        '工具导入结果与预览版本或摘要不一致，请刷新实际状态',
        null,
        result.logId,
      );
    return result.data.changed
      ? `已导入工具 ${result.data.module_id} ${result.data.version}，未执行工具。`
      : `工具 ${result.data.module_id} ${result.data.version} 已是相同内容。`;
  }
  const config = preview.configuration;
  if (config.kind === 'settings') {
    const result = await ports.settings.import(
      {
        scope: config.scope,
        owner_id: config.owner_id,
        sections: config.sections,
        expected_revision: preview.revision,
      },
      signal,
    );
    signal.throwIfAborted();
    return `配置已导入，当前修订 ${result.data.revision}。`;
  }
  const result = await ports.configurations.save(
    { kind: 'server', id: config.plugin_id },
    preview.revision,
    config.values,
    signal,
  );
  signal.throwIfAborted();
  if (!result.compatible || result.fieldErrors.length)
    throw new Error('配置校验未通过，原配置未改变');
  return result.pendingReload
    ? `插件配置已保存，修订 ${result.revision}；请在插件配置中显式应用。`
    : `插件配置已保存，修订 ${result.revision}，后续调用生效。`;
}
