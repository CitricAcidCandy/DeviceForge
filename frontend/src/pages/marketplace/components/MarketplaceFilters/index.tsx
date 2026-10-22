import { X } from 'lucide-react';
import { Button, SelectField } from '../../../../components/index.ts';
import type { MarketplaceQuery } from '../../../../features/marketplace/index.ts';
import { mcpLabels, restartLabels } from '../../presentation.ts';

const all = { value: 'all', label: '不限' };

// 类型与分类由左侧导航和分类标签承担，这里只留兼容性与能力筛选。
export function MarketplaceAdvancedFilters({
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
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SelectField
          label="MCP"
          value={query.supports_mcp ?? 'all'}
          options={[all, ...Object.entries(mcpLabels).map(([value, label]) => ({ value, label }))]}
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
          onValueChange={(value) => set('supports_agent', value === 'all' ? undefined : value === 'true')}
        />
        <SelectField
          label="应用方式"
          value={query.restart_policy ?? 'all'}
          options={[all, ...Object.entries(restartLabels).map(([value, label]) => ({ value, label }))]}
          onValueChange={(value) => set('restart_policy', value)}
        />
        <SelectField
          label="平台"
          value={query.platform ?? 'all'}
          options={[all, ...['windows', 'linux', 'macos', 'android'].map((value) => ({ value, label: value }))]}
          onValueChange={(value) => set('platform', value)}
        />
        <SelectField
          label="架构"
          value={query.architecture ?? 'all'}
          options={[all, ...['x64', 'arm64', 'x86', 'arm'].map((value) => ({ value, label: value }))]}
          onValueChange={(value) => set('architecture', value)}
        />
      </div>
      <Button variant="ghost" size="sm" className="self-start" onClick={() => onChange({ limit: 24 })}>
        <X />
        清空筛选
      </Button>
    </div>
  );
}
