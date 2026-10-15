import type { ProductServices } from './services.ts';
import type { ProductRoute } from './routes.ts';
import { PackagesPage } from '../../pages/packages/index.tsx';
import { FilesPage } from '../../pages/files/index.tsx';
import { MediaPage } from '../../pages/media/index.tsx';
import { PerformancePage } from '../../pages/performance/index.tsx';
import { FridaPage } from '../../pages/frida/index.tsx';
import { AutomationPage } from '../../pages/automation/index.tsx';
import { TerminalPage } from '../../pages/terminal/index.tsx';
import { AiPage } from '../../pages/ai/index.tsx';
import { AnalysisPage } from '../../pages/analysis/index.tsx';
import { ToolsPage } from '../../pages/tools/index.tsx';

export function AdvancedPage({
  route,
  services,
  active,
}: {
  route: ProductRoute;
  services: ProductServices;
  active: boolean;
}) {
  switch (route) {
    case 'packages':
      return <PackagesPage services={services} />;
    case 'files':
      return <FilesPage services={services} />;
    case 'media':
      return <MediaPage services={services} active={active} />;
    case 'performance':
      return <PerformancePage services={services} />;
    case 'frida':
      return <FridaPage services={services} />;
    case 'automation':
      return <AutomationPage services={services} />;
    case 'terminal':
      return <TerminalPage services={services} />;
    case 'ai':
      return <AiPage services={services} />;
    case 'analysis':
      return <AnalysisPage services={services} />;
    case 'tools':
      return <ToolsPage services={services} />;
    default:
      return null;
  }
}
