import { HostError } from '../plugin-sdk/models.ts';
import type { Dispose } from '../plugin-sdk/models.ts';
import type { CleanupRegistration } from '../plugin-sdk/cleanup.ts';

interface CleanupProvider {
  readonly register: CleanupRegistration;
  readonly validate: () => void;
}
// 只记录包装函数的来源与撤销检查，不保存资源、不建立另一套清理队列。
const providers = new WeakMap<CleanupRegistration, CleanupProvider>();

export function scopedCleanupRegistration(
  upstream: CleanupRegistration | undefined, signal: AbortSignal, track: (dispose: Dispose) => Dispose,
): CleanupRegistration | undefined {
  if (!upstream) return undefined;
  const parent = providers.get(upstream);
  const register = parent?.register ?? upstream;
  const validate = () => {
    if (signal.aborted)
      throw new HostError('cancelled', 'cleanup_owner_revoked', '不能向已撤销的作用域登记资源');
    parent?.validate();
  };
  const access: CleanupRegistration = (callback) => {
    validate();
    return track(register(callback));
  };
  // 嵌套视图/功能只由最近的作用域认领错误，不能被祖先 track 提前吞掉。
  providers.set(access, { register, validate });
  return access;
}
