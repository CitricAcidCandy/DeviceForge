import type { ApiError, OperationDto } from '../../../services/api/index.ts';
import type { AutomationCatalogSnapshot as ModelCatalogSnapshot } from '@deviceforge/automation/model';

// 领域类型只在独立插件维护；宿主操作目录仍沿真实 HTTP DTO，不冒充公开 SDK 目录。
export type {
  AutomationAction,
  AutomationSequence,
  RepeatedClick,
  AutomationResult,
  AutomationOperation,
  DesktopAutomationOperation,
  AutomationOperationReader,
  AutomationOptions,
} from '@deviceforge/automation/model';

export interface AutomationCatalogSnapshot extends Omit<ModelCatalogSnapshot, 'operations' | 'error'> {
  readonly operations: readonly Readonly<OperationDto>[];
  readonly error: ApiError | null;
}
