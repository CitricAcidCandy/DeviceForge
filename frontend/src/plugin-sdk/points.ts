import type { Dispose, JsonValue } from './models.ts';

/** 扩展点使用精确版本；版本不是范围，也不参与隐式升级。 */
export interface PointRef {
  readonly id: string;
  readonly version: string;
}
export type PointMode = 'append' | 'replace';
export interface PointDefinition extends PointRef {
  readonly title: string;
  readonly inputSchema?: JsonValue;
  readonly modes?: readonly PointMode[];
}
export interface PointContribution {
  readonly id: string;
  readonly point: PointRef;
  readonly order?: number;
  readonly mode?: PointMode;
  readonly data: JsonValue;
  /** 仅在本浏览器使用的组件、函数或对象，不进入可序列化目录。 */
  readonly payload?: unknown;
}
export interface PointProvider {
  readonly pluginId: string;
  readonly generation: number;
}
export interface PointDefinitionInfo extends PointRef {
  readonly title: string;
  readonly inputSchema: JsonValue;
  readonly modes: readonly PointMode[];
  readonly provider: PointProvider;
}
export type PointContributionState = 'waiting' | 'version_mismatch' | 'invalid' | 'active';
export interface PointContributionInfo {
  readonly id: string;
  readonly point: PointRef;
  readonly order: number;
  readonly mode: PointMode;
  readonly data: JsonValue;
  readonly provider: PointProvider;
  readonly state: PointContributionState;
  readonly reason: 'point_missing' | 'version_mismatch' | 'mode_not_allowed' | 'data_invalid' | null;
  readonly selected: boolean;
}
export interface LocalPointContribution extends PointContributionInfo {
  readonly payload?: unknown;
}
export interface PointCatalog {
  readonly definitions: readonly PointDefinitionInfo[];
  readonly contributions: readonly PointContributionInfo[];
}
export interface PointContributionHandle {
  /** 标识不可更改；新数据会重新校验，不符合契约时保留为可诊断的无效贡献。 */
  update(value: PointContribution): void;
  readonly dispose: Dispose;
}
export interface PointAccess {
  define(definition: PointDefinition): Dispose;
  contribute(contribution: PointContribution): PointContributionHandle;
  /** 稳定快照，不包含本地 payload，适合调试目录与跨端传输。 */
  catalog(): PointCatalog;
  /** 包含等待和无效项；渲染方只消费 active 项，替换项还须经显式选择。 */
  list(point: PointRef): readonly LocalPointContribution[];
  selected(point: PointRef): LocalPointContribution | null;
  /** 读取显式选择的标识，即使提供者暂不可用；旧宿主可不提供，与当前可用项selected分开。 */
  readonly selection?: (point: PointRef) => string | null;
  select(point: PointRef, contributionId: string | null): void;
  subscribe(listener: () => void): Dispose;
}
