import { useEffect, useState } from 'react';
import type { MarketplaceController, MarketplaceEntry } from '../../features/marketplace/index.ts';

// 已安装目录不受发现页筛选和分页影响，按需读取市场元数据以提供配置与更新。
export function useInstalledMetadata(marketplace: MarketplaceController, active: boolean, refresh: number) {
  const [entries, setEntries] = useState<readonly MarketplaceEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const source = marketplace.currentUrl();
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setEntries([]); setError(null);
    void (async () => {
      const collected: MarketplaceEntry[] = [];
      let offset = 0;
      while (true) {
        const page = await marketplace.search({ kind: 'plugin', offset, limit: 100 }, controller.signal);
        controller.signal.throwIfAborted();
        collected.push(...page.entries);
        const next = page.offset + page.limit;
        if (next >= page.total || next <= offset) break;
        offset = next;
      }
      if (!controller.signal.aborted) setEntries(collected);
    })().catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '已安装条目元数据读取失败');
    });
    return () => controller.abort();
  }, [marketplace, active, source, refresh]);
  return { entries, error };
}
