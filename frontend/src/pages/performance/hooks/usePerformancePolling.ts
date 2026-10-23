import { useEffect } from 'react';
import type { Performance } from '../../../features/performance/index.ts';

// 页面只追读已选会话；不创建、恢复或停止服务器端采集。
export function usePerformancePolling(
  performance: Performance,
  selectedId: string | null,
  available: boolean,
) {
  useEffect(() => {
    if (!selectedId || !available) return;
    const id = selectedId;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const current = () =>
      !controller.signal.aborted && performance.snapshot().selection === id;
    const schedule = (delay: number) => {
      if (current()) timer = setTimeout(() => void poll(), delay);
    };
    async function poll() {
      if (!current()) return;
      const snapshot = performance.snapshot();
      // 不用自动读取消除控制失败的待核对状态，重查仍由用户明确触发。
      if (snapshot.pending || snapshot.needsReconcile) {
        schedule(1000);
        return;
      }
      try {
        const result = await performance.samples(
          id,
          { after: snapshot.nextAfter, limit: 100 },
          controller.signal,
        );
        if (!current()) return;
        failures = 0;
        const page = result.data;
        // 终态仍可能有多页尾部数据；只有游标前进才立即继续，避免空页忙等。
        if (page.next_after < page.session.samples)
          schedule(page.next_after > snapshot.nextAfter ? 0 : 1000);
        else if (page.session.state === 'running' || page.session.state === 'paused')
          schedule(1000);
      } catch {
        // 错误与日志 ID 保留在性能模型中，读取失败退避，不反复弹成功或错误通知。
        failures = Math.min(failures + 1, 4);
        schedule(Math.min(1000 * 2 ** failures, 10000));
      }
    }
    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [performance, selectedId, available]);
}
