import type { Dispose } from './models.ts';
import type { PluginTransport } from './transport.ts';

/** 只在已登记资源释放期间有效，不承接新的业务执行或长期订阅。 */
export interface CleanupContext {
  readonly signal: AbortSignal;
  /** 本次清理的绝对截止时间，单位为 Unix 毫秒。 */
  readonly deadline: number;
  readonly transport?: Pick<PluginTransport, 'request'>;
}
export type CleanupCallback = (context: CleanupContext) => void | Promise<void>;
/** 手动释放与所属作用域撤销共享一次回调，不自动重放失败或未知操作。 */
export type CleanupRegistration = (cleanup: CleanupCallback) => Dispose;
