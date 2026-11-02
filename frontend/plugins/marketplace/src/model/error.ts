import { HostError } from '@deviceforge/plugin-sdk';

/** 保留市场 HTTP 状态与日志字段，错误类型仍统一属于公开 HostError。 */
export class MarketplaceError extends HostError {
  constructor(
    kind: HostError['kind'], code: string, message: string,
    status: number | null = null, logId: string | null = null, retryAfter: string | null = null,
  ) {
    super(kind, code, message, logId, status, retryAfter);
    this.name = 'MarketplaceError';
  }
}
