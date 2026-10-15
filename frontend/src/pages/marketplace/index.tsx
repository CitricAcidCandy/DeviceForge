import { useEffect, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { Button } from '../../components/Button/index.tsx';
import { Input } from '../../components/Input/index.tsx';
import { PageTitle } from '../../components/index.ts';
import type { ProductServices } from '../../app/product/services.ts';
import type {
  MarketplaceEntry,
  MarketplaceKind,
  MarketplaceMcp,
  MarketplaceRestart,
  MarketplaceSnapshot,
} from '../../features/marketplace/index.ts';
import './workspace.css';

const kinds: readonly [MarketplaceKind | '', string][] = [
  ['', '全部类型'],
  ['plugin', '插件'],
  ['tool', '工具'],
  ['config', '配置'],
  ['distribution', '分发包'],
];
const mcpValues: readonly [MarketplaceMcp | '', string][] = [
  ['', '全部 MCP'],
  ['none', '不支持'],
  ['client', '客户端'],
  ['server', '服务端'],
  ['both', '双向'],
];
const restartValues: readonly [MarketplaceRestart | '', string][] = [
  ['', '全部重启策略'],
  ['none', '无需重启'],
  ['browser_refresh', '刷新浏览器'],
  ['plugin_reload', '重载插件'],
  ['service_restart', '重启服务'],
  ['device_restart', '重启设备'],
];

export function MarketplacePage({ services }: { services: ProductServices }) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<MarketplaceKind | ''>('');
  const [mcp, setMcp] = useState<MarketplaceMcp | ''>('');
  const [restart, setRestart] = useState<MarketplaceRestart | ''>('');
  const [snapshot, setSnapshot] = useState<MarketplaceSnapshot | null>(null);
  const [marketplaceUrl, setMarketplaceUrl] = useState(() => services.marketplace.currentUrl());
  const [selected, setSelected] = useState<MarketplaceEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function refresh(signal?: AbortSignal) {
    setBusy(true);
    setError(null);
    try {
      const filters = {
        applies_to: 'deviceforge',
        limit: 100,
        ...(query.trim() ? { q: query.trim() } : {}),
        ...(kind ? { kind } : {}),
        ...(mcp ? { supports_mcp: mcp } : {}),
        ...(restart ? { restart_policy: restart } : {}),
      };
      const result = await services.marketplace.search(
        filters,
        signal ?? new AbortController().signal,
      );
      if (!signal?.aborted) setSnapshot(result);
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : '市场请求失败');
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [query, kind, mcp, restart]);
  useEffect(() => {
    const changed = () => {
      setMarketplaceUrl(services.marketplace.currentUrl());
      setSnapshot(null);
      void refresh();
    };
    window.addEventListener('deviceforge-marketplace-change', changed);
    return () => window.removeEventListener('deviceforge-marketplace-change', changed);
  }, [services]);
  return (
    <div className="product-page marketplace-page">
      <PageTitle eyebrow="WORKSHOP / MARKETPLACE" title="资源市场" />
      <section className="settings-group marketplace-toolbar">
        <div className="inline-action">
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、简介、关键词或作者" aria-label="搜索市场" />
          <Button variant="outline" disabled={busy} onClick={() => void refresh()}><Search />搜索</Button>
          <Button variant="outline" disabled={busy} onClick={() => void refresh()}><RefreshCw />刷新</Button>
        </div>
        <div className="form-row">
          <SelectField label="类型" value={kind} options={kinds} onChange={(value) => setKind(value as MarketplaceKind | '')} />
          <SelectField label="MCP" value={mcp} options={mcpValues} onChange={(value) => setMcp(value as MarketplaceMcp | '')} />
          <SelectField label="应用后" value={restart} options={restartValues} onChange={(value) => setRestart(value as MarketplaceRestart | '')} />
        </div>
        <p className="muted">来源：<span className="mono">{marketplaceUrl}</span> · 资源类条目默认隐藏</p>
      </section>
      {error && <p className="capability-notice">{error}</p>}
      <div className="marketplace-grid">
        <section className="settings-group">
          <h2>目录 {snapshot ? `· ${snapshot.total}` : ''}</h2>
          {busy && <p className="muted">正在读取市场目录…</p>}
          {!busy && snapshot?.entries.length === 0 && <p className="muted">没有符合条件的条目。</p>}
          <div className="marketplace-list">
            {snapshot?.entries.map((entry) => (
              <button type="button" className="marketplace-item" key={`${entry.source}:${entry.id}:${entry.version}`} onClick={() => setSelected(entry)}>
                <span className="marketplace-item-heading"><strong>{entry.name}</strong><span className="mono">{entry.version}</span></span>
                <span className="muted">{entry.kind} · {entry.categories.join('、') || '未分类'}</span>
                <span>{entry.summary}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="settings-group marketplace-detail">
          <h2>条目详情</h2>
          {selected ? <EntryDetail entry={selected} /> : <p className="muted">选择一个条目查看来源、兼容性、权限和重启要求。</p>}
        </section>
      </div>
    </div>
  );
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: readonly (readonly [string, string])[]; onChange(value: string): void }) {
  return <label className="form-field"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([option, text]) => <option value={option} key={option || 'all'}>{text}</option>)}</select></label>;
}

function EntryDetail({ entry }: { entry: MarketplaceEntry }) {
  return <div className="marketplace-detail-body">
    <p>{entry.description || entry.summary}</p>
    <dl>
      <dt>来源</dt><dd className="mono">{entry.sourceName} · {entry.source}</dd>
      <dt>适用项目</dt><dd>{entry.applies_to.join('、')}</dd>
      <dt>平台</dt><dd>{entry.platforms.join('、') || '未限制'} / {entry.architectures.join('、') || '未限制'}</dd>
      <dt>MCP / Agent</dt><dd>{entry.supports_mcp} / {entry.supports_agent ? '支持内置 Agent' : '不支持'}</dd>
      <dt>应用后</dt><dd>{entry.restart_policy}</dd>
      <dt>作者 / 许可证</dt><dd>{entry.author || '未填写'} / {entry.license || '未填写'}</dd>
    </dl>
    {entry.kind === 'resource' && <p className="muted">这是内部资源，仅供插件引用。</p>}
  </div>;
}

