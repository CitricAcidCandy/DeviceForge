import { Search, SlidersHorizontal, X } from 'lucide-react';
import { Button, Input, SelectField } from '../../../../components/index.ts';
import { marketplaceCategories } from '../../../../features/marketplace/index.ts';
import type { MarketplaceQuery } from '../../../../features/marketplace/index.ts';
import { categoryLabels, kindLabels, mcpLabels, restartLabels } from '../../presentation.ts';

export function MarketplaceFilters({
  query,
  onChange,
}: {
  query: MarketplaceQuery;
  onChange: (query: MarketplaceQuery) => void;
}) {
  const set = (key: keyof MarketplaceQuery, value: string | boolean | undefined) => {
    const next = { ...query, offset: 0 };
    delete next[key];
    if (value !== undefined && value !== 'all' && value !== '')
      Object.assign(next, { [key]: value });
    if (key === 'kind') delete next.category;
    onChange(next);
  };
  const all = { value: 'all', label: '不限' };
  const categories = query.kind
    ? marketplaceCategories[query.kind]
    : [...new Set(Object.values(marketplaceCategories).flat())];
  return (
    <section className="marketplace-filters" aria-label="市场筛选">
      <div className="marketplace-search">
        <Search aria-hidden="true" />
        <Input
          aria-label="搜索市场"
          placeholder="搜索名称、用途、关键词或作者…"
          value={query.q ?? ''}
          onChange={(event) => set('q', event.target.value)}
        />
      </div>
      <div className="marketplace-filter-primary">
        <SelectField
          label="条目类型"
          value={query.kind ?? 'all'}
          options={[
            all,
            ...Object.entries(kindLabels)
              .filter(([key]) => key !== 'resource')
              .map(([value, label]) => ({ value, label })),
          ]}
          onValueChange={(value) => set('kind', value)}
        />
        <SelectField
          label="分类"
          value={query.category ?? 'all'}
          options={[
            all,
            ...categories.map((value) => ({ value, label: categoryLabels[value] ?? value })),
          ]}
          onValueChange={(value) => set('category', value)}
        />
        <SelectField
          label="适用项目"
          value={query.applies_to ?? 'all'}
          options={[
            all,
            { value: 'deviceforge', label: 'DeviceForge' },
            { value: 'universal', label: '通用' },
          ]}
          onValueChange={(value) => set('applies_to', value)}
        />
        <Button variant="ghost" onClick={() => onChange({ limit: 24 })}>
          <X />
          重置
        </Button>
      </div>
      <details className="marketplace-filter-advanced">
        <summary>
          <SlidersHorizontal />
          兼容性与能力筛选
        </summary>
        <div className="marketplace-filter-options">
          <SelectField
            label="MCP"
            value={query.supports_mcp ?? 'all'}
            options={[
              all,
              ...Object.entries(mcpLabels).map(([value, label]) => ({ value, label })),
            ]}
            onValueChange={(value) => set('supports_mcp', value)}
          />
          <SelectField
            label="Agent"
            value={query.supports_agent === undefined ? 'all' : String(query.supports_agent)}
            options={[
              all,
              { value: 'true', label: '支持调用' },
              { value: 'false', label: '不支持' },
            ]}
            onValueChange={(value) =>
              set('supports_agent', value === 'all' ? undefined : value === 'true')
            }
          />
          <SelectField
            label="应用方式"
            value={query.restart_policy ?? 'all'}
            options={[
              all,
              ...Object.entries(restartLabels).map(([value, label]) => ({ value, label })),
            ]}
            onValueChange={(value) => set('restart_policy', value)}
          />
          <SelectField
            label="平台"
            value={query.platform ?? 'all'}
            options={[
              all,
              ...['windows', 'linux', 'macos', 'android'].map((value) => ({ value, label: value })),
            ]}
            onValueChange={(value) => set('platform', value)}
          />
          <SelectField
            label="架构"
            value={query.architecture ?? 'all'}
            options={[
              all,
              ...['x64', 'arm64', 'x86', 'arm'].map((value) => ({ value, label: value })),
            ]}
            onValueChange={(value) => set('architecture', value)}
          />
        </div>
      </details>
    </section>
  );
}
