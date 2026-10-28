import type { ProductServices } from '../../app/product/services.ts';
import { SettingsWorkspace } from './SettingsWorkspace.tsx';

export function SettingsPage({ services }: { services: ProductServices }) {
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col bg-card px-4 pt-6 pb-7 text-[14px] text-body sm:px-7" data-settings-page>
      <SettingsWorkspace services={services} />
    </div>
  );
}
