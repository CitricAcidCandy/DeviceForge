import { ApiError } from '../../../services/api/index.ts';
import {
  decodeEmptyArtifactResult,
  invalidBusinessResult,
  jsonObject,
  onlyKeys,
  requireJson,
} from '../../../shared/jobs/index.ts';
import type { ToolInstallation, ToolLocalImport } from '../types/index.ts';
import { requireModuleId, toolVersion } from './rules.ts';

export function localImportInput(input: ToolLocalImport) {
  requireModuleId(input.module_id);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      input.archive_artifact_id,
    ) ||
    !jsonObject(input.manifest)
  )
    throw new ApiError(
      'protocol',
      'invalid_local_tool_import',
      '本地工具导入需要有效产物 ID 与工具清单对象',
    );
  return requireJson(input);
}

// 本地导入没有远端清单来源，不消费远端安装的来源解码器。
export function decodeLocalInstallation(
  raw: unknown,
  logId: string | null,
  moduleId: string,
): ToolInstallation {
  const value = decodeEmptyArtifactResult(raw, '本地工具导入', logId);
  if (
    !jsonObject(value) ||
    !onlyKeys(value, ['module_id', 'version', 'changed', 'sha256']) ||
    value.module_id !== moduleId ||
    !toolVersion(value.version) ||
    typeof value.changed !== 'boolean' ||
    typeof value.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(value.sha256)
  )
    throw invalidBusinessResult('本地工具导入', logId);
  return {
    module_id: moduleId,
    version: value.version,
    changed: value.changed,
    sha256: value.sha256,
  };
}
