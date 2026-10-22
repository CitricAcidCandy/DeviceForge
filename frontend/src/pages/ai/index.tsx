import { useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/Select/index.tsx';
import { PageTitle } from '../../components/index.ts';
import type { ProductServices } from '../../app/product/services.ts';
import { AiProviderPanel } from './components/AiProviderPanel/index.tsx';
import './workspace.css';

export function AiPage({ services }: { services: ProductServices }) {
  const [provider, setProvider] = useState<'sdk' | 'cli'>('sdk');
  return (
    <section
      className="product-page ai-page flex min-h-[560px] flex-1 flex-col gap-3"
      data-product-page="ai"
    >
      <PageTitle title="AI 助手">
        <Select
          value={provider}
          onValueChange={(value) => {
            if (value === 'sdk' || value === 'cli') setProvider(value);
          }}
        >
          <SelectTrigger aria-label="AI 提供者">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="sdk">Codex SDK</SelectItem>
            <SelectItem value="cli">Codex CLI</SelectItem>
          </SelectContent>
        </Select>
      </PageTitle>
      <div hidden={provider !== 'sdk'} className="flex min-h-0 flex-1 flex-col">
        <AiProviderPanel services={services} provider="sdk" />
      </div>
      <div hidden={provider !== 'cli'} className="flex min-h-0 flex-1 flex-col">
        <AiProviderPanel services={services} provider="cli" />
      </div>
    </section>
  );
}
