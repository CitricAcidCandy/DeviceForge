import type { JsonData } from '../../shared/jobs/index.ts';

export interface AiSingleInput { readonly project_id: string; readonly prompt: string }
export interface AiTurnInput extends AiSingleInput { readonly thread_id?: string }
export interface AiRuntimeStatus { readonly configured: true; readonly projects: readonly string[]; readonly provider: 'codex_cli' }
export interface AiTurnResult { readonly text: string; readonly thread_id: string; readonly events: readonly JsonData[]; readonly project_id: string }
export interface AiSessionInput { readonly project_id: string; readonly thread_id: string }
export interface AiSessionResult extends AiSessionInput { readonly turns: string; readonly closed: boolean; readonly uncertain: boolean }
