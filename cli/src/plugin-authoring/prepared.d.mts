/** 只描述CLI准备/提交协议，不引入宿主运行或业务类型。 */
export interface PreparedPluginReport {
  readonly id: string;
  readonly version: string;
  readonly platform: string;
  readonly revision: string;
  readonly components: number;
  readonly resources: number;
  readonly archive: string;
  readonly size: number;
  readonly sha256: string;
}
export interface PreparedPluginReceipt {
  readonly state: 'prepared';
  readonly receipt: string;
  readonly staging: string;
  readonly target: string;
  readonly id: string;
  readonly revision: string;
}
export function preparePluginReceipt(staging: string, target: string, report: PreparedPluginReport,
  options?: { readonly signal?: AbortSignal }): Promise<PreparedPluginReceipt>;
export function finalizePreparedPlugin(receiptFile: string,
  options?: { readonly signal?: AbortSignal }): Promise<PreparedPluginReport & { readonly state: 'completed' }>;
