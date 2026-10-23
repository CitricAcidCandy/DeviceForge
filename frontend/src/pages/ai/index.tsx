import { useState } from 'react';
import type { ProductServices } from '../../app/product/services.ts';
import { AiProviderPanel } from './components/AiProviderPanel/index.tsx';

/**
 * AI 助手页：只负责 SDK / CLI 两个提供者的切换，
 * 具体界面与业务状态由各自的 AiProviderPanel 持有。
 */
export function AiPage({ services }: { services: ProductServices }) {
  const [provider, setProvider] = useState<'sdk' | 'cli'>('sdk');
  return (
    <section className="flex min-h-0 flex-1 flex-col" data-product-page="ai">
      <div hidden={provider !== 'sdk'} className="flex min-h-0 flex-1 flex-col">
        <AiProviderPanel services={services} provider="sdk" onProviderChange={setProvider} />
      </div>
      <div hidden={provider !== 'cli'} className="flex min-h-0 flex-1 flex-col">
        <AiProviderPanel services={services} provider="cli" onProviderChange={setProvider} />
      </div>
    </section>
  );
}
