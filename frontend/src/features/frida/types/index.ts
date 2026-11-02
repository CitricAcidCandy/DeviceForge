import type { ApiError, OperationDto } from '../../../services/api/index.ts';
import type { FridaCatalogSnapshot as ModelCatalogSnapshot } from '@deviceforge/frida/model';

// 领域类型只在独立插件维护；宿主操作目录仍沿真实 HTTP DTO，不冒充公开 SDK 目录。
export type {
  FridaAction,
  FridaMode,
  PermissionModule,
  FridaScriptInput,
  PermissionHook,
  FridaPermissionsInput,
  FridaDeployment,
  FridaStatus,
  FridaServerRun,
  FridaProcesses,
  FridaScriptResult,
  FridaOperationReader,
  FridaOptions,
} from '@deviceforge/frida/model';

export interface FridaCatalogSnapshot extends Omit<ModelCatalogSnapshot, 'operations' | 'error'> {
  readonly operations: readonly Readonly<OperationDto>[];
  readonly error: ApiError | null;
}
