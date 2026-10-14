import { HostError } from '../../../plugin-sdk/index.ts';
import type { PerformancePage, PerformanceSession, PerformanceSnapshot } from '../types/index.ts';

function sameIdentity(left: PerformanceSession, right: PerformanceSession): boolean {
  const leftSource = left.source;
  const rightSource = right.source;
  const sameSource = () => {
    if (leftSource == null || rightSource == null) return leftSource == null && rightSource == null;
    if (
      leftSource.plugin_id !== rightSource.plugin_id ||
      leftSource.generation !== rightSource.generation ||
      leftSource.operation !== rightSource.operation
    )
      return false;
    const leftDevice = leftSource.device;
    const rightDevice = rightSource.device;
    if (leftDevice == null || rightDevice == null) return leftDevice == null && rightDevice == null;
    return (
      leftDevice.provider_id === rightDevice.provider_id &&
      leftDevice.generation === rightDevice.generation &&
      leftDevice.local_id === rightDevice.local_id
    );
  };
  return (
    left.request.target.device_id === right.request.target.device_id &&
    left.request.target.package === right.request.target.package &&
    left.request.interval_ms === right.request.interval_ms &&
    left.request.duration_secs === right.request.duration_secs &&
    sameSource() &&
    left.started_at === right.started_at
  );
}
export function createPerformanceState() {
  let generation = 0;
  let closed = false;
  let active = new AbortController();
  let snapshot: PerformanceSnapshot = {
    selection: null,
    session: null,
    readings: [],
    nextAfter: 0,
    pending: false,
    needsReconcile: false,
    liveAvailable: true,
    error: null,
  };
  const listeners = new Set<(value: PerformanceSnapshot) => void>();
  function publish(patch: Partial<PerformanceSnapshot>) {
    if (closed) return;
    snapshot = { ...snapshot, ...patch };
    const published = snapshot;
    for (const listener of [...listeners]) {
      if (closed || snapshot !== published) break;
      if (listeners.has(listener))
        try {
          listener(published);
        } catch {
          /* 一个消费者失败不影响其他订阅。 */
        }
    }
  }
  function revoke() {
    ++generation;
    active.abort();
    active = new AbortController();
  }
  function accept(session: PerformanceSession): boolean {
    if (snapshot.selection !== session.id) return false;
    const previous = snapshot.session;
    if (previous) {
      if (!sameIdentity(previous, session))
        throw new HostError(
          'protocol',
          'changed_performance_identity',
          '性能会话的不可变归属发生变化',
        );
      if (session.revision < previous.revision || session.samples < previous.samples) return false;
      if (
        previous.state !== 'running' &&
        previous.state !== 'paused' &&
        session.state !== previous.state
      )
        throw new HostError('protocol', 'changed_performance_terminal', '性能会话终态发生变化');
      if (session.revision === previous.revision && session.state !== previous.state)
        throw new HostError(
          'protocol',
          'changed_performance_revision',
          '同一会话修订返回了冲突状态',
        );
    }
    publish({ session });
    return true;
  }
  return {
    snapshot: () => snapshot,
    select(id: string) {
      if (closed) throw new HostError('cancelled', 'cancelled', '性能消费者已关闭');
      revoke();
      publish({
        selection: id,
        session: null,
        readings: [],
        nextAfter: 0,
        pending: false,
        needsReconcile: false,
        error: null,
      });
    },
    begin() {
      if (closed) throw new HostError('cancelled', 'cancelled', '性能消费者已关闭');
      revoke();
      const token = { generation, signal: active.signal };
      publish({ pending: true, error: null });
      return token;
    },
    current(token: number) {
      return !closed && token === generation && !active.signal.aborted;
    },
    accept,
    acceptPage(page: PerformancePage, after: number) {
      const admitted = generation;
      if (!accept(page.session)) return false;
      if (closed || generation !== admitted || snapshot.selection !== page.session.id) return false;
      if (page.next_after < after || page.readings.some((reading) => reading.sequence <= after))
        throw new HostError('protocol', 'invalid_performance_cursor', '性能样本页游标没有匹配请求');
      const readings = new Map(snapshot.readings.map((reading) => [reading.sequence, reading]));
      for (const reading of page.readings)
        if (!readings.has(reading.sequence)) readings.set(reading.sequence, reading);
      publish({
        readings: [...readings.values()].sort((left, right) => left.sequence - right.sequence),
        nextAfter: Math.max(snapshot.nextAfter, page.next_after),
      });
      return true;
    },
    finish(token: number, error: unknown = null) {
      if (token === generation) publish({ pending: false, error });
    },
    uncertain(id: string, error: unknown) {
      if (snapshot.selection === id) publish({ needsReconcile: true, error });
    },
    reconciled(id: string) {
      if (snapshot.selection === id) publish({ needsReconcile: false });
    },
    invalidateLive() {
      revoke();
      publish({ pending: false, liveAvailable: false });
    },
    enableLive() {
      publish({ liveAvailable: true });
    },
    subscribe(listener: (value: PerformanceSnapshot) => void) {
      if (closed) throw new HostError('cancelled', 'cancelled', '性能消费者已关闭');
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (closed) return;
      closed = true;
      revoke();
      listeners.clear();
      snapshot = { ...snapshot, pending: false };
    },
  };
}
