import type { ApiResult, PluginRecoveryView } from '../../../services/api/index.ts';

export interface RecoveryTarget {
  readonly key: string;
  readonly deviceId?: string;
}

export interface PluginRecoverySnapshot {
  readonly target: RecoveryTarget | null;
  readonly phase: 'idle' | 'reading' | 'recovering';
  readonly result: ApiResult<PluginRecoveryView> | null;
  readonly error: unknown;
  readonly unavailable: boolean;
  readonly cancelled: boolean;
  readonly reportTarget: string | null;
}
