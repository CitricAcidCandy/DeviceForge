import type { Dispose, HostResult, JsonValue } from './models.ts';
import type { ServiceRef } from './services.ts';

/** 数据源和服务一样使用精确版本，不隐式升级。 */
export interface DataSourceRef {
  readonly id: string;
  readonly version: string;
}
export interface DataSourceDefinition extends DataSourceRef {
  readonly title: string;
  readonly readOnly: boolean;
  readonly applyPolicy: 'immediate' | 'reload';
  /** 省略表示提供者未声明，消费方不能据此推断是否持久保存。 */
  readonly persistence?: 'memory' | 'persistent';
  readonly schema?: JsonValue;
  readonly read: ServiceRef;
  readonly write?: ServiceRef;
}
export interface DataSnapshot {
  readonly value: JsonValue;
  readonly revision: string;
}
export interface DataWrite {
  readonly value: JsonValue;
  readonly expectedRevision: string;
}
export interface DataSourceInfo extends DataSourceDefinition {
  readonly provider: { readonly pluginId: string; readonly generation: number };
}
/** 服务读取以 {} 为输入，变更以 {value,expectedRevision} 为输入，均返回数据与新修订。 */
export interface DataAccess {
  register(definition: DataSourceDefinition): Dispose;
  /** 稳定的可序列化目录，不暴露处理函数或私有状态。 */
  catalog(): readonly DataSourceInfo[];
  read(ref: DataSourceRef, signal: AbortSignal): Promise<HostResult<DataSnapshot>>;
  write(ref: DataSourceRef, input: DataWrite, signal: AbortSignal): Promise<HostResult<DataSnapshot>>;
  /** 通知目录变更；业务实时变化仍通过提供者公开事件或服务观察。 */
  subscribe(listener: () => void): Dispose;
}
