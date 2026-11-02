import type { Artifact, HostResult, Operation } from '@deviceforge/plugin-sdk';
export { ApiError } from '@deviceforge/plugin-sdk';
export type ApiResult<T> = HostResult<T>;
export type OperationDto = Operation;
export type ArtifactDto = Artifact;
export declare function apiError(error: unknown): unknown;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function isOperation(value: unknown): value is Operation;
/** 注入方忽略取消时仍结束等待；不把等待取消宣称为服务器任务已取消。 */
export declare function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T>;
